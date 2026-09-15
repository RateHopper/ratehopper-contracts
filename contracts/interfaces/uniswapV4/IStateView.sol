// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal surface of the Uniswap V4 StateView lens. V4 pools live
///         inside the singleton PoolManager and have no per-pool contract;
///         all state reads are keyed by PoolId = keccak256(abi.encode(PoolKey)).
interface IStateView {
    function getSlot0(
        bytes32 poolId
    ) external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);

    function getLiquidity(bytes32 poolId) external view returns (uint128 liquidity);
}
