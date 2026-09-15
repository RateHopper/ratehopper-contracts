// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.5.0;

/**
 * @dev Simplified Aerodrome Slipstream `CLFactory` interface — only the
 *      pool-lookup surface this repo uses.
 *
 *      The load-bearing difference from Uniswap V3's factory is the pool key:
 *      Slipstream pools are identified by `(token0, token1, int24 tickSpacing)`
 *      rather than `(token0, token1, uint24 fee)`. The swap fee is decoupled
 *      from the key and set per-pool by a fee module, so it is NOT part of the
 *      lookup.
 *
 *      Canonical implementation:
 *        https://github.com/aerodrome-finance/slipstream/blob/main/contracts/core/CLFactory.sol
 */
interface ICLFactory {
    /// @notice Returns the pool address for a token pair and tick spacing, or
    ///         address(0) if it doesn't exist.
    /// @dev tokenA and tokenB may be passed in either token0/token1 order.
    /// @param tokenA The contract address of either token0 or token1.
    /// @param tokenB The contract address of the other token.
    /// @param tickSpacing The tick spacing that keys the pool (e.g. 100, 200).
    /// @return pool The pool address.
    function getPool(address tokenA, address tokenB, int24 tickSpacing) external view returns (address pool);
}
