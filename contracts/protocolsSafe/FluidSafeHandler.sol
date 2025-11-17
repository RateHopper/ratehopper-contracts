// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../interfaces/safe/ISafe.sol";
import "../Types.sol";
import {GPv2SafeERC20} from "../dependencies/GPv2SafeERC20.sol";
import {IPoolV3} from "../interfaces/aaveV3/IPoolV3.sol";
import {IERC20} from "../dependencies/IERC20.sol";
import {DataTypes} from "../interfaces/aaveV3/DataTypes.sol";
import "../interfaces/fluid/IFluidVault.sol";
import "../interfaces/fluid/IFluidVaultResolver.sol";
import "../interfaces/IProtocolHandler.sol";
import {Structs} from "../dependencies/fluid/structs.sol";
import "../protocols/BaseProtocolHandler.sol";
import "../ProtocolRegistry.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../interfaces/IWETH9.sol";

contract FluidSafeHandler is BaseProtocolHandler, ReentrancyGuard {
    using GPv2SafeERC20 for IERC20;

    // Note: The registry contract holds configuration data including the Fluid vault resolver address and WETH address
    // This design allows the resolver to be updated without redeploying handlers
    // and works correctly with delegatecall since registry is immutable

    constructor(address _UNISWAP_V3_FACTORY, address _REGISTRY_ADDRESS) BaseProtocolHandler(_UNISWAP_V3_FACTORY, _REGISTRY_ADDRESS) {
    }

    function getDebtAmount(
        address asset,
        address onBehalfOf,
        bytes calldata fromExtraData
    ) public view returns (uint256) {
        (address vaultAddress, uint256 nftId) = abi.decode(fromExtraData, (address, uint256));

        IFluidVaultResolver resolver = IFluidVaultResolver(registry.fluidVaultResolver());
        uint256 debtAmount;

        // If nftId is provided, use positionByNftId for more efficient lookup
        if (nftId > 0) {
            (Structs.UserPosition memory userPosition, ) = resolver.positionByNftId(nftId);
            debtAmount = userPosition.borrow;
        } else {
            // Fallback to positionsByUser if nftId is not provided
            (Structs.UserPosition[] memory userPositions_, Structs.VaultEntireData[] memory vaultsData_) = resolver
                .positionsByUser(onBehalfOf);

            bool vaultFound = false;
            for (uint256 i = 0; i < vaultsData_.length; i++) {
                if (vaultsData_[i].vault == vaultAddress) {
                    debtAmount = userPositions_[i].borrow;
                    vaultFound = true;
                    break;
                }
            }
            require(vaultFound, "Vault not found");
        }

        // Add tiny amount buffer to avoid repay amount slightly increasing and causing revert
        return (debtAmount * 10001) / 10000;
    }

    function switchIn(
        address fromAsset,
        address toAsset,
        uint256 amount,
        uint256 amountTotal,
        address onBehalfOf,
        CollateralAsset[] memory collateralAssets,
        bytes calldata fromExtraData,
        bytes calldata toExtraData
    ) external override onlyAuthorizedCaller nonReentrant {
        switchFrom(fromAsset, amount, onBehalfOf, collateralAssets, fromExtraData);
        switchTo(toAsset, amountTotal, onBehalfOf, collateralAssets, toExtraData);
    }

    function switchFrom(
        address fromAsset,
        uint256 amount,
        address onBehalfOf,
        CollateralAsset[] memory collateralAssets,
        bytes calldata extraData
    ) public override onlyAuthorizedCaller {
        require(registry.isWhitelisted(fromAsset), "From asset is not whitelisted");
        _validateCollateralAssets(collateralAssets);
        for (uint256 i = 0; i < collateralAssets.length; i++) {
            require(registry.isWhitelisted(collateralAssets[i].asset), "Collateral asset is not whitelisted");
        }

        (address vaultAddress, uint256 nftId, ) = abi.decode(extraData, (address, uint256, bool));

        IERC20(fromAsset).transfer(onBehalfOf, amount);

        // Approve 101% of amount to handle rounding errors
        uint256 approvalAmount = (amount * 101) / 100;
        bool successApprove = ISafe(onBehalfOf).execTransactionFromModule(
            fromAsset,
            0,
            abi.encodeCall(IERC20.approve, (address(vaultAddress), approvalAmount)),
            ISafe.Operation.Call
        );
        require(successApprove, "Fluid approve failed");

        bool successRepay = ISafe(onBehalfOf).execTransactionFromModule(
            vaultAddress,
            0,
            // Support only full repay on Fluid to avoid error
            abi.encodeCall(IFluidVault.operate, (nftId, 0, type(int).min, onBehalfOf)),
            ISafe.Operation.Call
        );
        require(successRepay, "Fluid repay failed");

        withdraw(collateralAssets[0].asset, 0, onBehalfOf, extraData);
    }

    function switchTo(
        address toAsset,
        uint256 amount,
        address onBehalfOf,
        CollateralAsset[] memory collateralAssets,
        bytes calldata extraData
    ) public override onlyAuthorizedCaller {
        require(registry.isWhitelisted(toAsset), "To asset is not whitelisted");
        _validateCollateralAssets(collateralAssets);
        for (uint256 i = 0; i < collateralAssets.length; i++) {
            require(registry.isWhitelisted(collateralAssets[i].asset), "Collateral asset is not whitelisted");
        }

        (address vaultAddress, uint256 nftId, ) = abi.decode(extraData, (address, uint256, bool));

        // use balanceOf() because collateral amount is slightly decreased when switching from Fluid
        uint256 currentBalance = IERC20(collateralAssets[0].asset).balanceOf(address(this));
        require(
                currentBalance < (collateralAssets[0].amount * 101) / 100,
                "Current balance is more than collateral amount + buffer"
            );

        bytes memory returnData = _supplyCollateral(vaultAddress, nftId, collateralAssets[0].asset, currentBalance, onBehalfOf);

        // If nftId is 0, extract new ID from return data, otherwise use the provided ID
        uint256 positionNftId;
        if (nftId == 0) {
            (positionNftId, , ) = abi.decode(returnData, (uint256, int256, int256));
        } else {
            positionNftId = nftId;
        }

        bool successBorrow = ISafe(onBehalfOf).execTransactionFromModule(
            vaultAddress,
            0,
            abi.encodeCall(IFluidVault.operate, (positionNftId, 0, int256(amount), address(this))),
            ISafe.Operation.Call
        );
        require(successBorrow, "Fluid borrow failed");
    }

    function repay(address asset, uint256 amount, address onBehalfOf, bytes calldata extraData) public override onlyAuthorizedCaller nonReentrant {
        require(registry.isWhitelisted(asset), "Asset is not whitelisted");

        (address vaultAddress, , bool isFullRepay) = abi.decode(extraData, (address, uint256, bool));

        // Determine repay amount based on isFullRepay flag from extraData
        int256 repayAmount;
        uint256 transferAmount;

        if (isFullRepay) {
            // Use actual balance for transfer when full repayment is requested
            transferAmount = IERC20(asset).balanceOf(address(this));
            // For Fluid full repayment, use type(int).min
            repayAmount = type(int).min;
        } else {
            transferAmount = amount;
            repayAmount = -int256(amount);

            // To avoid FluidVaultError(ErrorTypes.Vault__InvalidOperateAmount) error, skip repayment if amount is very small
            // https://github.com/Instadapp/fluid-contracts-public/blob/main/contracts/protocols/vault/vaultT1/coreModule/main.sol
            if (repayAmount > -10000) {
                return;
            }
        }

        IERC20(asset).transfer(onBehalfOf, transferAmount);

        // Approve max if full repayment to handle any rounding/interest accrual
        uint256 approvalAmount = isFullRepay ? type(uint256).max : transferAmount;

        bool successApprove = ISafe(onBehalfOf).execTransactionFromModule(
            asset,
            0,
            abi.encodeCall(IERC20.approve, (address(vaultAddress), approvalAmount)),
            ISafe.Operation.Call
        );
        require(successApprove, "Approval failed");

        // Extract nftId from extraData - if not provided (0), we'll fetch it
        (, uint256 nftIdFromExtra, ) = abi.decode(extraData, (address, uint256, bool));

        uint256 nftId = nftIdFromExtra;

        // If nftId not provided in extraData, fetch it using positionsByUser
        if (nftId == 0) {
            IFluidVaultResolver resolver = IFluidVaultResolver(registry.fluidVaultResolver());
            (Structs.UserPosition[] memory userPositions_, Structs.VaultEntireData[] memory vaultsData_) = resolver
                .positionsByUser(onBehalfOf);
            for (uint256 i = 0; i < vaultsData_.length; i++) {
                if (vaultsData_[i].vault == vaultAddress) {
                    nftId = userPositions_[i].nftId;
                    break;
                }
            }
        }

        bool successRepay = ISafe(onBehalfOf).execTransactionFromModule(
            vaultAddress,
            0,
            abi.encodeCall(IFluidVault.operate, (nftId, 0, repayAmount, onBehalfOf)),
            ISafe.Operation.Call
        );

        require(successRepay, "Repay failed");
    }

    function _supplyCollateral(address vaultAddress, uint256 nftId, address asset, uint256 amount, address onBehalfOf) internal returns (bytes memory) {
        bytes memory returnData;
        // Check if asset is WETH
        if (asset == registry.WETH_ADDRESS()) {
            // Transfer WETH to onBehalfOf first
            IERC20(asset).transfer(onBehalfOf, amount);

            // Unwrap WETH to ETH in the Safe
            bool successUnwrap = ISafe(onBehalfOf).execTransactionFromModule(
                asset,
                0,
                abi.encodeCall(IWETH9.withdraw, (amount)),
                ISafe.Operation.Call
            );
            require(successUnwrap, "WETH unwrap failed");

            // For WETH, send ETH as msg.value
            bool successSupply;
            (successSupply, returnData) = ISafe(onBehalfOf).execTransactionFromModuleReturnData(
                vaultAddress,
                amount, // Send ETH as msg.value
                abi.encodeCall(IFluidVault.operate, (nftId, int256(amount), 0, onBehalfOf)),
                ISafe.Operation.Call
            );
            require(successSupply, "Fluid supply failed");
        } else {
            // For other assets, use the standard approve and transfer flow
            bool successApprove = ISafe(onBehalfOf).execTransactionFromModule(
                asset,
                0,
                abi.encodeCall(IERC20.approve, (address(vaultAddress), amount)),
                ISafe.Operation.Call
            );
            require(successApprove, "Approval failed");

            IERC20(asset).transfer(onBehalfOf, amount);

            bool successSupply;
            (successSupply, returnData) = ISafe(onBehalfOf).execTransactionFromModuleReturnData(
                vaultAddress,
                0,
                abi.encodeCall(IFluidVault.operate, (nftId, int256(amount), 0, onBehalfOf)),
                ISafe.Operation.Call
            );
            require(successSupply, "Fluid supply failed");
        }

        return returnData;
    }

    function supply(address asset, uint256 amount, address onBehalfOf, bytes calldata extraData) external onlyAuthorizedCaller nonReentrant {
        require(registry.isWhitelisted(asset), "Asset is not whitelisted");

        (address vaultAddress, , ) = abi.decode(extraData, (address, uint256, bool));

        _supplyCollateral(vaultAddress, 0, asset, amount, onBehalfOf);
    }

    function borrow(address asset, uint256 amount, address onBehalfOf, bytes calldata extraData) external onlyAuthorizedCaller nonReentrant {
        require(registry.isWhitelisted(asset), "Asset is not whitelisted");

        (address vaultAddress, uint256 nftIdFromExtra, ) = abi.decode(extraData, (address, uint256, bool));

        uint256 nftId = nftIdFromExtra;

        // If nftId not provided in extraData, fetch it using positionsByUser
        if (nftId == 0) {
            IFluidVaultResolver resolver = IFluidVaultResolver(registry.fluidVaultResolver());
            (Structs.UserPosition[] memory userPositions_, Structs.VaultEntireData[] memory vaultsData_) = resolver
                .positionsByUser(onBehalfOf);
            for (uint256 i = 0; i < vaultsData_.length; i++) {
                if (vaultsData_[i].vault == vaultAddress) {
                    nftId = userPositions_[i].nftId;
                    break;
                }
            }
        }

        bool successBorrow = ISafe(onBehalfOf).execTransactionFromModule(
            vaultAddress,
            0,
            abi.encodeCall(IFluidVault.operate, (nftId, 0, int256(amount), address(this))),
            ISafe.Operation.Call
        );
        require(successBorrow, "Fluid borrow failed");
    }

    function withdraw(address asset, uint256 amount, address onBehalfOf, bytes calldata extraData) public override onlyAuthorizedCaller nonReentrant {
        require(registry.isWhitelisted(asset), "Asset is not whitelisted");

        (address vaultAddress, uint256 nftId, ) = abi.decode(extraData, (address, uint256, bool));

        // Withdraw all collateral from the position
        bool successWithdraw = ISafe(onBehalfOf).execTransactionFromModule(
            vaultAddress,
            0,
            // Support only full withdraw on Fluid to avoid error
            abi.encodeCall(IFluidVault.operate, (nftId, type(int).min, 0, address(this))),
            ISafe.Operation.Call
        );
        require(successWithdraw, "Fluid withdraw failed");

        // Handle WETH wrapping if needed - Fluid send ETH instead of WETH
        if (asset == registry.WETH_ADDRESS()) {
            uint256 ethBalance = address(this).balance;
            if (ethBalance > 0) {
                IWETH9(registry.WETH_ADDRESS()).deposit{value: ethBalance}();
            }
        }
    }
}
