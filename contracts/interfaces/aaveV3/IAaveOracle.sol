// SPDX-License-Identifier: AGPL-3.0
pragma solidity =0.8.28;

interface IAaveOracle {
    /// @notice Returns the asset price in the pool's base currency
    function getAssetPrice(address asset) external view returns (uint256);
}
