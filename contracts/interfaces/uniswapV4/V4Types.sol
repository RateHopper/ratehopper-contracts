// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Uniswap V4 pool identifier. ABI-identical to v4-core's PoolKey
///         (whose `Currency`/`IHooks` fields are user-defined value types /
///         interfaces wrapping `address`), declared with plain addresses so
///         the repo needs no v4-core dependency. Native ETH is
///         `currency0 == address(0)`; currencies are sorted ascending, so a
///         native pool always has ETH on the currency0 side.
/// @dev    `keccak256(abi.encode(key))` IS the V4 PoolId — the same hash the
///         manager's `allowedPoolKey` allow-list stores for the ABI-encoded
///         pool param, so one allow-listed param pins exactly one pool.
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

/// @notice Exact-input single-hop swap params for the V4Router actions
///         decoded by the deployed UniversalRouter (deploy-era shape: no
///         sqrtPriceLimitX96, no per-hop slippage field).
struct ExactInputSingleParams {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 amountIn;
    uint128 amountOutMinimum;
    bytes hookData;
}
