// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {ISafe} from "../interfaces/safe/ISafe.sol";
import {IProtocolRegistry} from "../interfaces/IProtocolRegistry.sol";
import {IYieldHandler, OpenLpParams, CloseLpParams, CollectLpParams, WithdrawLpParams, OpenLpInKindParams} from "../interfaces/IYieldHandler.sol";
import {TokenReturnLib} from "./libraries/TokenReturnLib.sol";
import {YieldStorage} from "./handlers/YieldStorage.sol";
import "../common/Types.sol";

interface ITimelockControllerLike {
    function getMinDelay() external view returns (uint256);
}

/// @notice Parameters for atomically moving a full position to another pool
///         of the SAME token pair (different protocol, fee tier / tick
///         spacing, or any mix). The move is IN KIND: the withdraw leg's
///         token amounts become the open leg's input directly — no swaps, so
///         the only price protection is the decrease minimums (withdraw leg)
///         and the mint minimums (open leg).
struct SwitchLpParams {
    address onBehalfOf;
    uint256 tokenId;
    // withdraw leg (always a full exit)
    uint256 decreaseAmount0Min;
    uint256 decreaseAmount1Min;
    // open leg
    int24 tickLower;
    int24 tickUpper;
    uint256 mintAmount0Min;
    uint256 mintAmount1Min;
    bytes lpPoolParam;
    uint256 deadline;
}

/// @title SafeYieldManager
/// @notice Single Safe-module entry point for all yield (LP) protocols —
///         the yield-side counterpart of SafeDebtManager. Users enable this
///         one contract as a Safe module; per-protocol mechanics live in
///         stateless handlers (UniV3YieldHandler, AerodromeYieldHandler, …)
///         invoked via delegatecall, so adding a protocol (e.g. Uniswap V4)
///         is a handler deployment + `setYieldHandler`, not a new module
///         every user must enable.
/// @dev    Shared mutable state (basis bookkeeping, fees, allow-lists) lives
///         in the ERC-7201 `YieldStorage` namespace so handler delegatecode
///         can never collide with this contract's inherited storage.
///         Coexists with the previously deployed standalone
///         RatehopperUniV3Positions contract: positions opened there have no
///         basis recorded here and are rejected with `UnknownPosition` (and
///         vice versa).
contract SafeYieldManager is AccessControl, ReentrancyGuard, Pausable, YieldStorage {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    IProtocolRegistry public immutable REGISTRY;
    IERC20 public immutable USDC;
    /// @notice Immutable TimelockController address. Critical setters
    ///         require `msg.sender == timelock` so a DEFAULT_ADMIN_ROLE
    ///         holder cannot self-grant CRITICAL_ROLE and bypass the delay.
    address public immutable timelock;
    uint16 public immutable MAX_FEE_BPS;

    /// @notice Absolute ceiling on what the admin can set `maxSlippageBps` to.
    uint16 public constant MAX_SETTABLE_SLIPPAGE_BPS = 1000;

    address public pauser;
    mapping(uint8 => address) public yieldHandlers;
    mapping(uint8 => bool) public protocolEnabledForOpen;
    mapping(uint8 => bool) public protocolEnabledForClose;

    event YieldHandlerUpdated(uint8 indexed protocol, address indexed oldHandler, address indexed newHandler);
    event ProtocolStatusChanged(uint8 indexed protocol, bool indexed forOpen, bool enabled);
    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);
    event PerformanceFeeBpsUpdated(uint16 previousPerformanceFeeBps, uint16 newPerformanceFeeBps);
    event FeeCollectBpsUpdated(uint16 previousFeeCollectBps, uint16 newFeeCollectBps);
    event MaxSlippageBpsUpdated(uint16 previousMaxSlippageBps, uint16 newMaxSlippageBps);
    event PoolParamAllowedUpdated(uint8 indexed protocol, bytes poolParam, bool previousAllowed, bool newAllowed);
    event MinPoolLiquidityUpdated(uint8 indexed protocol, uint128 previousValue, uint128 newValue);
    event MinPositionLiquidityUpdated(uint8 indexed protocol, uint128 previousValue, uint128 newValue);
    event TokenRescued(address indexed token, address indexed recipient, uint256 amount);
    event NftRescued(address indexed token, address indexed recipient, uint256 indexed tokenId);
    event PauserUpdated(address indexed previousPauser, address indexed newPauser);

    error HandlerNotSet();
    error ProtocolDisabled();
    error LengthMismatch();
    error HandlerCallFailed();
    error InvalidHandler();
    error HandlerProtocolMismatch(uint8 expected, uint8 actual);
    error InvalidTimelock();
    error TokenNotWhitelisted(address token);

    /// @notice Allows only the registry operator or the Safe itself.
    modifier onlyOperatorOrSafe(address _onBehalfOf) {
        if (_onBehalfOf == address(0)) revert ZeroAddress();
        if (msg.sender != _onBehalfOf && msg.sender != REGISTRY.safeOperator()) revert NotAuthorized();
        _;
    }

    modifier onlyPauser() {
        if (msg.sender != pauser) revert NotAuthorized();
        _;
    }

    modifier onlyTimelockCriticalRole() {
        if (msg.sender != timelock) revert OnlyTimelock();
        _checkRole(CRITICAL_ROLE);
        _;
    }

    constructor(
        IProtocolRegistry _registry,
        IERC20 _usdc,
        uint8[] memory _protocols,
        address[] memory _handlers,
        bytes[][] memory _allowedPoolParams,
        uint128[] memory _minPoolLiquidity,
        uint128[] memory _minPositionLiquidity,
        address _treasury,
        uint16 _performanceFeeBps,
        uint16 _feeCollectBps,
        uint16 _maxFeeBps,
        address _initialAdmin,
        address _timelock,
        address _pauser
    ) {
        if (address(_registry) == address(0)) revert ZeroAddress();
        if (address(_usdc) == address(0)) revert ZeroAddress();
        if (_initialAdmin == address(0)) revert ZeroAddress();
        if (_timelock == address(0)) revert ZeroAddress();
        if (_timelock.code.length == 0) revert InvalidTimelock();
        try ITimelockControllerLike(_timelock).getMinDelay() returns (uint256 minDelay) {
            if (minDelay == 0) revert InvalidTimelock();
        } catch {
            revert InvalidTimelock();
        }
        if (_pauser == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert InvalidTreasury();
        if (_maxFeeBps > 10_000) revert FeeAboveMax();
        if (_performanceFeeBps > _maxFeeBps) revert FeeAboveMax();
        if (_feeCollectBps > _maxFeeBps) revert FeeAboveMax();
        if (
            _handlers.length != _protocols.length ||
            _allowedPoolParams.length != _protocols.length ||
            _minPoolLiquidity.length != _protocols.length ||
            _minPositionLiquidity.length != _protocols.length
        ) revert LengthMismatch();

        REGISTRY = _registry;
        USDC = _usdc;
        timelock = _timelock;
        MAX_FEE_BPS = _maxFeeBps;
        pauser = _pauser;

        YieldLayout storage $ = _yieldStorage();
        $.treasury = _treasury;
        $.performanceFeeBps = _performanceFeeBps;
        $.feeCollectBps = _feeCollectBps;
        $.maxSlippageBps = 300;

        for (uint256 i = 0; i < _protocols.length; i++) {
            _validateHandler(_protocols[i], _handlers[i]);
            yieldHandlers[_protocols[i]] = _handlers[i];
            protocolEnabledForOpen[_protocols[i]] = true;
            protocolEnabledForClose[_protocols[i]] = true;
            emit YieldHandlerUpdated(_protocols[i], address(0), _handlers[i]);
            emit ProtocolStatusChanged(_protocols[i], true, true);
            emit ProtocolStatusChanged(_protocols[i], false, true);

            $.minPoolLiquidity[_protocols[i]] = _minPoolLiquidity[i];
            $.minPositionLiquidity[_protocols[i]] = _minPositionLiquidity[i];
            emit MinPoolLiquidityUpdated(_protocols[i], 0, _minPoolLiquidity[i]);
            emit MinPositionLiquidityUpdated(_protocols[i], 0, _minPositionLiquidity[i]);

            for (uint256 j = 0; j < _allowedPoolParams[i].length; j++) {
                $.allowedPoolKey[_protocols[i]][keccak256(_allowedPoolParams[i][j])] = true;
                emit PoolParamAllowedUpdated(_protocols[i], _allowedPoolParams[i][j], false, true);
            }
        }

        _grantRole(DEFAULT_ADMIN_ROLE, _initialAdmin);
        _grantRole(CRITICAL_ROLE, _timelock);
        // Prevent DEFAULT_ADMIN_ROLE from bypassing timelock-only setters.
        _setRoleAdmin(CRITICAL_ROLE, CRITICAL_ROLE);

        emit TreasuryUpdated(address(0), _treasury);
        emit PerformanceFeeBpsUpdated(0, _performanceFeeBps);
        emit FeeCollectBpsUpdated(0, _feeCollectBps);
        emit MaxSlippageBpsUpdated(0, 300);
        emit PauserUpdated(address(0), _pauser);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  LP lifecycle
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Open an LP position on `protocol`. The Safe must have enabled
    ///         this contract as a module and hold `params.usdcAmount` USDC.
    /// @dev    The only lifecycle entry gated by `whenNotPaused`: pausing the
    ///         contract yields an exit-only mode, never trapping positions.
    function openLp(
        uint8 protocol,
        OpenLpParams calldata params
    ) external nonReentrant whenNotPaused onlyOperatorOrSafe(params.onBehalfOf) returns (uint256 tokenId) {
        if (block.timestamp > params.deadline) revert DeadlineExpired();
        if (params.usdcAmount == 0) revert InvalidUsdcAmount();
        address handler = yieldHandlers[protocol];
        if (handler == address(0)) revert HandlerNotSet();
        if (!protocolEnabledForOpen[protocol]) revert ProtocolDisabled();

        _requireWhitelistedPoolTokens(handler, params.lpPoolParam);

        bytes memory ret = _delegateToHandler(handler, abi.encodeCall(IYieldHandler.openLp, (params)));
        uint128 basisUsd6;
        uint128 used0;
        uint128 used1;
        (tokenId, basisUsd6, used0, used1) = abi.decode(ret, (uint256, uint128, uint128, uint128));

        // Persist the open-time basis so closes always price against an
        // on-chain value neither the Safe nor the operator can attest, and
        // pin the handler so later `setYieldHandler` calls never apply
        // retroactively to this position.
        YieldLayout storage $ = _yieldStorage();
        $.residualBasisUsd6Of[protocol][tokenId] = basisUsd6;
        $.positionHandlerOf[protocol][tokenId] = handler;

        emit PositionOpened(params.onBehalfOf, protocol, tokenId, params.usdcAmount, used0, used1, basisUsd6);
    }

    /// @notice Close (partially or fully) an LP position opened through this
    ///         contract. Charges `performanceFeeBps` on realized profit only.
    /// @dev    Deliberately NOT `whenNotPaused` and NOT gated on the current
    ///         `yieldHandlers` registration — exits run through the handler
    ///         pinned at open time and stay available while the contract is
    ///         paused (exit-only mode). Only the per-protocol
    ///         `protocolEnabledForClose` switch can stop them (e.g. a
    ///         compromised handler).
    function closeLp(
        uint8 protocol,
        CloseLpParams calldata params
    ) external nonReentrant onlyOperatorOrSafe(params.onBehalfOf) {
        if (block.timestamp > params.deadline) revert DeadlineExpired();
        if (params.exitBps == 0 || params.exitBps > 10_000) revert InvalidExitBps();
        if (!protocolEnabledForClose[protocol]) revert ProtocolDisabled();

        YieldLayout storage $ = _yieldStorage();
        (uint128 residualBasis, address handler) = _pinnedPosition($, protocol, params.tokenId);

        uint128 basisForExit = Math.mulDiv(uint256(residualBasis), uint256(params.exitBps), 10_000).toUint128();
        if (params.exitBps == 10_000) {
            delete $.residualBasisUsd6Of[protocol][params.tokenId];
            delete $.positionHandlerOf[protocol][params.tokenId];
        } else {
            $.residualBasisUsd6Of[protocol][params.tokenId] = residualBasis - basisForExit;
        }

        bytes memory ret = _delegateToHandler(handler, abi.encodeCall(IYieldHandler.closeLp, (params, basisForExit)));
        uint128 currentValueUsd6 = abi.decode(ret, (uint128));

        // Performance fee applies only to realized profit; a failed treasury
        // transfer must never block an exit.
        uint128 feeUsd6 = 0;
        if (currentValueUsd6 > basisForExit) {
            uint256 profit = uint256(currentValueUsd6) - uint256(basisForExit);
            feeUsd6 = ((profit * $.performanceFeeBps) / 10_000).toUint128();
            if (feeUsd6 > 0 && !_trySafeTransfer(params.onBehalfOf, address(USDC), $.treasury, uint256(feeUsd6))) {
                emit FeeTransferFailed(params.onBehalfOf, params.tokenId, feeUsd6);
                feeUsd6 = 0;
            }
        }

        emit PositionClosed(
            params.onBehalfOf,
            protocol,
            params.tokenId,
            basisForExit,
            currentValueUsd6,
            feeUsd6,
            params.exitBps
        );
    }

    /// @notice Atomically move a full position to another pool of the SAME
    ///         token pair — a different protocol, a different fee tier / tick
    ///         spacing, or any mix. The withdraw leg takes the position out
    ///         IN KIND through the pinned handler (no swaps); the open leg
    ///         redeploys those exact token amounts through the target
    ///         protocol's current handler (no swaps). Amounts the destination
    ///         mint cannot consume stay in the Safe.
    /// @dev    An in-kind switch realizes nothing — there is no USDC moment
    ///         to re-measure the position against — so the original basis is
    ///         carried onto the replacement position UNCHANGED and NO
    ///         performance fee is taken: realized profit is charged only at
    ///         the real exit via closeLp. Withdrawn residue left in the Safe
    ///         only under-states later realized profit, never inflates it.
    ///         A switch opens new exposure, hence `whenNotPaused` (unlike
    ///         exits) plus BOTH per-protocol switches:
    ///         `protocolEnabledForClose[from]` and `protocolEnabledForOpen[to]`.
    function switchLp(
        uint8 fromProtocol,
        uint8 toProtocol,
        SwitchLpParams calldata params
    ) external nonReentrant whenNotPaused onlyOperatorOrSafe(params.onBehalfOf) returns (uint256 newTokenId) {
        if (block.timestamp > params.deadline) revert DeadlineExpired();
        if (!protocolEnabledForClose[fromProtocol]) revert ProtocolDisabled();
        address openHandler = yieldHandlers[toProtocol];
        if (openHandler == address(0)) revert HandlerNotSet();
        if (!protocolEnabledForOpen[toProtocol]) revert ProtocolDisabled();
        _requireWhitelistedPoolTokens(openHandler, params.lpPoolParam);

        YieldLayout storage $ = _yieldStorage();
        (uint128 residualBasis, address closeHandler) = _pinnedPosition($, fromProtocol, params.tokenId);
        delete $.residualBasisUsd6Of[fromProtocol][params.tokenId];
        delete $.positionHandlerOf[fromProtocol][params.tokenId];

        (address token0, address token1, uint256 amount0, uint256 amount1) = _switchWithdrawLeg(closeHandler, params);
        uint128 used0;
        uint128 used1;
        (newTokenId, used0, used1) = _switchOpenLeg(openHandler, params, token0, token1, amount0, amount1);

        $.residualBasisUsd6Of[toProtocol][newTokenId] = residualBasis;
        $.positionHandlerOf[toProtocol][newTokenId] = openHandler;

        emit PositionSwitched(
            params.onBehalfOf,
            fromProtocol,
            toProtocol,
            params.tokenId,
            newTokenId,
            residualBasis,
            amount0,
            amount1,
            used0,
            used1
        );
    }

    /// @dev Full in-kind withdrawal of the old position via its pinned
    ///      handler; the pool tokens land on the Safe unswapped (a native
    ///      side arrives wrapped as its ERC20).
    function _switchWithdrawLeg(
        address handler,
        SwitchLpParams calldata p
    ) internal returns (address token0, address token1, uint256 amount0, uint256 amount1) {
        bytes memory ret = _delegateToHandler(
            handler,
            abi.encodeCall(
                IYieldHandler.withdrawLp,
                (
                    WithdrawLpParams({
                        onBehalfOf: p.onBehalfOf,
                        tokenId: p.tokenId,
                        decreaseAmount0Min: p.decreaseAmount0Min,
                        decreaseAmount1Min: p.decreaseAmount1Min,
                        deadline: p.deadline
                    })
                )
            )
        );
        (token0, token1, amount0, amount1) = abi.decode(ret, (address, address, uint256, uint256));
    }

    /// @dev Open the replacement position through the target protocol's
    ///      current handler with the exact tokens the withdraw leg delivered.
    ///      The handler rejects a pair mismatch (`WrongTokenPair`), so a
    ///      switch can never silently deploy unrelated Safe funds.
    function _switchOpenLeg(
        address handler,
        SwitchLpParams calldata p,
        address token0,
        address token1,
        uint256 amount0,
        uint256 amount1
    ) internal returns (uint256 tokenId, uint128 used0, uint128 used1) {
        bytes memory ret = _delegateToHandler(
            handler,
            abi.encodeCall(
                IYieldHandler.openLpInKind,
                (
                    OpenLpInKindParams({
                        onBehalfOf: p.onBehalfOf,
                        token0: token0,
                        token1: token1,
                        amount0: amount0,
                        amount1: amount1,
                        tickLower: p.tickLower,
                        tickUpper: p.tickUpper,
                        mintAmount0Min: p.mintAmount0Min,
                        mintAmount1Min: p.mintAmount1Min,
                        lpPoolParam: p.lpPoolParam,
                        deadline: p.deadline
                    })
                )
            )
        );
        (tokenId, used0, used1) = abi.decode(ret, (uint256, uint128, uint128));
    }

    /// @dev Registry token whitelist gate on an open-leg pool pair, resolved
    ///      through the handler's pure `poolTokens` decode (staticcall — the
    ///      handler never runs in its own storage context). token0 ==
    ///      address(0) is Uniswap V4's native-ETH currency sentinel, not a
    ///      token — skip it (token1 can never be zero: currencies sort
    ///      ascending). Applies to openLp and the switchLp open leg only;
    ///      exits must never brick on a later de-listing.
    function _requireWhitelistedPoolTokens(address handler, bytes calldata lpPoolParam) internal view {
        // Same revert convention as _delegateToHandler: bubble reasoned
        // reverts (e.g. a malformed pool param failing the handler's decode),
        // wrap empty ones in HandlerCallFailed.
        (bool ok, bytes memory ret) = handler.staticcall(abi.encodeCall(IYieldHandler.poolTokens, (lpPoolParam)));
        if (!ok) {
            if (ret.length > 0) Address.verifyCallResult(ok, ret);
            revert HandlerCallFailed();
        }
        (address token0, address token1) = abi.decode(ret, (address, address));
        if (token0 != address(0) && !REGISTRY.whitelistedTokens(token0)) revert TokenNotWhitelisted(token0);
        if (!REGISTRY.whitelistedTokens(token1)) revert TokenNotWhitelisted(token1);
    }

    /// @notice Harvest accrued LP fees of a position opened through this
    ///         contract without exiting it.
    /// @dev    Same exit-friendly gating as `closeLp`: runs through the
    ///         pinned handler, unaffected by pause, stoppable only via
    ///         `protocolEnabledForClose`.
    function collectLp(
        uint8 protocol,
        CollectLpParams calldata params
    ) external nonReentrant onlyOperatorOrSafe(params.onBehalfOf) {
        if (!protocolEnabledForClose[protocol]) revert ProtocolDisabled();
        // Only harvest positions this contract manages; otherwise any
        // Safe-owned NFT could be routed through to skim feeCollectBps.
        (, address handler) = _pinnedPosition(_yieldStorage(), protocol, params.tokenId);

        _delegateToHandler(handler, abi.encodeCall(IYieldHandler.collectLp, (params)));
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Views
    // ─────────────────────────────────────────────────────────────────────

    function residualBasisUsd6Of(uint8 protocol, uint256 tokenId) external view returns (uint128) {
        return _yieldStorage().residualBasisUsd6Of[protocol][tokenId];
    }

    function positionHandlerOf(uint8 protocol, uint256 tokenId) external view returns (address) {
        return _yieldStorage().positionHandlerOf[protocol][tokenId];
    }

    /// @notice Stake pool a position is pinned to, or address(0) when it was never
    ///         staked. The pin survives the temporary unstake a partial close does,
    ///         so it also answers "where does this position go back to".
    function stakePoolOf(uint8 protocol, uint256 tokenId) external view returns (address) {
        return _yieldStorage().stakePoolOf[protocol][tokenId];
    }

    function isPoolParamAllowed(uint8 protocol, bytes calldata poolParam) external view returns (bool) {
        return _yieldStorage().allowedPoolKey[protocol][keccak256(poolParam)];
    }

    function treasury() external view returns (address) {
        return _yieldStorage().treasury;
    }

    function performanceFeeBps() external view returns (uint16) {
        return _yieldStorage().performanceFeeBps;
    }

    function feeCollectBps() external view returns (uint16) {
        return _yieldStorage().feeCollectBps;
    }

    function maxSlippageBps() external view returns (uint16) {
        return _yieldStorage().maxSlippageBps;
    }

    function minPoolLiquidity(uint8 protocol) external view returns (uint128) {
        return _yieldStorage().minPoolLiquidity[protocol];
    }

    function minPositionLiquidity(uint8 protocol) external view returns (uint128) {
        return _yieldStorage().minPositionLiquidity[protocol];
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Timelocked critical setters
    // ─────────────────────────────────────────────────────────────────────

    function setTreasury(address newTreasury) external onlyTimelockCriticalRole {
        if (newTreasury == address(0)) revert InvalidTreasury();
        YieldLayout storage $ = _yieldStorage();
        emit TreasuryUpdated($.treasury, newTreasury);
        $.treasury = newTreasury;
    }

    function setPerformanceFeeBps(uint16 newPerformanceFeeBps) external onlyTimelockCriticalRole {
        if (newPerformanceFeeBps > MAX_FEE_BPS) revert FeeAboveMax();
        YieldLayout storage $ = _yieldStorage();
        emit PerformanceFeeBpsUpdated($.performanceFeeBps, newPerformanceFeeBps);
        $.performanceFeeBps = newPerformanceFeeBps;
    }

    function setFeeCollectBps(uint16 newFeeCollectBps) external onlyTimelockCriticalRole {
        if (newFeeCollectBps > MAX_FEE_BPS) revert FeeAboveMax();
        YieldLayout storage $ = _yieldStorage();
        emit FeeCollectBpsUpdated($.feeCollectBps, newFeeCollectBps);
        $.feeCollectBps = newFeeCollectBps;
    }

    /// @notice Register or replace the handler for a protocol. Handler code
    ///         runs via delegatecall with full access to this contract's
    ///         context, hence the timelock gate.
    /// @dev    Affects NEW positions only: close/collect always run through
    ///         the handler pinned per position at open time, so replacing a
    ///         handler (or a bad registration) can never strand existing
    ///         positions on an incompatible implementation.
    function setYieldHandler(uint8 protocol, address handler) external onlyTimelockCriticalRole {
        _validateHandler(protocol, handler);
        address oldHandler = yieldHandlers[protocol];
        yieldHandlers[protocol] = handler;
        emit YieldHandlerUpdated(protocol, oldHandler, handler);
    }

    /// @dev The code-length pre-check is load-bearing: for a codeless address
    ///      `PROTOCOL()` returns empty data, and RETURN-DATA DECODING errors
    ///      are NOT caught by try/catch — they revert reason-less in this
    ///      contract instead of landing in the catch below.
    function _validateHandler(uint8 protocol, address handler) internal view {
        if (handler.code.length == 0) revert InvalidHandler();
        try IYieldHandler(handler).PROTOCOL() returns (uint8 handlerProtocol) {
            if (handlerProtocol != protocol) revert HandlerProtocolMismatch(protocol, handlerProtocol);
        } catch {
            revert InvalidHandler();
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Admin setters
    // ─────────────────────────────────────────────────────────────────────

    function setMaxSlippageBps(uint16 newMaxSlippageBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newMaxSlippageBps > MAX_SETTABLE_SLIPPAGE_BPS) revert SlippageAboveMax();
        YieldLayout storage $ = _yieldStorage();
        emit MaxSlippageBpsUpdated($.maxSlippageBps, newMaxSlippageBps);
        $.maxSlippageBps = newMaxSlippageBps;
    }

    /// @notice Allow or disallow a protocol-specific pool param (ABI-encoded
    ///         feeTier / tickSpacing / future pool key).
    function setPoolParamAllowed(
        uint8 protocol,
        bytes calldata poolParam,
        bool allowed
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        YieldLayout storage $ = _yieldStorage();
        bytes32 key = keccak256(poolParam);
        emit PoolParamAllowedUpdated(protocol, poolParam, $.allowedPoolKey[protocol][key], allowed);
        $.allowedPoolKey[protocol][key] = allowed;
    }

    function setMinPoolLiquidity(uint8 protocol, uint128 newValue) external onlyRole(DEFAULT_ADMIN_ROLE) {
        YieldLayout storage $ = _yieldStorage();
        emit MinPoolLiquidityUpdated(protocol, $.minPoolLiquidity[protocol], newValue);
        $.minPoolLiquidity[protocol] = newValue;
    }

    function setMinPositionLiquidity(uint8 protocol, uint128 newValue) external onlyRole(DEFAULT_ADMIN_ROLE) {
        YieldLayout storage $ = _yieldStorage();
        emit MinPositionLiquidityUpdated(protocol, $.minPositionLiquidity[protocol], newValue);
        $.minPositionLiquidity[protocol] = newValue;
    }

    function setPauser(address newPauser) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newPauser == address(0)) revert ZeroAddress();
        emit PauserUpdated(pauser, newPauser);
        pauser = newPauser;
    }

    /// @notice Recover ERC20s held by this contract, not by a Safe.
    function rescueToken(address token, address recipient, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        if (recipient == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(recipient, amount);
        emit TokenRescued(token, recipient, amount);
    }

    /// @notice Recover ERC721s held by this contract, not by a Safe.
    function rescueERC721(address token, uint256 tokenId, address recipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        if (recipient == address(0)) revert ZeroAddress();
        IERC721(token).safeTransferFrom(address(this), recipient, tokenId);
        emit NftRescued(token, recipient, tokenId);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Pauser controls
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Emergency per-protocol disable of NEW position opens (mirrors
    ///         SafeDebtManager's switchFrom/switchTo split). Never affects
    ///         exits.
    function setProtocolEnabledForOpen(uint8 protocol, bool enabled) external onlyPauser {
        if (yieldHandlers[protocol] == address(0)) revert HandlerNotSet();
        protocolEnabledForOpen[protocol] = enabled;
        emit ProtocolStatusChanged(protocol, true, enabled);
    }

    /// @notice Emergency per-protocol disable of close/collect — the ONLY
    ///         switch that can stop exits, reserved for a compromised or
    ///         malfunctioning handler. Keep opens disabled too when using it.
    function setProtocolEnabledForClose(uint8 protocol, bool enabled) external onlyPauser {
        if (yieldHandlers[protocol] == address(0)) revert HandlerNotSet();
        protocolEnabledForClose[protocol] = enabled;
        emit ProtocolStatusChanged(protocol, false, enabled);
    }

    /// @notice Pause NEW position opens. closeLp/collectLp stay available —
    ///         pausing yields an exit-only mode and never traps positions.
    function pause() external onlyPauser {
        _pause();
    }

    function unpause() external onlyPauser {
        _unpause();
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Internals
    // ─────────────────────────────────────────────────────────────────────

    /// @dev Module-mediated ERC20 transfer that accepts empty return data or
    ///      the canonical true word only, and never reverts on malformed
    ///      returndata — a failed treasury transfer must waive the fee
    ///      instead of blocking an exit. Mirrors RatehopperUniV3Positions.
    function _trySafeTransfer(
        address _onBehalfOf,
        address token,
        address recipient,
        uint256 amount
    ) internal returns (bool) {
        (bool ok, bytes memory ret) = ISafe(_onBehalfOf).execTransactionFromModuleReturnData(
            token,
            0,
            abi.encodeCall(IERC20.transfer, (recipient, amount)),
            ISafe.Operation.Call
        );
        if (!ok) return false;
        return TokenReturnLib.returnedTrue(ret);
    }

    /// @dev Basis and open-time handler of a position this contract manages.
    ///      The handler (not the basis) is the managed-position sentinel so a
    ///      position whose recorded basis is zero stays manageable.
    function _pinnedPosition(
        YieldLayout storage $,
        uint8 protocol,
        uint256 tokenId
    ) internal view returns (uint128 residualBasis, address handler) {
        handler = $.positionHandlerOf[protocol][tokenId];
        residualBasis = $.residualBasisUsd6Of[protocol][tokenId];
        if (handler == address(0)) {
            if (residualBasis == 0) revert UnknownPosition();
            revert HandlerNotSet();
        }
    }

    /// @dev Delegatecall into a handler, bubbling its revert data.
    function _delegateToHandler(address handler, bytes memory data) internal returns (bytes memory) {
        (bool ok, bytes memory ret) = handler.delegatecall(data);
        if (!ok) {
            if (ret.length > 0) Address.verifyCallResult(ok, ret);
            revert HandlerCallFailed();
        }
        return ret;
    }
}
