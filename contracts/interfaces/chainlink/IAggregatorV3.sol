// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal surface of a Chainlink AggregatorV3 feed. Only `decimals`
///         and `latestRoundData` are read; `answeredInRound` is deprecated and
///         must not be used for staleness (Spark's Chainlink-format wrapper
///         reports `roundId == 0`), so only `updatedAt` governs age.
interface IAggregatorV3 {
    function decimals() external view returns (uint8);

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
