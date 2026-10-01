// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {TwapOracle} from "./TwapOracle.sol";
import {TwapConfig} from "../../common/Types.sol";

/// @title MintPriceGuard
/// @notice Refuses to add liquidity to a pool whose spot price has been pushed
///         away from the reference TWAP.
/// @dev    The swap legs are floored by the reference TWAP, but a mint trades at
///         the pool's own spot price, and its only native protection is the
///         caller's amount minimums. A caller that controls those minimums and
///         the tick range can mint a Safe's funds into a pool whose price it has
///         just pushed, then trade the price back through the Safe's range. This
///         guard bounds that loss to `maxDeviationTicks` (one tick is ~1 bp)
///         regardless of what the caller supplies.
///
///         The expected pool tick is derived from the per-token references the
///         manager already requires for every allow-listed pool: with `t(X)` the
///         reference tick of "USDC per X" (zero for USDC itself), a pool whose
///         price is token1 per token0 sits at `t(token0) - t(token1)`. Raw token
///         units are used on both sides, so decimals cancel.
library MintPriceGuard {
    error MintPriceDeviation(int24 spotTick, int24 referenceTick, uint24 maxDeviationTicks);

    /// @param cfg0     Reference for token0 (ignored when token0 is USDC).
    /// @param ref0     ERC20 the token0 reference pool trades against USDC
    ///                 (WETH for a native-ETH side).
    /// @param cfg1     Reference for token1 (ignored when token1 is USDC).
    /// @param ref1     ERC20 the token1 reference pool trades against USDC.
    /// @param usdc     USDC address.
    /// @param spotSqrtPriceX96 Pool spot price the mint will execute at.
    /// @param maxDeviationTicks Largest allowed |spot - reference| in ticks.
    function requireNearReference(
        TwapConfig memory cfg0,
        address ref0,
        TwapConfig memory cfg1,
        address ref1,
        address usdc,
        uint160 spotSqrtPriceX96,
        uint24 maxDeviationTicks
    ) internal view {
        int256 expected = _usdcPerTokenTick(cfg0, ref0, usdc) - _usdcPerTokenTick(cfg1, ref1, usdc);
        int256 spot = int256(TickMath.getTickAtSqrtPrice(spotSqrtPriceX96));
        int256 diff = spot > expected ? spot - expected : expected - spot;
        if (diff > int256(uint256(maxDeviationTicks))) {
            revert MintPriceDeviation(int24(spot), _clampTick(expected), maxDeviationTicks);
        }
    }

    /// @dev Reference tick of "USDC per `referenceToken`". A reference pool is
    ///      sorted by address, so its tick is USDC-per-token only when the token
    ///      sorts first; otherwise it is the inverse.
    function _usdcPerTokenTick(
        TwapConfig memory cfg,
        address referenceToken,
        address usdc
    ) private view returns (int256) {
        if (referenceToken == usdc) return 0;
        if (cfg.pool == address(0)) revert TwapOracle.TwapNotConfigured(referenceToken);
        int256 tick = int256(TwapOracle.meanTick(cfg));
        return referenceToken < usdc ? tick : -tick;
    }

    function _clampTick(int256 tick) private pure returns (int24) {
        if (tick > TickMath.MAX_TICK) return TickMath.MAX_TICK;
        if (tick < TickMath.MIN_TICK) return TickMath.MIN_TICK;
        return int24(tick);
    }
}
