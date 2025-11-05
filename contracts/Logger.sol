// SPDX-License-Identifier: MIT
pragma solidity =0.8.28;

/**
 * @title Logger
 * @notice Logger contract for emitting agent position events in Safe wallet batch transactions
 * @dev This contract can be included in Safe multi-sig batch transactions to emit tracking events
 */
contract Logger {
    event CreateAgentPosition(
        uint8 strategyType,
        address indexed user,
        address indexed collateralAsset,
        address indexed debtAsset,
        uint8 borrowProtocol,
        address borrowMarketId,
        uint256 collateralAmount,
        uint256 debtAmount,
        address additionalInteractionContract,
        bytes customData
    );

    event CloseAgentPosition(
        uint8 strategyType,
        address indexed user,
        address indexed collateralAsset,
        address indexed debtAsset,
        uint8 borrowProtocol,
        address borrowMarketId,
        uint256 collateralAmount,
        uint256 debtAmount,
        address additionalInteractionContract,
        bytes customData
    );

    /**
     * @notice Log agent position creation
     * @param strategyType The strategy type (0: rate arbitrage, 1: custom, etc)
     * @param collateralAsset The collateral asset address
     * @param debtAsset The debt asset address
     * @param borrowProtocol The borrowProtocol ID (0: AAVE_V3, 1: COMPOUND, 2: MORPHO, 3: FLUID, 4: MOONWELL)
     * @param borrowMarketId The market/vault address where debt is borrowed
     * @param collateralAmount The collateral amount supplied
     * @param debtAmount The debt amount borrowed
     * @param additionalInteractionContract Additional contract address for interaction
     * @param customData Arbitrary additional data for strategy-specific information
     */
    function logCreateAgentPosition(
        uint8 strategyType,
        address collateralAsset,
        address debtAsset,
        uint8 borrowProtocol,
        address borrowMarketId,
        uint256 collateralAmount,
        uint256 debtAmount,
        address additionalInteractionContract,
        bytes calldata customData
    ) external {
        emit CreateAgentPosition(
            strategyType,
            msg.sender,
            collateralAsset,
            debtAsset,
            borrowProtocol,
            borrowMarketId,
            collateralAmount,
            debtAmount,
            additionalInteractionContract,
            customData
        );
    }

    /**
     * @notice Log agent position close
     * @param strategyType The strategy type (0: rate arbitrage, 1: custom, etc)
     * @param collateralAsset The collateral asset address
     * @param debtAsset The debt asset address
     * @param borrowProtocol The borrowProtocol ID (0: AAVE_V3, 1: COMPOUND, 2: MORPHO, 3: FLUID, 4: MOONWELL)
     * @param borrowMarketId The market/vault address where debt was borrowed
     * @param collateralAmount The collateral amount withdrawn
     * @param debtAmount The debt amount repaid
     * @param additionalInteractionContract Additional contract address for interaction
     * @param customData Arbitrary additional data for strategy-specific information
     */
    function logCloseAgentPosition(
        uint8 strategyType,
        address collateralAsset,
        address debtAsset,
        uint8 borrowProtocol,
        address borrowMarketId,
        uint256 collateralAmount,
        uint256 debtAmount,
        address additionalInteractionContract,
        bytes calldata customData
    ) external {
        emit CloseAgentPosition(
            strategyType,
            msg.sender,
            collateralAsset,
            debtAsset,
            borrowProtocol,
            borrowMarketId,
            collateralAmount,
            debtAmount,
            additionalInteractionContract,
            customData
        );
    }
}
