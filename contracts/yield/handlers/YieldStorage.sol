// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "../../common/Types.sol";

/// @title YieldStorage
/// @notice ERC-7201 namespaced storage shared by SafeYieldManager and its
///         delegatecalled yield handlers, plus the events/errors both sides
///         emit. Handlers MUST NOT declare regular storage variables — all
///         mutable state they touch lives in this namespaced struct, so the
///         manager's inherited storage (AccessControl, ReentrancyGuard,
///         Pausable, manager-local mappings) can never collide with handler
///         code regardless of inheritance order.
abstract contract YieldStorage {
    /// @custom:storage-location erc7201:ratehopper.storage.yield
    struct YieldLayout {
        address treasury;
        uint16 performanceFeeBps;
        uint16 feeCollectBps;
        /// @dev Ceiling on caller-supplied `slippageBps`.
        uint16 maxSlippageBps;
        /// @dev Remaining USDC cost basis per (protocol id, tokenId). Zero
        ///      means unmanaged or fully closed. Keyed by protocol because
        ///      tokenIds from different position managers can collide.
        ///      Protocol ids are plain uint8 (not a Solidity enum) so new
        ///      protocols can be registered on the deployed manager without
        ///      a redeploy; the YIELD_PROTOCOL_* constants in Types.sol
        ///      document the canonical ids.
        mapping(uint8 protocolId => mapping(uint256 tokenId => uint128)) residualBasisUsd6Of;
        /// @dev Allow-list of pool parameters, keyed by keccak256 of the
        ///      ABI-encoded protocol-specific pool param (feeTier /
        ///      tickSpacing / future V4 PoolKey). Generic on purpose so new
        ///      protocols need no new storage.
        mapping(uint8 protocolId => mapping(bytes32 poolKey => bool)) allowedPoolKey;
        /// @dev Minimum pool liquidity for spot-price reads. Zero disables.
        mapping(uint8 protocolId => uint128) minPoolLiquidity;
        /// @dev Minimum liquidity returned by NPM mint. Zero disables.
        mapping(uint8 protocolId => uint128) minPositionLiquidity;
        /// @dev Handler pinned at openLp per position. close/collect always
        ///      run through this address so `setYieldHandler` never applies
        ///      retroactively to positions opened under an older handler.
        ///      Deleted on full close together with the basis.
        mapping(uint8 protocolId => mapping(uint256 tokenId => address)) positionHandlerOf;
        /// @dev Aerodrome stake pool pinned when a position is staked. The
        ///      Voter mapping is governance-controlled and may rotate later;
        ///      exits must use the pool that actually owns the NFT.
        mapping(uint8 protocolId => mapping(uint256 tokenId => address)) stakePoolOf;
        /// @dev Reference price source per token, keyed by the NON-USDC side of
        ///      the pair. Not keyed by protocol: the reference is the token's
        ///      price, not a venue, so an Aerodrome or Uniswap V4 swap is
        ///      floored by the same Uniswap V3 observation history. Native ETH
        ///      is keyed by address(0), with a WETH/USDC reference pool.
        mapping(address token => TwapConfig) twapConfigOf;
        /// @dev Profit already taken OUT of a position but not yet charged a
        ///      performance fee, in USDC 6dp. An in-kind switch redeploys only
        ///      what the destination range can consume; the rest lands on the
        ///      Safe. That residue first repays cost basis, and anything beyond
        ///      the basis is realized profit the eventual `closeLp` would
        ///      otherwise never see — measured at 2.75%-9.55% of the token0
        ///      side on Base, so it is not roundable away. Carried onto the
        ///      replacement position and prorated on partial exits exactly
        ///      like the basis it mirrors.
        mapping(uint8 protocolId => mapping(uint256 tokenId => uint128)) carryProfitUsd6Of;
        /// @dev Enumerable copy of the active allow-list. Appended after all
        ///      pre-existing fields to preserve the namespaced storage layout.
        ///      The manager uses it when a pauser re-enables a protocol to
        ///      prove every pool pair still has a live price reference.
        mapping(uint8 protocolId => bytes[]) allowedPoolParams;
        /// @dev One-based index into `allowedPoolParams`; zero means absent.
        mapping(uint8 protocolId => mapping(bytes32 poolKey => uint256)) allowedPoolParamIndexPlusOne;
    }

    // keccak256(abi.encode(uint256(keccak256("ratehopper.storage.yield")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant YIELD_STORAGE_SLOT = 0x53ba738b9a2829dfda910cf4e864fcd3f84e03854b49244f3d159a473ee6a400;

    function _yieldStorage() internal pure returns (YieldLayout storage $) {
        assembly ("memory-safe") {
            $.slot := YIELD_STORAGE_SLOT
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Shared events (emitted by the manager and, via delegatecall, by
    //  handlers — always from the manager's address)
    // ─────────────────────────────────────────────────────────────────────

    event PositionOpened(
        address indexed onBehalfOf,
        uint8 indexed protocol,
        uint256 indexed tokenId,
        uint256 usdcInput,
        uint128 amount0ToLp,
        uint128 amount1ToLp,
        uint128 currentValueUsd6
    );
    event PositionSwitched(
        address indexed onBehalfOf,
        uint8 indexed fromProtocol,
        uint8 indexed toProtocol,
        uint256 oldTokenId,
        uint256 newTokenId,
        uint128 carriedBasisUsd6,
        uint256 withdrawn0,
        uint256 withdrawn1,
        uint128 used0,
        uint128 used1
    );
    /// @dev `carryForExitUsd6` is the share of previously-withdrawn switch
    ///      residue this exit accounts for. The fee is charged on
    ///      `currentValueUsd6 + carryForExitUsd6 - basisUsd6`, so without this
    ///      field the emitted numbers would not explain the emitted fee.
    event PositionClosed(
        address indexed onBehalfOf,
        uint8 indexed protocol,
        uint256 indexed tokenId,
        uint128 basisUsd6,
        uint128 currentValueUsd6,
        uint128 feeUsd6,
        uint16 exitBps,
        uint128 carryForExitUsd6
    );
    event FeesCollected(
        address indexed onBehalfOf,
        uint8 indexed protocol,
        uint256 indexed tokenId,
        address token0,
        uint256 collected0,
        uint256 fee0,
        address token1,
        uint256 collected1,
        uint256 fee1
    );
    /// @notice A stake-pool emission claim credited to the Safe, with the
    ///         collect fee actually paid on it. Emitted wherever a claim can
    ///         happen: an explicit collect, and the gauge withdrawal a close or
    ///         switch performs. `feePaid` is zero when the fee rounded to zero
    ///         or the treasury transfer failed (see CollectFeeTransferFailed).
    event StakedRewardCollected(
        address indexed onBehalfOf,
        uint8 indexed protocol,
        uint256 indexed tokenId,
        address rewardToken,
        uint256 grossReward,
        uint256 feePaid
    );
    event FeeTransferFailed(address indexed onBehalfOf, uint256 indexed tokenId, uint128 feeUsd6);
    event CollectFeeTransferFailed(
        address indexed onBehalfOf,
        uint256 indexed tokenId,
        address indexed token,
        uint256 attemptedFee
    );
    event TwapConfigUpdated(address indexed token, address indexed pool, uint32 window, uint16 minCardinality);
    /// @notice Residue an in-kind switch left on the Safe, valued at the
    ///         reference TWAP, and the basis/carry it produced.
    event SwitchResidueSettled(
        address indexed onBehalfOf,
        uint8 indexed protocol,
        uint256 indexed newTokenId,
        uint256 residual0,
        uint256 residual1,
        uint128 residualUsd6,
        uint128 newBasisUsd6,
        uint128 newCarryUsd6
    );
    /// @notice An in-kind exit: liquidity out, no swap, no price reference.
    /// @dev    No PERFORMANCE fee is taken — `feeCollectBps` still applies to
    ///         the fees harvested on the way out, exactly as it does on every
    ///         other harvest. `releasedCarryUsd6` is switch residue `closeLp`
    ///         would have charged a performance fee on and this path does not,
    ///         reported so that waiver is visible rather than silent.
    event PositionWithdrawn(
        address indexed onBehalfOf,
        uint8 indexed protocol,
        uint256 indexed tokenId,
        uint128 releasedBasisUsd6,
        uint128 releasedCarryUsd6,
        uint256 amount0,
        uint256 amount1
    );

    // ─────────────────────────────────────────────────────────────────────
    //  Shared errors
    // ─────────────────────────────────────────────────────────────────────

    error InvalidTreasury();
    error FeeAboveMax();
    error SwapFailed();
    error ZeroAddress();
    error InvalidUsdcAmount();
    error InvalidExitBps();
    error SlippageAboveMax();
    error PoolParamNotAllowed();
    error UnknownPosition();
    error ModuleCallFailed(uint8 step);
    error LpNotOnSafe();
    error WrongTokenPair();
    error NotAuthorized();
    error DeadlineExpired();
    error PoolDoesNotExist();
    error PoolNotInitialized();
    error PoolTooThin();
    error MinUsdcOutNotMet();
    error SlippageTooLow();
    error InvalidSwapAmountOutMin();
    error OnlyTimelock();
    error PositionLiquidityTooLow();
    error TwapWindowTooShort();
    error TwapCardinalityBelowFloor();
    error TwapPoolPairMismatch();
    error InvalidTwapReferencePool(address pool);
    error TwapReferenceRemovalNotAllowed(address token);
}
