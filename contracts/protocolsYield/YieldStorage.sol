// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "../Types.sol";

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
    }

    // ERC-7201 namespaced storage shared by SafeYieldManager and handlers
    // executed via delegatecall. The fixed, isolated slot prevents collisions
    // with inherited Manager storage while keeping all handlers on one layout.
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
        uint128 wethToLp,
        uint128 usdcToLp,
        uint128 currentValueUsd6
    );
    event PositionClosed(
        address indexed onBehalfOf,
        uint8 indexed protocol,
        uint256 indexed tokenId,
        uint128 basisUsd6,
        uint128 currentValueUsd6,
        uint128 feeUsd6,
        uint16 exitBps
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
        uint256 fee1,
        uint128 currentValueUsd6
    );
    event FeeTransferFailed(address indexed onBehalfOf, uint256 indexed tokenId, uint128 feeUsd6);
    event CollectFeeTransferFailed(
        address indexed onBehalfOf,
        uint256 indexed tokenId,
        address indexed token,
        uint256 attemptedFee
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
    error SwapMinBelowSlippageFloor();
    error InvalidExpectedSwapOut();
}
