// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IIdleSavingsRateProvider} from "../yield/idleSavings/IIdleSavingsRateProvider.sol";

// ─────────────────────────────────────────────────────────────────────────
//  Mocks for the idle savings handler stack (BaseIdleSavingsHandler,
//  SkyIdleSavingsYieldHandler, ChainlinkSsrRateProvider) unit and invariant
//  suites. They let the full deposit / redeem / rollover lifecycle and every
//  defensive revert branch run deterministically without Base, PSM3 or the
//  live oracles. TEST-ONLY, never deployed.
// ─────────────────────────────────────────────────────────────────────────

/// @notice Chainlink AggregatorV3 stand-in. `answeredInRound` and `roundId`
///         are settable independently so the provider's "only updatedAt
///         governs staleness" rule can be proven.
contract MockAggregatorV3 {
    uint8 public decimals = 18;
    int256 public answer;
    uint256 public updatedAt;
    uint80 public roundId;
    uint80 public answeredInRound;
    bool public reverting;

    function set(int256 _answer, uint256 _updatedAt) external {
        answer = _answer;
        updatedAt = _updatedAt;
    }

    function setRound(uint80 _roundId, uint80 _answeredInRound) external {
        roundId = _roundId;
        answeredInRound = _answeredInRound;
    }

    function setDecimals(uint8 value) external {
        decimals = value;
    }

    function setReverting(bool value) external {
        reverting = value;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!reverting, "feed down");
        return (roundId, answer, updatedAt, updatedAt, answeredInRound);
    }
}

/// @notice Spark SSRAuthOracle stand-in: the 27-decimal conversion rate PSM3
///         prices with.
contract MockSSRRateProvider {
    uint256 public conversionRate;
    bool public reverting;

    function set(uint256 rate27) external {
        conversionRate = rate27;
    }

    function setReverting(bool value) external {
        reverting = value;
    }

    function getConversionRate() external view returns (uint256) {
        require(!reverting, "ssr down");
        return conversionRate;
    }
}

/// @notice Reads a provider inside a mined transaction so a test can pin the
///         block timestamp the staleness check sees.
contract MockRateProbe {
    event Rate(uint256 rate);

    function read(address provider, address token) external {
        emit Rate(IIdleSavingsRateProvider(provider).rate(token));
    }
}
