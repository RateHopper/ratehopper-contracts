// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.5.0;

/**
 * @dev Simplified Aerodrome Slipstream `CLPool` interface — only the surface
 *      this repo uses.
 *
 *      The load-bearing difference from `IUniswapV3Pool` is `slot0`: Slipstream
 *      drops the `feeProtocol` field, so the tuple is one element shorter.
 *      Decoding it with the Uniswap layout would mis-read `unlocked` as
 *      `feeProtocol` and revert / misbehave.
 *
 *      Canonical implementation:
 *        https://github.com/aerodrome-finance/slipstream/blob/main/contracts/core/CLPool.sol
 */
interface ICLPool {
    /// @notice The contract address of token0.
    function token0() external view returns (address);

    /// @notice The contract address of token1.
    function token1() external view returns (address);

    /// @notice The current price + tick of the pool, packed for gas efficiency.
    /// @dev Note the absence of Uniswap V3's `feeProtocol` field.
    /// @return sqrtPriceX96 The current price of the pool as a Q64.96 sqrt(token1/token0).
    /// @return tick The current tick of the pool.
    /// @return observationIndex The index of the last observation.
    /// @return observationCardinality The current maximum number of observations stored.
    /// @return observationCardinalityNext The next maximum number of observations to be written.
    /// @return unlocked Whether the pool is currently locked to reentrancy.
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            bool unlocked
        );

    /// @notice The currently in-range liquidity available to the pool.
    function liquidity() external view returns (uint128);

    /// @notice The pool tick spacing (the pool's identity key in Slipstream).
    function tickSpacing() external view returns (int24);

    /// @notice The pool's CURRENT swap fee in pips (millionths). Dynamic and
    ///         set per-pool by a fee module — never assume a fixed tier.
    function fee() external view returns (uint24);
}
