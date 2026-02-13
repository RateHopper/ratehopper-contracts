// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolV3} from "../interfaces/aaveV3/IPoolV3.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {DataTypes} from "../interfaces/aaveV3/DataTypes.sol";
import {IAaveProtocolDataProvider} from "../interfaces/aaveV3/IAaveProtocolDataProvider.sol";
import {IAaveOracle} from "../interfaces/aaveV3/IAaveOracle.sol";
import {IPoolAddressesProvider} from "../interfaces/aaveV3/IPoolAddressesProvider.sol";
import "./BaseProtocolHandler.sol";
import "../ProtocolRegistry.sol";

contract AaveV3Handler is BaseProtocolHandler {
    using SafeERC20 for IERC20;

    IPoolV3 public immutable aaveV3Pool;
    IAaveProtocolDataProvider public immutable dataProvider;

    constructor(
        address _AAVE_V3_POOL_ADDRESS,
        address _AAVE_V3_DATA_PROVIDER_ADDRESS,
        address _UNISWAP_V3_FACTORY_ADDRESS,
        address _REGISTRY_ADDRESS
    ) BaseProtocolHandler(_UNISWAP_V3_FACTORY_ADDRESS, _REGISTRY_ADDRESS) {
        aaveV3Pool = IPoolV3(_AAVE_V3_POOL_ADDRESS);
        dataProvider = IAaveProtocolDataProvider(_AAVE_V3_DATA_PROVIDER_ADDRESS);
    }

    function getDebtAmount(
        address asset,
        address onBehalfOf,
        bytes calldata /* fromExtraData */
    ) public view returns (uint256) {
        (, , uint256 currentVariableDebt, , , , , , ) = dataProvider.getUserReserveData(asset, onBehalfOf);
        return currentVariableDebt;
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

        IERC20(fromAsset).forceApprove(address(aaveV3Pool), amount);
        aaveV3Pool.repay(fromAsset, amount, 2, onBehalfOf);

        aaveV3Pool.borrow(address(toAsset), amountTotal, 2, 0, onBehalfOf);
        IERC20(fromAsset).forceApprove(address(aaveV3Pool), 0);
    }

    function switchFrom(
        address fromAsset,
        uint256 amount,
        address onBehalfOf,
        CollateralAsset[] memory collateralAssets,
        bytes calldata /* extraData */
    ) external override onlyAuthorizedCaller(onBehalfOf) {
        _validateCollateralAssets(collateralAssets);
        require(registry.isWhitelisted(fromAsset), "From asset is not whitelisted");

        IERC20(fromAsset).forceApprove(address(aaveV3Pool), amount);
        aaveV3Pool.repay(fromAsset, amount, 2, onBehalfOf);
        IERC20(fromAsset).forceApprove(address(aaveV3Pool), 0);

        for (uint256 i = 0; i < collateralAssets.length; i++) {
            require(registry.isWhitelisted(collateralAssets[i].asset), "Collateral asset is not whitelisted");

            DataTypes.ReserveData memory reserveData = aaveV3Pool.getReserveData(collateralAssets[i].asset);
            require(reserveData.aTokenAddress != address(0), "Asset not supported by Aave");

            uint256 withdrawAmount = collateralAssets[i].amount;
            if (withdrawAmount == type(uint256).max) {
                withdrawAmount = _calculateMaxWithdrawAmount(collateralAssets[i].asset, onBehalfOf, reserveData);
                require(withdrawAmount > 0, "No collateral available to withdraw");
            }

            IERC20(reserveData.aTokenAddress).safeTransferFrom(onBehalfOf, address(this), withdrawAmount);
            aaveV3Pool.withdraw(collateralAssets[i].asset, withdrawAmount, address(this));
        }
    }

    function switchTo(
        address toAsset,
        uint256 amount,
        address onBehalfOf,
        CollateralAsset[] memory collateralAssets,
        bytes calldata /* extraData */
    ) external override onlyAuthorizedCaller(onBehalfOf) {
        _validateCollateralAssets(collateralAssets);

        require(registry.isWhitelisted(toAsset), "To asset is not whitelisted");

        for (uint256 i = 0; i < collateralAssets.length; i++) {
            require(registry.isWhitelisted(collateralAssets[i].asset), "Collateral asset is not whitelisted");

            // Validate asset is supported by Aave
            DataTypes.ReserveData memory reserveData = aaveV3Pool.getReserveData(collateralAssets[i].asset);
            require(reserveData.aTokenAddress != address(0), "Asset not supported by Aave");

            uint256 currentBalance = IERC20(collateralAssets[i].asset).balanceOf(address(this));
            require(currentBalance > 0, "No collateral balance available");

            IERC20(collateralAssets[i].asset).forceApprove(address(aaveV3Pool), currentBalance);
            aaveV3Pool.supply(collateralAssets[i].asset, currentBalance, onBehalfOf, 0);
            IERC20(collateralAssets[i].asset).forceApprove(address(aaveV3Pool), 0);
        }

        aaveV3Pool.borrow(toAsset, amount, 2, 0, onBehalfOf);
    }

    function supply(address asset, uint256 amount, address onBehalfOf, bytes calldata /* extraData */) external override onlyAuthorizedCaller(onBehalfOf) {
        require(registry.isWhitelisted(asset), "Asset is not whitelisted");

        IERC20(asset).forceApprove(address(aaveV3Pool), amount);
        aaveV3Pool.supply(asset, amount, onBehalfOf, 0);
        IERC20(asset).forceApprove(address(aaveV3Pool), 0);
    }

    function borrow(address asset, uint256 amount, address onBehalfOf, bytes calldata /* extraData */) external override onlyAuthorizedCaller(onBehalfOf) {
        require(registry.isWhitelisted(asset), "Asset is not whitelisted");

        aaveV3Pool.borrow(asset, amount, 2, 0, onBehalfOf);
    }

    function repay(address asset, uint256 amount, address onBehalfOf, bytes calldata /* extraData */) public onlyAuthorizedCaller(onBehalfOf) {
        require(registry.isWhitelisted(asset), "Asset is not whitelisted");

        // Skip repayment if amount is 1 wei or less to prevent Aave v3 InvalidBurnAmount error
        if (amount <= 1) {
            return;
        }

        IERC20(asset).forceApprove(address(aaveV3Pool), amount);
        aaveV3Pool.repay(asset, amount, 2, onBehalfOf);
        IERC20(asset).forceApprove(address(aaveV3Pool), 0);
    }

    function withdraw(address asset, uint256 amount, address onBehalfOf, bytes calldata /* extraData */) external override onlyAuthorizedCaller(onBehalfOf) {
        require(registry.isWhitelisted(asset), "Asset is not whitelisted");

        // Get aToken address for the asset
        DataTypes.ReserveData memory reserveData = aaveV3Pool.getReserveData(asset);
        require(reserveData.aTokenAddress != address(0), "Asset not supported by Aave");

        uint256 withdrawAmount = amount;
        if (amount == type(uint256).max) {
            withdrawAmount = _calculateMaxWithdrawAmount(asset, onBehalfOf, reserveData);
            require(withdrawAmount > 0, "No collateral available to withdraw");
        }

        // Transfer aTokens from user to this contract
        IERC20(reserveData.aTokenAddress).safeTransferFrom(onBehalfOf, address(this), withdrawAmount);

        // Withdraw underlying asset to this contract
        aaveV3Pool.withdraw(asset, withdrawAmount, address(this));
    }

    /// @dev Liquidation threshold precision (basis points: 1e4 = 100%)
    uint256 private constant LIQ_THRESHOLD_PRECISION = 1e4;

    function _calculateMaxWithdrawAmount(
        address asset,
        address user,
        DataTypes.ReserveData memory reserveData
    ) internal view returns (uint256) {
        (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            ,
            uint256 currentLiquidationThreshold,
            ,
        ) = aaveV3Pool.getUserAccountData(user);

        uint256 userATokenBalance = IERC20(reserveData.aTokenAddress).balanceOf(user);
        uint256 availableLiquidity = IERC20(asset).balanceOf(reserveData.aTokenAddress);

        if (totalDebtBase == 0) {
            return _min(userATokenBalance, availableLiquidity);
        }

        if (currentLiquidationThreshold == 0) return 0;

        uint256 minCollateralBase = (totalDebtBase * LIQ_THRESHOLD_PRECISION) / currentLiquidationThreshold;

        if (totalCollateralBase <= minCollateralBase) {
            return 0;
        }

        uint256 maxWithdrawBase = totalCollateralBase - minCollateralBase;

        IPoolAddressesProvider addressProvider = aaveV3Pool.ADDRESSES_PROVIDER();
        IAaveOracle oracle = IAaveOracle(addressProvider.getPriceOracle());
        uint256 assetPrice = oracle.getAssetPrice(asset);
        if (assetPrice == 0) return 0;

        uint8 assetDecimals = IERC20Metadata(asset).decimals();

        uint256 maxWithdrawTokens = (maxWithdrawBase * (10 ** assetDecimals)) / assetPrice;
        // Apply 0.1% safety margin to keep health factor safely above 1
        maxWithdrawTokens = (maxWithdrawTokens * 999) / 1000;

        return _min(maxWithdrawTokens, _min(userATokenBalance, availableLiquidity));
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
