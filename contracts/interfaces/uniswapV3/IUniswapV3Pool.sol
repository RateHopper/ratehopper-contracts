// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.5.0;

/**
 * @dev Simplified IUniswapV3Pool interface — only the surface this repo uses.
 */
interface IUniswapV3Pool {
    /// @notice Receive token0 and/or token1 and pay it back, plus a fee, in the callback
    /// @dev The caller of this method receives a callback in the form of IUniswapV3FlashCallback#uniswapV3FlashCallback
    /// @dev Can be used to donate underlying tokens pro-rata to currently in-range liquidity providers by calling
    /// with 0 amount{0,1} and sending the donation amount(s) from the callback
    /// @param recipient The address which will receive the token0 and token1 amounts
    /// @param amount0 The amount of token0 to send
    /// @param amount1 The amount of token1 to send
    /// @param data Any data to be passed through to the callback
    function flash(
        address recipient,
        uint256 amount0,
        uint256 amount1,
        bytes calldata data
    ) external;

    /// @notice Returns the contract address of token0
    /// @return The address of token0
    function token0() external view returns (address);

    /// @notice The current price + tick of the pool, packed for gas efficiency.
    /// @return sqrtPriceX96 The current price of the pool as a Q64.96 sqrt(token1/token0).
    /// @return tick The current tick of the pool.
    /// @return observationIndex The index of the last observation.
    /// @return observationCardinality The current maximum number of observations stored.
    /// @return observationCardinalityNext The next maximum number of observations to be written.
    /// @return feeProtocol The protocol fee for both tokens of the pool (packed).
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
            uint8 feeProtocol,
            bool unlocked
        );

    /// @notice The currently in-range liquidity available to the pool.
    function liquidity() external view returns (uint128);
}
