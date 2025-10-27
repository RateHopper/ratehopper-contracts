// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../interfaces/safe/ISafe.sol";
import "../interfaces/moonwell/IMToken.sol";
import {IComptroller} from "../interfaces/moonwell/Comptroller.sol";
import {GPv2SafeERC20} from "../dependencies/GPv2SafeERC20.sol";
import "../Types.sol";
import {IERC20} from "../dependencies/IERC20.sol";
import {ProtocolRegistry} from "../ProtocolRegistry.sol";
import "../protocols/BaseProtocolHandler.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../interfaces/IWETH9.sol";

contract MoonwellHandler is BaseProtocolHandler, ReentrancyGuard {
    using GPv2SafeERC20 for IERC20;

    address public immutable COMPTROLLER;
    ProtocolRegistry public immutable registry;

    constructor(address _comptroller, address _UNISWAP_V3_FACTORY, address _REGISTRY_ADDRESS) BaseProtocolHandler(_UNISWAP_V3_FACTORY) {
        COMPTROLLER = _comptroller;
        registry = ProtocolRegistry(_REGISTRY_ADDRESS);
    }

    error TokenNotRegistered();

    function getMContract(address token) internal view returns (address) {
        return registry.getMContract(token);
    }

    function getDebtAmount(
        address asset,
        address onBehalfOf,
        bytes calldata /* extraData */
    ) external view returns (uint256) {
        address mContract = getMContract(asset);
        if (mContract == address(0)) revert TokenNotRegistered();

        return IMToken(mContract).borrowBalanceStored(onBehalfOf);
    }

    function switchIn(
        address fromAsset,
        address toAsset,
        uint256 amount,
        uint256 amountTotal,
        address onBehalfOf,
        CollateralAsset[] memory collateralAssets,
        bytes calldata /* fromExtraData */,
        bytes calldata /* toExtraData */
    ) external override onlyUniswapV3Pool nonReentrant {
        require(registry.isWhitelisted(fromAsset), "From asset is not whitelisted");
        require(registry.isWhitelisted(toAsset), "To asset is not whitelisted");

        address fromContract = getMContract(fromAsset);
        address toContract = getMContract(toAsset);

        if (fromContract == address(0)) revert TokenNotRegistered();
        if (toContract == address(0)) revert TokenNotRegistered();
        IERC20(fromAsset).approve(address(fromContract), amount);

        IMToken(fromContract).repayBorrowBehalf(onBehalfOf, amount);

        bytes memory borrowData = abi.encodeCall(IMToken.borrow, (amountTotal));
        bool successBorrow = ISafe(onBehalfOf).execTransactionFromModule(
            toContract,
            0,
            borrowData,
            ISafe.Operation.Call
        );

        require(successBorrow, "Borrow transaction failed");

        bytes memory transferData = abi.encodeCall(IERC20.transfer, (address(this), amountTotal));
        bool successTransfer = ISafe(onBehalfOf).execTransactionFromModule(
            toAsset,
            0,
            transferData,
            ISafe.Operation.Call
        );
        require(successTransfer, "Transfer transaction failed");
    }

    function switchFrom(
        address fromAsset,
        uint256 amount,
        address onBehalfOf,
        CollateralAsset[] memory collateralAssets,
        bytes calldata /* extraData */
    ) external override onlyUniswapV3Pool nonReentrant {
        require(registry.isWhitelisted(fromAsset), "From asset is not whitelisted");
        _validateCollateralAssets(collateralAssets);
   
        address fromContract = getMContract(fromAsset);

        if (fromContract == address(0)) revert TokenNotRegistered();

        IERC20(fromAsset).approve(address(fromContract), amount);
        IMToken(fromContract).repayBorrowBehalf(onBehalfOf, amount);

        for (uint256 i = 0; i < collateralAssets.length; i++) {
            require(registry.isWhitelisted(collateralAssets[i].asset), "Collateral asset is not whitelisted");
            address mTokenAddress = getMContract(collateralAssets[i].asset);
            if (mTokenAddress == address(0)) revert TokenNotRegistered();

            bool successWithdraw = ISafe(onBehalfOf).execTransactionFromModule(
                mTokenAddress,
                0,
                abi.encodeCall(IMToken.redeemUnderlying, (collateralAssets[i].amount)),
                ISafe.Operation.Call
            );

            require(successWithdraw, "Redeem transaction failed");

             // Moonwell sends ETH instead of WETH when withdrawing, so wrap it for compatibility with other protocols.
             if (collateralAssets[i].asset == registry.WETH_ADDRESS()) {
                bool successWrap = ISafe(onBehalfOf).execTransactionFromModule(
                    registry.WETH_ADDRESS(),
                    collateralAssets[i].amount,
                    abi.encodeCall(IWETH9.deposit, ()),
                    ISafe.Operation.Call
                );
                require(successWrap, "WETH wrap failed");
            }


            uint256 currentBalance = IERC20(collateralAssets[i].asset).balanceOf(onBehalfOf);
            require(
                currentBalance * 100 < collateralAssets[i].amount * 101,
                "Current balance is more than collateral amount + buffer"
            );

            bool successTransfer = ISafe(onBehalfOf).execTransactionFromModule(
                collateralAssets[i].asset,
                0,
                abi.encodeCall(IERC20.transfer, (address(this), currentBalance)),
                ISafe.Operation.Call
            );

            require(successTransfer, "Transfer transaction failed");
        }
    }

    function switchTo(
        address toAsset,
        uint256 amount,
        address onBehalfOf,
        CollateralAsset[] memory collateralAssets,
        bytes calldata /* extraData */
    ) external override onlyUniswapV3Pool nonReentrant {
        require(registry.isWhitelisted(toAsset), "To asset is not whitelisted");
        _validateCollateralAssets(collateralAssets);

        address toContract = getMContract(toAsset);
        if (toContract == address(0)) revert TokenNotRegistered();

        for (uint256 i = 0; i < collateralAssets.length; i++) {
            require(registry.isWhitelisted(collateralAssets[i].asset), "Collateral asset is not whitelisted");
            
            address collateralContract = getMContract(collateralAssets[i].asset);
            // use balanceOf() because collateral amount is slightly decreased when switching from Fluid
            uint256 currentBalance = IERC20(collateralAssets[i].asset).balanceOf(address(this));
            require(
                currentBalance * 100 < collateralAssets[i].amount * 101,
                "Current balance is more than collateral amount + buffer"
            );

            IERC20(collateralAssets[i].asset).transfer(onBehalfOf, currentBalance);

            bool successApprove = ISafe(onBehalfOf).execTransactionFromModule(
                collateralAssets[i].asset,
                0,
                abi.encodeCall(IERC20.approve, (collateralContract, currentBalance)),
                ISafe.Operation.Call
            );

            require(successApprove, "Approve transaction failed");

            bool successMint = ISafe(onBehalfOf).execTransactionFromModule(
                collateralContract,
                0,
                abi.encodeCall(IMToken.mint, (currentBalance)),
                ISafe.Operation.Call
            );
            require(successMint, "Mint transaction failed");

            address[] memory collateralContracts = new address[](1);
            collateralContracts[0] = collateralContract;

            bool successEnterMarkets = ISafe(onBehalfOf).execTransactionFromModule(
                COMPTROLLER,
                0,
                abi.encodeCall(IComptroller.enterMarkets, (collateralContracts)),
                ISafe.Operation.Call
            );

            require(successEnterMarkets, "Enter markets transaction failed");
        }

        bool successBorrow = ISafe(onBehalfOf).execTransactionFromModule(
            toContract,
            0,
            abi.encodeCall(IMToken.borrow, (amount)),
            ISafe.Operation.Call
        );

        require(successBorrow, "Borrow transaction failed");

        bool successTransfer = ISafe(onBehalfOf).execTransactionFromModule(
            toAsset,
            0,
            abi.encodeCall(IERC20.transfer, (address(this), amount)),
            ISafe.Operation.Call
        );

        require(successTransfer, "Transfer transaction failed");
    }

    function supply(address asset, uint256 amount, address onBehalfOf, bytes calldata /* extraData */) external onlyUniswapV3Pool nonReentrant {
        require(registry.isWhitelisted(asset), "Asset is not whitelisted");
        
        address mContract = getMContract(asset);
        if (mContract == address(0)) revert TokenNotRegistered();

        bool successApprove = ISafe(onBehalfOf).execTransactionFromModule(
            asset,
            0,
            abi.encodeCall(IERC20.approve, (mContract, amount)),
            ISafe.Operation.Call
        );

        require(successApprove, "moonwell approve failed");

        IERC20(asset).transfer(onBehalfOf, amount);

        bool successMint = ISafe(onBehalfOf).execTransactionFromModule(
            mContract,
            0,
            abi.encodeCall(IMToken.mint, (amount)),
            ISafe.Operation.Call
        );

        require(successMint, "moonwell mint failed");

        address[] memory collateralContracts = new address[](1);
        collateralContracts[0] = mContract;

        bool successEnterMarkets = ISafe(onBehalfOf).execTransactionFromModule(
            COMPTROLLER,
            0,
            abi.encodeCall(IComptroller.enterMarkets, (collateralContracts)),
            ISafe.Operation.Call
        );
        require(successEnterMarkets, "Enter markets transaction failed");
    }

    function borrow(address asset, uint256 amount, address onBehalfOf, bytes calldata /* extraData */) external onlyUniswapV3Pool nonReentrant {
        require(registry.isWhitelisted(asset), "Asset is not whitelisted");
        
        address mContract = getMContract(asset);
        if (mContract == address(0)) revert TokenNotRegistered();

        bool successBorrow = ISafe(onBehalfOf).execTransactionFromModule(
            mContract,
            0,
            abi.encodeCall(IMToken.borrow, (amount)),
            ISafe.Operation.Call
        );

        require(successBorrow, "Borrow transaction failed");

        bool successTransfer = ISafe(onBehalfOf).execTransactionFromModule(
            asset,
            0,
            abi.encodeCall(IERC20.transfer, (address(this), amount)),
            ISafe.Operation.Call
        );

        require(successTransfer, "Transfer transaction failed");
    }

    function repay(address asset, uint256 amount, address onBehalfOf, bytes calldata /* extraData */) public override onlyUniswapV3Pool nonReentrant {
        require(registry.isWhitelisted(asset), "Asset is not whitelisted");
        
        address mContract = getMContract(asset);
        if (mContract == address(0)) revert TokenNotRegistered();

        IERC20(asset).approve(address(mContract), amount);
        IMToken(mContract).repayBorrowBehalf(onBehalfOf, amount);
    }
}
