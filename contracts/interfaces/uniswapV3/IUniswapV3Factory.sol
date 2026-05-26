// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.5.0;

/**
 * @dev Simplified Uniswap V3 factory interface — only the pool-lookup surface
 *      this repo uses (e.g. RatehopperUniV3Positions reads the swap pool's spot
 *      price for on-chain slippage computation).
 */
interface IUniswapV3Factory {
    /// @notice Returns the pool address for a given pair of tokens and a fee, or address(0) if it doesn't exist.
    /// @dev tokenA and tokenB may be passed in either token0/token1 order.
    /// @param tokenA The contract address of either token0 or token1.
    /// @param tokenB The contract address of the other token.
    /// @param fee The fee tier of the pool (in hundredths of a basis point — e.g. 500 = 0.05%).
    /// @return pool The pool address.
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}
