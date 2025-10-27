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

    // The registry contract holds configuration data including the Fluid vault resolver address and WETH address
    // This design allows the resolver to be updated without redeploying handlers
    // and works correctly with delegatecall since registry is immutable
    ProtocolRegistry public immutable registry;

    constructor(address _UNISWAP_V3_FACTORY, address _REGISTRY_ADDRESS) BaseProtocolHandler(_UNISWAP_V3_FACTORY) {
        registry = ProtocolRegistry(_REGISTRY_ADDRESS);
    }

    function getDebtAmount(
        address asset,
        address onBehalfOf,
        bytes calldata fromExtraData
    ) public view returns (uint256) {
        (address vaultAddress, ) = abi.decode(fromExtraData, (address, uint256));

        IFluidVaultResolver resolver = IFluidVaultResolver(registry.fluidVaultResolver());

        (Structs.UserPosition[] memory userPositions_, Structs.VaultEntireData[] memory vaultsData_) = resolver
            .positionsByUser(onBehalfOf);
        for (uint256 i = 0; i < vaultsData_.length; i++) {
            if (vaultsData_[i].vault == vaultAddress) {
                uint256 debtAmount = userPositions_[i].borrow;
                // add tiny amount buffer to avoid repay amount is slightly increased and revert
                return (debtAmount * 100001) / 100000;
            }
        }
        revert("Vault not found");
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
    ) external override onlyUniswapV3Pool nonReentrant {        
        switchFrom(fromAsset, amount, onBehalfOf, collateralAssets, fromExtraData);
        switchTo(toAsset, amountTotal, onBehalfOf, collateralAssets, toExtraData);
    }

    function switchFrom(
        address fromAsset,
        uint256 amount,
        address onBehalfOf,
        CollateralAsset[] memory collateralAssets,
        bytes calldata extraData
    ) public override onlyUniswapV3Pool {
        require(registry.isWhitelisted(fromAsset), "From asset is not whitelisted");
        _validateCollateralAssets(collateralAssets);
        for (uint256 i = 0; i < collateralAssets.length; i++) {
            require(registry.isWhitelisted(collateralAssets[i].asset), "Collateral asset is not whitelisted");
        }

        (address vaultAddress, uint256 nftId) = abi.decode(extraData, (address, uint256));

        IERC20(fromAsset).transfer(onBehalfOf, amount);

        bool successApprove = ISafe(onBehalfOf).execTransactionFromModule(
            fromAsset,
            0,
            abi.encodeCall(IERC20.approve, (address(vaultAddress), amount)),
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

        bool successWithdraw = ISafe(onBehalfOf).execTransactionFromModule(
            vaultAddress,
            0,
            // Support only full withdraw on Fluid to avoid error
            abi.encodeCall(IFluidVault.operate, (nftId, type(int).min, 0, address(this))),
            ISafe.Operation.Call
        );
        require(successWithdraw, "Fluid withdraw failed");
    }

    function switchTo(
        address toAsset,
        uint256 amount,
        address onBehalfOf,
        CollateralAsset[] memory collateralAssets,
        bytes calldata extraData
    ) public override onlyUniswapV3Pool {
        require(registry.isWhitelisted(toAsset), "To asset is not whitelisted");
        _validateCollateralAssets(collateralAssets);
        for (uint256 i = 0; i < collateralAssets.length; i++) {
            require(registry.isWhitelisted(collateralAssets[i].asset), "Collateral asset is not whitelisted");
        }

        (address vaultAddress, uint256 nftId) = abi.decode(extraData, (address, uint256));

        // use balanceOf() because collateral amount is slightly decreased when switching from Fluid
        uint256 currentBalance = IERC20(collateralAssets[0].asset).balanceOf(address(this));
        require(
                currentBalance < (collateralAssets[0].amount * 101) / 100,
                "Current balance is more than collateral amount + buffer"
            );

        bytes memory returnData;
        // Check if collateral asset is WETH
        if (collateralAssets[0].asset == registry.WETH_ADDRESS()) {
            // Transfer WETH to onBehalfOf first
            IERC20(collateralAssets[0].asset).transfer(onBehalfOf, currentBalance);
            
            // Unwrap WETH to ETH in the Safe
            bool successUnwrap = ISafe(onBehalfOf).execTransactionFromModule(
                collateralAssets[0].asset,
                0,
                abi.encodeCall(IWETH9.withdraw, (currentBalance)),
                ISafe.Operation.Call
            );
            require(successUnwrap, "WETH unwrap failed");
            
            // For WETH, send ETH as msg.value
            bool successSupply;
            (successSupply, returnData) = ISafe(onBehalfOf).execTransactionFromModuleReturnData(
                vaultAddress,
                currentBalance, // Send ETH as msg.value
                abi.encodeCall(IFluidVault.operate, (nftId, int256(currentBalance), 0, onBehalfOf)),
                ISafe.Operation.Call
            );
            require(successSupply, "Fluid supply failed");
        } else {
            // For other assets, use the standard approve and transfer flow
            IERC20(collateralAssets[0].asset).transfer(onBehalfOf, currentBalance);

            bool successApprove = ISafe(onBehalfOf).execTransactionFromModule(
                collateralAssets[0].asset,
                0,
                abi.encodeCall(IERC20.approve, (address(vaultAddress), currentBalance)),
                ISafe.Operation.Call
            );
            require(successApprove, "Approval failed");

            bool successSupply;
            (successSupply, returnData) = ISafe(onBehalfOf).execTransactionFromModuleReturnData(
                vaultAddress,
                0,
                abi.encodeCall(IFluidVault.operate, (nftId, int256(currentBalance), 0, onBehalfOf)),
                ISafe.Operation.Call
            );
            require(successSupply, "Fluid supply failed");
        }

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

    function repay(address asset, uint256 amount, address onBehalfOf, bytes calldata extraData) public override onlyUniswapV3Pool nonReentrant {
        require(registry.isWhitelisted(asset), "Asset is not whitelisted");
        
        (address vaultAddress, ) = abi.decode(extraData, (address, uint256));

        IERC20(asset).transfer(onBehalfOf, amount);

        int256 repayAmount = -int256(amount);

        // To avoid FluidVaultError(ErrorTypes.Vault__InvalidOperateAmount) error, skip repayment if amount is very small
        // https://github.com/Instadapp/fluid-contracts-public/blob/main/contracts/protocols/vault/vaultT1/coreModule/main.sol
        if (repayAmount > -10000) {
            return;
        }

        bool successApprove = ISafe(onBehalfOf).execTransactionFromModule(
            asset,
            0,
            abi.encodeCall(IERC20.approve, (address(vaultAddress), amount)),
            ISafe.Operation.Call
        );
        require(successApprove, "Approval failed");

        IFluidVaultResolver resolver = IFluidVaultResolver(registry.fluidVaultResolver());

        // get nftId
        uint256 nftId = 0;
        (Structs.UserPosition[] memory userPositions_, Structs.VaultEntireData[] memory vaultsData_) = resolver
            .positionsByUser(onBehalfOf);
        for (uint256 i = 0; i < vaultsData_.length; i++) {
            if (vaultsData_[i].vault == vaultAddress) {
                nftId = userPositions_[i].nftId;
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

    function supply(address asset, uint256 amount, address onBehalfOf, bytes calldata extraData) external onlyUniswapV3Pool nonReentrant {
        require(registry.isWhitelisted(asset), "Asset is not whitelisted");
        
        (address vaultAddress, ) = abi.decode(extraData, (address, uint256));
    
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
            (bool successSupply, bytes memory returnData) = ISafe(onBehalfOf).execTransactionFromModuleReturnData(
                vaultAddress,
                amount, // Send ETH as msg.value
                abi.encodeCall(IFluidVault.operate, (0, int256(amount), 0, onBehalfOf)),
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

            (bool successSupply, bytes memory returnData) = ISafe(onBehalfOf).execTransactionFromModuleReturnData(
                vaultAddress,
                0,
                abi.encodeCall(IFluidVault.operate, (0, int256(amount), 0, onBehalfOf)),
                ISafe.Operation.Call
            );
            require(successSupply, "Fluid supply failed");
        }
    }

    function borrow(address asset, uint256 amount, address onBehalfOf, bytes calldata extraData) external onlyUniswapV3Pool nonReentrant {
        require(registry.isWhitelisted(asset), "Asset is not whitelisted");
        
        (address vaultAddress, ) = abi.decode(extraData, (address, uint256));

        IFluidVaultResolver resolver = IFluidVaultResolver(registry.fluidVaultResolver());

        // get nftId
        uint256 nftId = 0;
        (Structs.UserPosition[] memory userPositions_, Structs.VaultEntireData[] memory vaultsData_) = resolver
            .positionsByUser(onBehalfOf);
        for (uint256 i = 0; i < vaultsData_.length; i++) {
            if (vaultsData_[i].vault == vaultAddress) {
                nftId = userPositions_[i].nftId;
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
}
