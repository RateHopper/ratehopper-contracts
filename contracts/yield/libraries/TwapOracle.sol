// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IUniswapV3Pool} from "../../interfaces/uniswapV3/IUniswapV3Pool.sol";
import "../../common/Types.sol";

/// @title TwapOracle
/// @notice Manipulation-resistant token/USDC quotes from a Uniswap V3 pool's
///         observation history.
/// @dev    Used as the floor under every router call in the yield handlers.
///         Callers supply `amountOutMin`; this library answers "what is that
///         amount actually worth", so a caller can no longer certify its own
///         expectation.
///
///         Fail-closed everywhere. There is no fallback to `slot0` when the
///         history is unusable: a fallback IS the attack, because an attacker
///         who can degrade the oracle would choose the degraded path.
library TwapOracle {
    error TwapNotConfigured(address token);
    error TwapCardinalityTooLow(address pool, uint16 have, uint16 need);
    error TwapObservationStale(address pool, uint32 age, uint32 maxAge);
    error TwapWindowZero();

    /// @dev Rejects an ABANDONED reference. `observe` values the span from the
    ///      newest observation to `now` at the live tick, so a pool nobody has
    ///      traded reports its last tick no matter how far the market has moved
    ///      since. That is the loss case: a reference stuck BELOW the true
    ///      price lets a swap clear a floor beneath what the input is worth.
    ///
    ///      It is deliberately not framed as manipulation resistance. Moving a
    ///      pool's tick writes an observation carrying the PRE-move tick, so an
    ///      attacker's own trade contributes nothing to the average in that
    ///      block and only ~one block per block afterwards. Freshness is about
    ///      the price being current, not about who moved it.
    ///
    ///      This is also the check a bare `observe()` call cannot replace. A
    ///      pool with `observationCardinality == 1` that has been idle longer
    ///      than the window does NOT revert: every point in the window resolves
    ///      after its single stored observation, so the "average" collapses to
    ///      exactly the current tick, and the call looks perfectly healthy.
    ///      Measured on Base at block 50197687: the Aerodrome WETH/USDC
    ///      tickSpacing-200 pool, and three Uniswap V3 AERO pools (one of them
    ///      holding zero liquidity), all sit at cardinality 1 and answer a
    ///      1800-second query without reverting.
    uint32 internal constant MAX_STALENESS_DIVISOR = 4;

    /// @notice USDC-denominated value of `amountIn` of `tokenIn`, or the
    ///         token-denominated value of USDC when swapping the other way.
    /// @param cfg      Reference pool for the non-USDC side of the pair.
    /// @param tokenIn  Token being sold.
    /// @param tokenOut Token being bought.
    /// @param amountIn Amount of `tokenIn` being sold.
    function quote(
        TwapConfig memory cfg,
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) internal view returns (uint256 amountOut) {
        return _quoteAtTick(meanTick(cfg), amountIn, tokenIn, tokenOut);
    }

    /// @notice Arithmetic mean tick of `cfg.pool` over `cfg.window`.
    /// @dev    Reverts unless the window is genuinely backed by history.
    function meanTick(TwapConfig memory cfg) internal view returns (int24) {
        if (cfg.pool == address(0)) revert TwapNotConfigured(cfg.pool);
        if (cfg.window == 0) revert TwapWindowZero();

        IUniswapV3Pool pool = IUniswapV3Pool(cfg.pool);
        (, , uint16 observationIndex, uint16 observationCardinality, , , ) = pool.slot0();
        if (observationCardinality < cfg.minCardinality) {
            revert TwapCardinalityTooLow(cfg.pool, observationCardinality, cfg.minCardinality);
        }

        (uint32 newestTimestamp, , , ) = pool.observations(observationIndex);
        uint32 age = uint32(block.timestamp) - newestTimestamp;
        uint32 maxAge = cfg.window / MAX_STALENESS_DIVISOR;
        if (age > maxAge) revert TwapObservationStale(cfg.pool, age, maxAge);

        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = cfg.window;
        secondsAgos[1] = 0;
        // Reverts `OLD` when the window predates the oldest observation. Left
        // to propagate on purpose — that is the fail-closed path.
        (int56[] memory tickCumulatives, ) = pool.observe(secondsAgos);

        int56 delta = tickCumulatives[1] - tickCumulatives[0];
        int56 window = int56(uint56(cfg.window));
        int24 tick = int24(delta / window);
        // Round toward negative infinity, matching Uniswap's OracleLibrary, so
        // the mean never rounds in favour of the side being quoted.
        if (delta < 0 && delta % window != 0) tick--;
        return tick;
    }

    /// @dev Port of Uniswap's `OracleLibrary.getQuoteAtTick`. The two branches
    ///      exist because `sqrtPriceX96 ** 2` overflows 256 bits once the price
    ///      is high enough; above that threshold the ratio is carried in Q128
    ///      instead of Q192.
    function _quoteAtTick(
        int24 tick,
        uint256 amountIn,
        address baseToken,
        address quoteToken
    ) private pure returns (uint256 quoteAmount) {
        uint160 sqrtPriceX96 = TickMath.getSqrtPriceAtTick(tick);
        if (sqrtPriceX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtPriceX96) * sqrtPriceX96;
            quoteAmount = baseToken < quoteToken
                ? Math.mulDiv(ratioX192, amountIn, 1 << 192)
                : Math.mulDiv(1 << 192, amountIn, ratioX192);
        } else {
            uint256 ratioX128 = Math.mulDiv(sqrtPriceX96, sqrtPriceX96, 1 << 64);
            quoteAmount = baseToken < quoteToken
                ? Math.mulDiv(ratioX128, amountIn, 1 << 128)
                : Math.mulDiv(1 << 128, amountIn, ratioX128);
        }
    }
}
