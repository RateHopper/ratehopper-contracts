// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/// @notice Minimal Aerodrome Voter surface: the canonical pool -> stakePool
///         registry. `gauges(pool)` returns the stake pool a Slipstream pool's
///         LP positions can be staked into, or `address(0)` when the pool has
///         no stakePool. `isAlive(gauge)` is false once governance has killed
///         the gauge.
interface IVoter {
    function gauges(address pool) external view returns (address stakePool);

    function isAlive(address gauge) external view returns (bool);
}
