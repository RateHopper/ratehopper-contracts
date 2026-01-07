// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "../interfaces/safe/ISafe.sol";
import "../interfaces/moonwell/IMToken.sol";
import {IComptroller} from "../interfaces/moonwell/Comptroller.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../Types.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ProtocolRegistry} from "../ProtocolRegistry.sol";
import "../protocols/BaseProtocolHandler.sol";
import "../interfaces/IWETH9.sol";

contract MoonwellHandler is BaseProtocolHandler {
    using SafeERC20 for IERC20;

    address public immutable COMPTROLLER;

    constructor(address _comptroller, address _UNISWAP_V3_FACTORY, address _REGISTRY_ADDRESS) BaseProtocolHandler(_UNISWAP_V3_FACTORY, _REGISTRY_ADDRESS) {
        COMPTROLLER = _comptroller;
    }

    error TokenNotRegistered();
    error MoonwellOperationFailed(uint256 errorCode);

    /**
     * @dev Helper function to execute Safe transactions and validate Moonwell error codes.
     * Moonwell (Compound V2 fork) returns uint error codes instead of reverting on failure.
     * Error code 0 means success, any other value indicates an error.
     * @param safe The Safe address to execute the transaction from
     * @param target The target contract address
     * @param data The encoded function call data
     * @param errorMessage The error message to use if the transaction fails
     */
    function _executeSafeTransactionWithMoonwellCheck(
        address safe,
        address target,
        bytes memory data,
        string memory errorMessage
    ) internal {
        (bool success, bytes memory returnData) = ISafe(safe).execTransactionFromModuleReturnData(
            target,
            0,
            data,
            ISafe.Operation.Call
        );
        require(success, errorMessage);

        // Moonwell functions always return uint256 error code (0 = success)
        uint256 errorCode = abi.decode(returnData, (uint256));
        if (errorCode != 0) {
            revert MoonwellOperationFailed(errorCode);
        }
    }

    /**
     * @dev Helper function to check Moonwell error code from direct calls (not via Safe).
     * @param errorCode The error code returned by Moonwell
     */
    function _checkMoonwellErrorCode(uint256 errorCode) internal pure {
        if (errorCode != 0) {
            revert MoonwellOperationFailed(errorCode);
        }
    }

    /**
     * @dev Helper function to execute enterMarkets via Safe and validate Moonwell error codes.
     * enterMarkets returns uint256[] (array of error codes) instead of a single uint256.
     * @param safe The Safe address to execute the transaction from
     * @param markets The array of market addresses to enter
     * @param errorMessage The error message to use if the transaction fails
     */
    function _executeSafeTransactionWithEnterMarketsCheck(
        address safe,
        address[] memory markets,
        string memory errorMessage
    ) internal {
        (bool success, bytes memory returnData) = ISafe(safe).execTransactionFromModuleReturnData(
            COMPTROLLER,
            0,
            abi.encodeCall(IComptroller.enterMarkets, (markets)),
            ISafe.Operation.Call
        );
        require(success, errorMessage);

        // enterMarkets always returns uint256[] (array of error codes)
        uint256[] memory errorCodes = abi.decode(returnData, (uint256[]));
        for (uint256 i = 0; i < errorCodes.length; i++) {
            if (errorCodes[i] != 0) {
                revert MoonwellOperationFailed(errorCodes[i]);
            }
        }
    }

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
        CollateralAsset[] memory /* collateralAssets */,
        bytes calldata /* fromExtraData */,
        bytes calldata /* toExtraData */
    ) external override onlyAuthorizedCaller(onBehalfOf) {
        require(registry.isWhitelisted(fromAsset), "From asset is not whitelisted");
        require(registry.isWhitelisted(toAsset), "To asset is not whitelisted");

        address fromContract = getMContract(fromAsset);
        address toContract = getMContract(toAsset);

        if (fromContract == address(0)) revert TokenNotRegistered();
        if (toContract == address(0)) revert TokenNotRegistered();

        IERC20(fromAsset).forceApprove(address(fromContract), amount);
        uint256 repayErrorCode = IMToken(fromContract).repayBorrowBehalf(onBehalfOf, amount);
        _checkMoonwellErrorCode(repayErrorCode);
        IERC20(fromAsset).forceApprove(address(fromContract), 0);

        _executeSafeTransactionWithMoonwellCheck(
            onBehalfOf,
            toContract,
            abi.encodeCall(IMToken.borrow, (amountTotal)),
            "Borrow transaction failed"
        );

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
    ) external override onlyAuthorizedCaller(onBehalfOf) {
        require(registry.isWhitelisted(fromAsset), "From asset is not whitelisted");
        _validateCollateralAssets(collateralAssets);
   
        address fromContract = getMContract(fromAsset);

        if (fromContract == address(0)) revert TokenNotRegistered();

        IERC20(fromAsset).forceApprove(address(fromContract), amount);
        uint256 repayErrorCode = IMToken(fromContract).repayBorrowBehalf(onBehalfOf, amount);
        _checkMoonwellErrorCode(repayErrorCode);
        IERC20(fromAsset).forceApprove(address(fromContract), 0);

        for (uint256 i = 0; i < collateralAssets.length; i++) {
            require(registry.isWhitelisted(collateralAssets[i].asset), "Collateral asset is not whitelisted");
            address mTokenAddress = getMContract(collateralAssets[i].asset);
            if (mTokenAddress == address(0)) revert TokenNotRegistered();

            _executeSafeTransactionWithMoonwellCheck(
                onBehalfOf,
                mTokenAddress,
                abi.encodeCall(IMToken.redeemUnderlying, (collateralAssets[i].amount)),
                "Redeem transaction failed"
            );

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
            require(currentBalance > 0, "No collateral balance available");

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
    ) external override onlyAuthorizedCaller(onBehalfOf) {
        require(registry.isWhitelisted(toAsset), "To asset is not whitelisted");
        _validateCollateralAssets(collateralAssets);

        address toContract = getMContract(toAsset);
        if (toContract == address(0)) revert TokenNotRegistered();

        for (uint256 i = 0; i < collateralAssets.length; i++) {
            require(registry.isWhitelisted(collateralAssets[i].asset), "Collateral asset is not whitelisted");
            
            address collateralContract = getMContract(collateralAssets[i].asset);
            // use balanceOf() because collateral amount is slightly decreased when switching from Fluid
            uint256 currentBalance = IERC20(collateralAssets[i].asset).balanceOf(address(this));
            require(currentBalance > 0, "No collateral balance available");

            IERC20(collateralAssets[i].asset).transfer(onBehalfOf, currentBalance);

            bool successApprove = ISafe(onBehalfOf).execTransactionFromModule(
                collateralAssets[i].asset,
                0,
                abi.encodeCall(IERC20.approve, (collateralContract, currentBalance)),
                ISafe.Operation.Call
            );

            require(successApprove, "Approve transaction failed");

            _executeSafeTransactionWithMoonwellCheck(
                onBehalfOf,
                collateralContract,
                abi.encodeCall(IMToken.mint, (currentBalance)),
                "Mint transaction failed"
            );

            address[] memory collateralContracts = new address[](1);
            collateralContracts[0] = collateralContract;

            _executeSafeTransactionWithEnterMarketsCheck(
                onBehalfOf,
                collateralContracts,
                "Enter markets transaction failed"
            );
        }

        _executeSafeTransactionWithMoonwellCheck(
            onBehalfOf,
            toContract,
            abi.encodeCall(IMToken.borrow, (amount)),
            "Borrow transaction failed"
        );

        bool successTransfer = ISafe(onBehalfOf).execTransactionFromModule(
            toAsset,
            0,
            abi.encodeCall(IERC20.transfer, (address(this), amount)),
            ISafe.Operation.Call
        );

        require(successTransfer, "Transfer transaction failed");
    }

    function supply(address asset, uint256 amount, address onBehalfOf, bytes calldata /* extraData */) external onlyAuthorizedCaller(onBehalfOf) {
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

        _executeSafeTransactionWithMoonwellCheck(
            onBehalfOf,
            mContract,
            abi.encodeCall(IMToken.mint, (amount)),
            "moonwell mint failed"
        );

        address[] memory collateralContracts = new address[](1);
        collateralContracts[0] = mContract;

        _executeSafeTransactionWithEnterMarketsCheck(
            onBehalfOf,
            collateralContracts,
            "Enter markets transaction failed"
        );
    }

    function borrow(address asset, uint256 amount, address onBehalfOf, bytes calldata /* extraData */) external onlyAuthorizedCaller(onBehalfOf) {
        require(registry.isWhitelisted(asset), "Asset is not whitelisted");

        address mContract = getMContract(asset);
        if (mContract == address(0)) revert TokenNotRegistered();

        _executeSafeTransactionWithMoonwellCheck(
            onBehalfOf,
            mContract,
            abi.encodeCall(IMToken.borrow, (amount)),
            "Borrow transaction failed"
        );

        bool successTransfer = ISafe(onBehalfOf).execTransactionFromModule(
            asset,
            0,
            abi.encodeCall(IERC20.transfer, (address(this), amount)),
            ISafe.Operation.Call
        );

        require(successTransfer, "Transfer transaction failed");
    }

    function repay(address asset, uint256 amount, address onBehalfOf, bytes calldata /* extraData */) public override onlyAuthorizedCaller(onBehalfOf) {
        require(registry.isWhitelisted(asset), "Asset is not whitelisted");

        address mContract = getMContract(asset);
        if (mContract == address(0)) revert TokenNotRegistered();

        // Get actual debt to avoid repaying more than owed (which causes underflow)
        uint256 actualDebt = IMToken(mContract).borrowBalanceCurrent(onBehalfOf);
        uint256 repayAmount = amount > actualDebt ? actualDebt : amount;
        if (repayAmount == 0) {
            return;
        }

        IERC20(asset).forceApprove(address(mContract), repayAmount);
        uint256 repayErrorCode = IMToken(mContract).repayBorrowBehalf(onBehalfOf, repayAmount);
        _checkMoonwellErrorCode(repayErrorCode);
        IERC20(asset).forceApprove(address(mContract), 0);
    }

    function withdraw(address asset, uint256 amount, address onBehalfOf, bytes calldata /* extraData */) external override onlyAuthorizedCaller(onBehalfOf) {
        require(registry.isWhitelisted(asset), "Asset is not whitelisted");

        address mTokenAddress = getMContract(asset);
        if (mTokenAddress == address(0)) revert TokenNotRegistered();

        // Redeem underlying asset from Moonwell
        _executeSafeTransactionWithMoonwellCheck(
            onBehalfOf,
            mTokenAddress,
            abi.encodeCall(IMToken.redeemUnderlying, (amount)),
            "Redeem transaction failed"
        );

        // Moonwell sends ETH instead of WETH when withdrawing, so wrap it for compatibility with other protocols.
        if (asset == registry.WETH_ADDRESS()) {
            uint256 ethBalanceInSafe = address(onBehalfOf).balance;
            bool successWrap = ISafe(onBehalfOf).execTransactionFromModule(
                registry.WETH_ADDRESS(),
                ethBalanceInSafe,
                abi.encodeCall(IWETH9.deposit, ()),
                ISafe.Operation.Call
            );
            require(successWrap, "WETH wrap failed");
        }

        // Transfer withdrawn asset from Safe to handler contract
        uint256 currentBalance = IERC20(asset).balanceOf(onBehalfOf);
        bool successTransfer = ISafe(onBehalfOf).execTransactionFromModule(
            asset,
            0,
            abi.encodeCall(IERC20.transfer, (address(this), currentBalance)),
            ISafe.Operation.Call
        );
        require(successTransfer, "Transfer transaction failed");
    }
}
