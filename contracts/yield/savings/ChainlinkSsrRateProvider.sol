// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAggregatorV3} from "../../interfaces/chainlink/IAggregatorV3.sol";
import {ISSRRateProvider} from "../../interfaces/spark/ISSRRateProvider.sol";
import {ISavingsRateProvider} from "../../interfaces/ISavingsRateProvider.sol";

/// @title ChainlinkSsrRateProvider
/// @notice Price source for sUSDS: the Chainlink "sUSDS / USDS Exchange Rate"
///         feed on Base (18 decimals, 24h heartbeat), vetoed by Spark's SSR
///         oracle, the rate provider PSM3 itself prices with. The Chainlink
///         value is the floor input; the SSR value is a veto only. The
///         cross-check rejects `|chainlink - ssr| > ssr * MAX_DISAGREEMENT_BPS`
///         (the boundary passes); it does not make an agreeing pair right. A
///         single source wrong within that band passes, and two sources wrong
///         together pass whenever they still agree within it and the answer
///         stays inside `[1e18, MAX_RATE]` (inclusive), which is an absolute
///         range, not a bound on how fast the rate may move. PSM3 treats USDS
///         and USDC as 1:1, so USDS per sUSDS is also USDC per sUSDS.
/// @dev    Fails closed on every doubt: a non-positive answer, an answer
///         older than `MAX_FEED_AGE`, an answer outside [1e18, MAX_RATE], an
///         SSR oracle that answers zero or reverts, or a disagreement above
///         `MAX_DISAGREEMENT_BPS` all revert. The handler's `withdraw` reads
///         no price, so a reverting provider never strands a position.
///         `answeredInRound` is deprecated and `roundId` is zero on Spark's
///         Chainlink-format wrapper, so only `updatedAt` governs staleness.
///         Holds no state; replacing it is a handler rollover.
contract ChainlinkSsrRateProvider is ISavingsRateProvider {
    IAggregatorV3 public immutable FEED;
    ISSRRateProvider public immutable SSR_ORACLE;
    IERC20 public immutable SHARE_TOKEN;
    /// @notice Oldest `updatedAt` accepted, in seconds. The feed's heartbeat is
    ///         24h; 36h leaves a 12h margin for a late round.
    uint32 public immutable MAX_FEED_AGE;
    uint16 public immutable MAX_DISAGREEMENT_BPS;
    /// @notice Ceiling on the rate so a feed returning garbage fails closed. At
    ///         the 2026 SSR of about 3.7% the rate climbs from 1.11 to 2.0 in
    ///         roughly 16 years; redeploy with a higher bound well before the
    ///         live rate approaches it.
    uint256 public immutable MAX_RATE;

    uint256 private constant ONE = 1e18;
    /// @dev The SSR oracle answers at 27 decimals; the feed at 18.
    uint256 private constant SSR_TO_RATE_SCALE = 1e9;
    uint256 private constant BPS = 10_000;
    uint32 private constant MIN_FEED_AGE = 1 days;
    uint16 private constant MAX_SETTABLE_DISAGREEMENT_BPS = 300;

    error ZeroAddress();
    error InvalidConfig();
    error WrongFeedDecimals(uint8 decimals);
    error WrongShareToken(address token);
    error InvalidRate();
    error StaleRate(uint256 updatedAt);
    error RateOutOfBounds(uint256 rate);
    error OracleDisagreement(uint256 chainlinkRate, uint256 ssrRate);

    constructor(
        IAggregatorV3 _feed,
        ISSRRateProvider _ssrOracle,
        IERC20 _shareToken,
        uint32 _maxFeedAge,
        uint16 _maxDisagreementBps,
        uint256 _maxRate
    ) {
        if (address(_feed) == address(0)) revert ZeroAddress();
        if (address(_ssrOracle) == address(0)) revert ZeroAddress();
        if (address(_shareToken) == address(0)) revert ZeroAddress();
        uint8 feedDecimals = _feed.decimals();
        if (feedDecimals != 18) revert WrongFeedDecimals(feedDecimals);
        if (_maxFeedAge < MIN_FEED_AGE) revert InvalidConfig();
        if (_maxDisagreementBps == 0 || _maxDisagreementBps > MAX_SETTABLE_DISAGREEMENT_BPS) revert InvalidConfig();
        if (_maxRate <= ONE) revert InvalidConfig();

        FEED = _feed;
        SSR_ORACLE = _ssrOracle;
        SHARE_TOKEN = _shareToken;
        MAX_FEED_AGE = _maxFeedAge;
        MAX_DISAGREEMENT_BPS = _maxDisagreementBps;
        MAX_RATE = _maxRate;
    }

    /// @inheritdoc ISavingsRateProvider
    function rate(address token) external view returns (uint256 r) {
        if (token != address(SHARE_TOKEN)) revert WrongShareToken(token);
        (, int256 answer, , uint256 updatedAt, ) = FEED.latestRoundData();
        if (answer <= 0) revert InvalidRate();
        if (updatedAt == 0 || updatedAt > block.timestamp || block.timestamp - updatedAt > MAX_FEED_AGE) {
            revert StaleRate(updatedAt);
        }
        r = uint256(answer);
        if (r < ONE || r > MAX_RATE) revert RateOutOfBounds(r);

        uint256 ssrRate = SSR_ORACLE.getConversionRate() / SSR_TO_RATE_SCALE;
        if (ssrRate == 0) revert InvalidRate();
        uint256 diff = r > ssrRate ? r - ssrRate : ssrRate - r;
        if (diff * BPS > ssrRate * MAX_DISAGREEMENT_BPS) revert OracleDisagreement(r, ssrRate);
    }

    /// @inheritdoc ISavingsRateProvider
    function shareToken() external view returns (address) {
        return address(SHARE_TOKEN);
    }
}
