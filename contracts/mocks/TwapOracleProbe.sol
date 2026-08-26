// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {TwapOracle} from "../yield/libraries/TwapOracle.sol";
import "../common/Types.sol";

/// @notice Test-only window onto TwapOracle. The library is reached in
///         production only through a delegatecalled handler mid-swap, which is
///         a poor place to assert on a price; this exposes it directly so each
///         degradation (thin history, a stale newest observation, a window the
///         pool cannot cover) can be driven on its own.
contract TwapOracleProbe {
    function meanTick(address pool, uint32 window, uint16 minCardinality) external view returns (int24) {
        return TwapOracle.meanTick(TwapConfig({pool: pool, window: window, minCardinality: minCardinality}));
    }

    function quote(
        address pool,
        uint32 window,
        uint16 minCardinality,
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) external view returns (uint256) {
        return
            TwapOracle.quote(
                TwapConfig({pool: pool, window: window, minCardinality: minCardinality}),
                tokenIn,
                tokenOut,
                amountIn
            );
    }

    function maxStalenessDivisor() external pure returns (uint32) {
        return TwapOracle.MAX_STALENESS_DIVISOR;
    }
}
