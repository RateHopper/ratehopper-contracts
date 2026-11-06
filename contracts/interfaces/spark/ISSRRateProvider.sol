// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal surface of Spark's SSRAuthOracle, the rate provider PSM3
///         prices sUSDS with. Only the conversion rate (USDS per sUSDS,
///         27 decimals) is read.
interface ISSRRateProvider {
    function getConversionRate() external view returns (uint256);
}
