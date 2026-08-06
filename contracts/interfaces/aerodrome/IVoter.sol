// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/// @notice Minimal Aerodrome Voter surface: the canonical pool -> gauge
///         registry. `gauges(pool)` returns the CL gauge a Slipstream pool's
///         LP positions can be staked into, or `address(0)` when the pool has
///         no gauge.
interface IVoter {
    function gauges(address pool) external view returns (address gauge);
}
