// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DataTypes} from "../interfaces/aaveV3/DataTypes.sol";
import "../interfaces/morpho/IMorpho.sol";
import {IMorphoOracle} from "../interfaces/morpho/IMorphoOracle.sol";
import {MarketParamsLib} from "../dependencies/morpho/MarketParamsLib.sol";
import {SharesMathLib} from "../dependencies/morpho/SharesMathLib.sol";
import "./BaseProtocolHandler.sol";
import "../ProtocolRegistry.sol";

contract MorphoHandler is BaseProtocolHandler {
    using MarketParamsLib for MarketParams;
    using SafeERC20 for IERC20;
    using SharesMathLib for uint256;

    IMorpho public immutable morpho;

    constructor(address _MORPHO_ADDRESS, address _UNISWAP_V3_FACTORY, address _REGISTRY_ADDRESS) BaseProtocolHandler(_UNISWAP_V3_FACTORY, _REGISTRY_ADDRESS) {
        morpho = IMorpho(_MORPHO_ADDRESS);
    }

    function getDebtAmount(
        address /* asset */,
        address /* onBehalfOf */,
        bytes calldata fromExtraData
    ) public view returns (uint256) {
        (MarketParams memory marketParams, uint256 borrowShares) = abi.decode(fromExtraData, (MarketParams, uint256));
        Id marketId = marketParams.id();
        Market memory m = morpho.market(marketId);
        return borrowShares.toAssetsUp(m.totalBorrowAssets, m.totalBorrowShares) + 1;
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
    ) external override onlyAuthorizedCaller(onBehalfOf) {
        switchFrom(fromAsset, amount, onBehalfOf, collateralAssets, fromExtraData);
        switchTo(toAsset, amountTotal, onBehalfOf, collateralAssets, toExtraData);
    }

    function switchFrom(
        address fromAsset,
        uint256 amount,
        address onBehalfOf,
        CollateralAsset[] memory collateralAssets,
        bytes calldata extraData
    ) public override onlyAuthorizedCaller(onBehalfOf) {
        require(registry.isWhitelisted(fromAsset), "From asset is not whitelisted");
        require(registry.isWhitelisted(collateralAssets[0].asset), "Collateral asset is not whitelisted");

        // Morpho only supports one collateral asset
        require(collateralAssets.length == 1, "Morpho supports only one collateral asset");
        require(collateralAssets[0].amount > 0, "Invalid collateral amount");

        (MarketParams memory marketParams, uint256 borrowShares) = abi.decode(extraData, (MarketParams, uint256));
        require(marketParams.loanToken == fromAsset, "fromAsset mismatch with marketParams in extraData");

        IERC20(fromAsset).forceApprove(address(morpho), amount);
        morpho.repay(marketParams, 0, borrowShares, onBehalfOf, "");

        uint256 withdrawAmount = collateralAssets[0].amount;
        if (withdrawAmount == type(uint256).max) {
            Id marketId = marketParams.id();
            Position memory pos = morpho.position(marketId, onBehalfOf);
            withdrawAmount = uint256(pos.collateral);
            require(withdrawAmount > 0, "No collateral available to withdraw");
        }

        morpho.withdrawCollateral(marketParams, withdrawAmount, onBehalfOf, address(this));
        IERC20(fromAsset).forceApprove(address(morpho), 0);
    }

    function switchTo(
        address toAsset,
        uint256 amount,
        address onBehalfOf,
        CollateralAsset[] memory collateralAssets,
        bytes calldata extraData
    ) public override onlyAuthorizedCaller(onBehalfOf) {
        require(registry.isWhitelisted(toAsset), "To asset is not whitelisted");
        require(registry.isWhitelisted(collateralAssets[0].asset), "Collateral asset is not whitelisted");

        // Morpho only supports one collateral asset
        require(collateralAssets.length == 1, "Morpho supports only one collateral asset");
        require(collateralAssets[0].amount > 0, "Invalid collateral amount");

        (MarketParams memory marketParams, ) = abi.decode(extraData, (MarketParams, uint256));
        require(marketParams.loanToken == toAsset, "toAsset mismatch with marketParams in extraData");

        uint256 currentBalance = IERC20(collateralAssets[0].asset).balanceOf(address(this));
        require(currentBalance > 0, "No collateral balance available");

        IERC20(marketParams.collateralToken).forceApprove(address(morpho), currentBalance);
        morpho.supplyCollateral(marketParams, currentBalance, onBehalfOf, "");

        morpho.borrow(marketParams, amount, 0, onBehalfOf, address(this));
        IERC20(marketParams.collateralToken).forceApprove(address(morpho), 0);
    }

    function supply(address asset, uint256 amount, address onBehalfOf, bytes calldata extraData) external override onlyAuthorizedCaller(onBehalfOf) {
        require(registry.isWhitelisted(asset), "Asset is not whitelisted");

        (MarketParams memory marketParams, ) = abi.decode(extraData, (MarketParams, uint256));

        IERC20(asset).forceApprove(address(morpho), amount);
        morpho.supplyCollateral(marketParams, amount, onBehalfOf, "");
        IERC20(asset).forceApprove(address(morpho), 0);
    }

    function borrow(address asset, uint256 amount, address onBehalfOf, bytes calldata extraData) external override onlyAuthorizedCaller(onBehalfOf) {
        require(registry.isWhitelisted(asset), "Asset is not whitelisted");

        (MarketParams memory marketParams, ) = abi.decode(extraData, (MarketParams, uint256));

        morpho.borrow(marketParams, amount, 0, onBehalfOf, address(this));
    }

    function repay(address asset, uint256 amount, address onBehalfOf, bytes calldata extraData) public onlyAuthorizedCaller(onBehalfOf) {
        require(registry.isWhitelisted(asset), "Asset is not whitelisted");

        (MarketParams memory marketParams, uint256 borrowShares) = abi.decode(extraData, (MarketParams, uint256));

        uint256 approvalAmount;
        if (borrowShares > 0) {
            // Calculate exact amount needed from shares with 20% buffer
            // https://docs.morpho.org/build/borrow/concepts/market-mechanics#full-repayment-shares-first
            Id marketId = marketParams.id();
            Market memory m = morpho.market(marketId);
            approvalAmount = borrowShares.toAssetsUp(m.totalBorrowAssets, m.totalBorrowShares) * 120 / 100;
        } else {
            approvalAmount = amount;
        }

        IERC20(asset).forceApprove(address(morpho), approvalAmount);

        // If borrowShares > 0, repay by shares (for full repayment), otherwise repay by amount
        if (borrowShares > 0) {
            morpho.repay(marketParams, 0, borrowShares, onBehalfOf, "");
        } else {
            morpho.repay(marketParams, amount, 0, onBehalfOf, "");
        }

        IERC20(asset).forceApprove(address(morpho), 0);
    }

    function withdraw(address asset, uint256 amount, address onBehalfOf, bytes calldata extraData) external override onlyAuthorizedCaller(onBehalfOf) {
        require(registry.isWhitelisted(asset), "Asset is not whitelisted");

        // Decode market parameters from extraData
        (MarketParams memory marketParams, ) = abi.decode(extraData, (MarketParams, uint256));

        uint256 withdrawAmount = amount;
        if (amount == type(uint256).max) {
            withdrawAmount = _calculateMaxWithdrawAmount(marketParams, onBehalfOf);
            require(withdrawAmount > 0, "No collateral available to withdraw");
        }

        // Withdraw collateral from user's position to this contract
        morpho.withdrawCollateral(marketParams, withdrawAmount, onBehalfOf, address(this));
    }

    function _calculateMaxWithdrawAmount(
        MarketParams memory marketParams,
        address user
    ) internal view returns (uint256) {
        Id marketId = marketParams.id();
        Position memory pos = morpho.position(marketId, user);
        uint256 collateral = uint256(pos.collateral);

        if (collateral == 0) return 0;

        Market memory m = morpho.market(marketId);
        uint256 borrowed = uint256(pos.borrowShares).toAssetsUp(m.totalBorrowAssets, m.totalBorrowShares);

        if (borrowed == 0) return collateral;

        uint256 oraclePrice = IMorphoOracle(marketParams.oracle).price();
        uint256 lltv = marketParams.lltv;

        if (oraclePrice == 0 || lltv == 0) return 0;

        // Morpho health: collateral * oraclePrice / 1e36 * lltv / 1e18 >= borrowed
        // Split calculation to avoid overflow
        uint256 step1 = (borrowed * 1e36 + oraclePrice - 1) / oraclePrice;
        uint256 minCollateral = (step1 * 1e18 + lltv - 1) / lltv;

        if (collateral <= minCollateral) return 0;

        uint256 maxWithdraw = collateral - minCollateral;
        // Apply 0.1% safety margin
        maxWithdraw = (maxWithdraw * 999) / 1000;
        return maxWithdraw;
    }
}
