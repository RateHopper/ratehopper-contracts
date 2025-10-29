// SPDX-License-Identifier: MIT
pragma solidity =0.8.28;

/**
 * @title Logger
 * @notice Logger contract for emitting rate arbitrage position events in Safe wallet batch transactions
 * @dev This contract can be included in Safe multi-sig batch transactions to emit tracking events
 */
contract Logger {
    event CreateRateArbitragePosition(
        address indexed user,
        address indexed collateralAsset,
        address indexed debtAsset,
        uint8 borrowProtocol,
        address borrowMarketId,
        uint256 collateralAmount,
        uint256 debtAmount,
        address supplyVault
    );

    event CloseRateArbitragePosition(
        address indexed user,
        address indexed collateralAsset,
        address indexed debtAsset,
        uint8 borrowProtocol,
        address borrowMarketId,
        uint256 collateralAmount,
        uint256 debtAmount,
        address supplyVault
    );

    /**
     * @notice Log rate arbitrage position creation
     * @param collateralAsset The collateral asset address
     * @param debtAsset The debt asset address
     * @param borrowProtocol The borrowProtocol ID (0: AAVE_V3, 1: COMPOUND, 2: MORPHO, 3: FLUID, 4: MOONWELL)
     * @param borrowMarketId The market/vault address where debt is borrowed
     * @param collateralAmount The collateral amount supplied
     * @param debtAmount The debt amount borrowed
     * @param supplyVault The vault/pool address where collateral is supplied
     */
    function logCreateRateArbitragePosition(
        address collateralAsset,
        address debtAsset,
        uint8 borrowProtocol,
        address borrowMarketId,
        uint256 collateralAmount,
        uint256 debtAmount,
        address supplyVault
    ) external {
        emit CreateRateArbitragePosition(
            msg.sender,
            collateralAsset,
            debtAsset,
            borrowProtocol,
            borrowMarketId,
            collateralAmount,
            debtAmount,
            supplyVault
        );
    }

    /**
     * @notice Log rate arbitrage position close
     * @param collateralAsset The collateral asset address
     * @param debtAsset The debt asset address
     * @param borrowProtocol The borrowProtocol ID (0: AAVE_V3, 1: COMPOUND, 2: MORPHO, 3: FLUID, 4: MOONWELL)
     * @param borrowMarketId The market/vault address where debt was borrowed
     * @param collateralAmount The collateral amount withdrawn
     * @param debtAmount The debt amount repaid
     * @param supplyVault The vault/pool address where collateral was supplied
     */
    function logCloseRateArbitragePosition(
        address collateralAsset,
        address debtAsset,
        uint8 borrowProtocol,
        address borrowMarketId,
        uint256 collateralAmount,
        uint256 debtAmount,
        address supplyVault
    ) external {
        emit CloseRateArbitragePosition(
            msg.sender,
            collateralAsset,
            debtAsset,
            borrowProtocol,
            borrowMarketId,
            collateralAmount,
            debtAmount,
            supplyVault
        );
    }
}
