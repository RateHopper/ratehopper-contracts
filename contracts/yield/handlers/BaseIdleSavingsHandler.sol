// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {ISafe} from "../../interfaces/safe/ISafe.sol";
import {IYieldHandler, OpenLpParams, CloseLpParams, CollectLpParams, WithdrawLpParams, OpenLpInKindParams} from "../../interfaces/IYieldHandler.sol";
import {IIdleSavingsRateProvider} from "../../interfaces/IIdleSavingsRateProvider.sol";
import {TokenReturnLib} from "../libraries/TokenReturnLib.sol";
import {YieldStorage} from "./YieldStorage.sol";
import {IdleSavingsStorage} from "./IdleSavingsStorage.sol";

/// @title BaseIdleSavingsHandler
/// @notice Shared flow for idle savings sources: a Safe's idle USDC goes into
///         a yield-bearing share token (sUSDS through Spark PSM3, later an
///         ERC-4626 vault) and comes back as USDC. Implements IYieldHandler
///         directly, not through BaseYieldHandler: there is no pool, no NFT
///         and no swap leg. Executed via delegatecall from SafeYieldManager,
///         so basis bookkeeping and the performance fee stay in the manager;
///         this contract only reports values back.
///
///         A position is identified by the Safe itself:
///         `tokenId = uint256(uint160(onBehalfOf))`. One open position per
///         Safe, no top-ups (a second `openLp` reverts `PositionAlreadyOpen`).
///
///         The manager's rule "allow-listed implies a live Uniswap V3 TWAP
///         reference for every non-USDC token" cannot be met for a share
///         token with no deep pool, so `poolTokens` reports `(USDC, USDC)` and
///         the manager skips the reference requirement. The price floor comes
///         from `RATE_PROVIDER` instead, pinned per build, and `slippageBps`
///         is reused as the oracle tolerance (bounded by `MAX_TOLERANCE_BPS`,
///         not by the manager's `maxSlippageBps`). The base never trusts what
///         a hook claims: deposits and redemptions are measured as Safe
///         balance deltas and checked against the floor here.
///
///         `withdrawLp` is the exit that must keep working when nothing else
///         does: it releases the record with no Safe call and no price read,
///         leaving the share token where it already is, on the Safe. The
///         same-id handler rollover (`switchLp(3, 3)`) is `withdrawLp` on the
///         pinned old build followed by `openLpInKind` on the newly
///         registered one; neither leg touches the venue or an oracle.
///
///         Every Safe interaction goes through
///         `execTransactionFromModuleReturnData` with `Operation.Call`, an
///         immutable target and a selector chosen
///         here (approve, deposit, redeem). This contract never holds or
///         moves tokens itself: inside a delegatecall `address(this)` is the
///         manager, so a direct `transfer` here would move the manager's
///         tokens. Only `balanceOf` reads are made directly.
/// @dev    STATELESS: MUST NOT declare storage variables. Mutable state lives
///         in the ERC-7201 `IdleSavingsStorage` namespace; `YieldStorage` is
///         read (allow-list, pin) but never written. Immutables are fine.
abstract contract BaseIdleSavingsHandler is IYieldHandler, YieldStorage, IdleSavingsStorage {
    using SafeCast for uint256;

    /// @notice Protocol id (canonical ids are the YIELD_PROTOCOL_* constants
    ///         in Types.sol); a constructor argument so every source is one
    ///         thin contract over this base.
    uint8 public immutable PROTOCOL;
    IERC20 public immutable USDC;
    /// @notice Price source for the share token. Pinned per build: replacing
    ///         it is a handler rollover behind the timelock.
    IIdleSavingsRateProvider public immutable RATE_PROVIDER;
    /// @notice Hard ceiling on the oracle tolerance a caller may pass as
    ///         `slippageBps`. 50 bps covers the observed Chainlink lag behind
    ///         the SSR oracle (a few bps) with room to spare.
    uint16 public immutable MAX_TOLERANCE_BPS;
    /// @notice Share of the venue's live exit liquidity the whole book may
    ///         reach. A rail against a backend bug, not the liquidity policy:
    ///         the deposit itself lands in the venue, so until the venue sweeps
    ///         it the next deposit sees it as headroom.
    uint16 public immutable MAX_EXPOSURE_BPS;

    /// @dev Own deployment address, captured at construction to enforce
    ///      delegatecall-only entry (a direct call would run against the
    ///      handler's empty storage).
    address private immutable __self = address(this);

    uint256 private constant BPS = 10_000;
    uint256 private constant ONE = 1e18;
    /// @dev USDC has 6 decimals, share tokens 18.
    uint256 private constant USDC_TO_SHARE_SCALE = 1e12;
    /// @dev shares (18 dp) * rate (18 dp) / 1e30 = USDC (6 dp).
    uint256 private constant SHARES_TIMES_RATE_TO_USDC = 1e30;
    uint16 private constant MAX_SETTABLE_TOLERANCE_BPS = 300;

    event IdleSavingsDeposited(
        address indexed onBehalfOf,
        uint256 indexed tokenId,
        uint256 usdcIn,
        uint256 sharesOut,
        uint256 rate
    );
    event IdleSavingsRedeemed(
        address indexed onBehalfOf,
        uint256 indexed tokenId,
        uint256 sharesIn,
        uint256 usdcOut,
        uint256 rate,
        uint16 exitBps
    );
    event IdleSavingsReleased(address indexed onBehalfOf, uint256 indexed tokenId, uint256 shares);
    /// @notice The Safe holds fewer shares than the record says: a user moved
    ///         them out around the module. The exit continues with what is
    ///         left; the manager still charges the fee against the full basis,
    ///         so the realized value is understated by the missing shares.
    event IdleSavingsSharesShortfall(
        address indexed onBehalfOf,
        uint256 indexed tokenId,
        uint256 tracked,
        uint256 balance
    );
    event IdleSavingsAdopted(address indexed onBehalfOf, uint256 indexed tokenId, uint256 shares);

    error OnlyDelegatecall();
    error TokenApprovalFailed(address token);
    error InvalidConfig();
    error WrongPosition();
    error PositionAlreadyOpen();
    error StaleSharesRecord();
    error WrongPoolParam();
    error ExposureCapExceeded(uint256 need, uint256 available);
    error SharesNotOnSafe();
    error InKindNotSupported();
    error CollectNotSupported();
    error StakingNotSupported();

    modifier onlyDelegatecall() {
        if (address(this) == __self) revert OnlyDelegatecall();
        _;
    }

    /// @param _sourceShareToken The share token the concrete source returns from
    ///        `_shareToken()`; passed here so the provider can be checked and
    ///        proven to answer today, before the first user finds out.
    constructor(
        uint8 _protocol,
        IERC20 _usdc,
        IIdleSavingsRateProvider _rateProvider,
        IERC20 _sourceShareToken,
        uint16 _maxToleranceBps,
        uint16 _maxExposureBps
    ) {
        if (address(_usdc) == address(0)) revert ZeroAddress();
        if (address(_rateProvider) == address(0)) revert ZeroAddress();
        if (address(_sourceShareToken) == address(0)) revert ZeroAddress();
        if (_rateProvider.shareToken() != address(_sourceShareToken)) revert InvalidConfig();
        _rateProvider.rate(address(_sourceShareToken));
        if (_maxToleranceBps == 0 || _maxToleranceBps > MAX_SETTABLE_TOLERANCE_BPS) revert InvalidConfig();
        if (_maxExposureBps == 0 || _maxExposureBps > BPS) revert InvalidConfig();

        PROTOCOL = _protocol;
        USDC = _usdc;
        RATE_PROVIDER = _rateProvider;
        MAX_TOLERANCE_BPS = _maxToleranceBps;
        MAX_EXPOSURE_BPS = _maxExposureBps;
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Hooks: the only lines a concrete source implements
    // ─────────────────────────────────────────────────────────────────────

    /// @dev The share token this source deposits into (sUSDS; a vault's share).
    function _shareToken() internal view virtual returns (IERC20);

    /// @dev Whether `lpPoolParam` names exactly this source's venue and share
    ///      token. The manager's allow-list is checked separately.
    function _poolParamMatches(bytes memory lpPoolParam) internal view virtual returns (bool);

    /// @dev Move `usdc6` USDC from the Safe into the venue for at least
    ///      `minShares` share tokens, delivered to the Safe. Every allowance
    ///      granted must be reset before returning.
    function _depositUsdc(address safe, uint256 usdc6, uint256 minShares) internal virtual;

    /// @dev Redeem `shares` from the Safe for at least `minUsdc6` USDC,
    ///      delivered to the Safe. Every allowance granted must be reset.
    function _redeemShares(address safe, uint256 shares, uint256 minUsdc6) internal virtual;

    /// @dev USDC the venue can pay out right now (PSM3: the pocket balance).
    function _liquidityAvailable() internal view virtual returns (uint256 usdc6);

    // ─────────────────────────────────────────────────────────────────────
    //  IYieldHandler
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Always `(USDC, USDC)`: the share token has no pool the
    ///         manager's TWAP rule could reference, so the pair reported to
    ///         the manager is USDC-only and the floor comes from
    ///         `RATE_PROVIDER` instead.
    function poolTokens(bytes calldata) external view returns (address token0, address token1) {
        return (address(USDC), address(USDC));
    }

    function poolParamHasHooks(bytes calldata) external pure returns (bool) {
        return false;
    }

    /// @notice Deposit `usdcAmount` of the Safe's USDC into the source.
    ///         `tickLower`, `tickUpper`, `mintAmount0Min`, `mintAmount1Min`,
    ///         `swap0` and `swap1` are ignored; `slippageBps` is the oracle
    ///         tolerance; `stake` must be false.
    /// @return tokenId   The Safe address as a uint256.
    /// @return basisUsd6 `usdcAmount`; the manager records it as the basis.
    /// @return used0     `usdcAmount`.
    /// @return used1     Share tokens received, 18 decimals.
    function openLp(
        OpenLpParams calldata p
    ) external onlyDelegatecall returns (uint256 tokenId, uint128 basisUsd6, uint128 used0, uint128 used1) {
        if (p.stake) revert StakingNotSupported();
        _requireTolerance(p.slippageBps);
        _validatePoolParam(p.lpPoolParam);
        tokenId = _tokenIdOf(p.onBehalfOf);
        if (_yieldStorage().positionHandlerOf[PROTOCOL][tokenId] != address(0)) revert PositionAlreadyOpen();
        IdleSavingsLayout storage $ = _idleSavingsStorage();
        if ($.sharesOf[PROTOCOL][tokenId] != 0) revert StaleSharesRecord();

        uint256 rate = _rate();
        uint256 minShares = _minSharesOut(p.usdcAmount, rate, p.slippageBps);
        _requireExposureHeadroom($, p.usdcAmount, rate);

        IERC20 shares = _shareToken();
        uint256 sharesBefore = shares.balanceOf(p.onBehalfOf);
        _depositUsdc(p.onBehalfOf, p.usdcAmount, minShares);
        uint256 received = shares.balanceOf(p.onBehalfOf) - sharesBefore;
        if (received < minShares) revert SwapFailed();

        $.sharesOf[PROTOCOL][tokenId] = received;
        $.totalShares[PROTOCOL] += received;
        basisUsd6 = p.usdcAmount.toUint128();
        emit IdleSavingsDeposited(p.onBehalfOf, tokenId, p.usdcAmount, received, rate);
        return (tokenId, basisUsd6, basisUsd6, received.toUint128());
    }

    /// @notice Redeem `exitBps` of the position's shares to USDC on the Safe.
    ///         `swap0`, `swap1`, `decreaseAmount0Min` and `decreaseAmount1Min`
    ///         are ignored. The floor is `max(oracle floor, minUsdcOut)` and
    ///         is enforced on the measured USDC delta, whatever the venue
    ///         claims.
    /// @dev    A Safe that moved shares out around the module redeems what is
    ///         left (`IdleSavingsSharesShortfall`); the manager still prorates
    ///         and charges against the full basis. With nothing left to redeem
    ///         no price is read, so the record can be cleared while the feed is
    ///         down; the event then reports a rate of zero.
    function closeLp(
        CloseLpParams calldata p,
        uint128 basisForExit
    ) external onlyDelegatecall returns (uint128 currentValueUsd6) {
        _requireTolerance(p.slippageBps);
        _requirePosition(p.onBehalfOf, p.tokenId);
        IdleSavingsLayout storage $ = _idleSavingsStorage();
        uint256 tracked = _reconcileShares($, p.onBehalfOf, p.tokenId);
        uint256 toRedeem = p.exitBps == BPS ? tracked : Math.mulDiv(tracked, p.exitBps, BPS);
        if (p.exitBps != BPS && basisForExit > 0 && toRedeem == 0) revert InvalidExitBps();

        uint256 rate = toRedeem > 0 ? _rate() : 0;
        uint256 minOut = _minUsdcOut(toRedeem, rate, p.slippageBps, p.minUsdcOut);
        uint256 usdcBefore = USDC.balanceOf(p.onBehalfOf);
        if (toRedeem > 0) _redeemShares(p.onBehalfOf, toRedeem, minOut);
        uint256 received = USDC.balanceOf(p.onBehalfOf) - usdcBefore;
        if (received < minOut) revert MinUsdcOutNotMet();
        currentValueUsd6 = received.toUint128();

        if (p.exitBps == BPS) {
            delete $.sharesOf[PROTOCOL][p.tokenId];
            $.totalShares[PROTOCOL] -= tracked;
        } else {
            $.sharesOf[PROTOCOL][p.tokenId] = tracked - toRedeem;
            $.totalShares[PROTOCOL] -= toRedeem;
        }
        emit IdleSavingsRedeemed(p.onBehalfOf, p.tokenId, toRedeem, currentValueUsd6, rate, p.exitBps);
    }

    /// @notice Release the position in kind: the shares stay on the Safe and
    ///         the manager forgets the position. No Safe call, no price read,
    ///         no venue dependency. `decreaseAmount0Min`, `decreaseAmount1Min`
    ///         and `deadline` are ignored (the manager checks the deadline).
    /// @return token0  USDC.
    /// @return token1  The share token.
    /// @return amount0 Always zero.
    /// @return amount1 Shares released from the record.
    function withdrawLp(
        WithdrawLpParams calldata p
    ) external onlyDelegatecall returns (address token0, address token1, uint256 amount0, uint256 amount1) {
        _requirePosition(p.onBehalfOf, p.tokenId);
        IdleSavingsLayout storage $ = _idleSavingsStorage();
        uint256 released = $.sharesOf[PROTOCOL][p.tokenId];
        delete $.sharesOf[PROTOCOL][p.tokenId];
        $.totalShares[PROTOCOL] -= released;
        emit IdleSavingsReleased(p.onBehalfOf, p.tokenId, released);
        return (address(USDC), address(_shareToken()), 0, released);
    }

    /// @notice The same-id handler rollover leg, reached only through the
    ///         manager's `switchLp(PROTOCOL, PROTOCOL, ...)` after the old
    ///         build's `withdrawLp` released the record: adopt the shares
    ///         already on the Safe. Reporting `used1 == amount1` makes the
    ///         manager's residue zero, so no price is read and basis and carry
    ///         carry over unchanged. Any LP-shaped input reverts, and so does
    ///         a switch from another source into a Safe whose position under
    ///         this id is still open (the manager clears the pin only for the
    ///         same-id rollover).
    function openLpInKind(
        OpenLpInKindParams calldata p
    ) external onlyDelegatecall returns (uint256 tokenId, uint128 used0, uint128 used1) {
        _validatePoolParam(p.lpPoolParam);
        IERC20 shares = _shareToken();
        if (p.token0 != address(USDC) || p.token1 != address(shares) || p.amount0 != 0 || p.amount1 == 0) {
            revert InKindNotSupported();
        }
        tokenId = _tokenIdOf(p.onBehalfOf);
        if (_yieldStorage().positionHandlerOf[PROTOCOL][tokenId] != address(0)) revert PositionAlreadyOpen();
        IdleSavingsLayout storage $ = _idleSavingsStorage();
        if ($.sharesOf[PROTOCOL][tokenId] != 0) revert StaleSharesRecord();
        if (shares.balanceOf(p.onBehalfOf) < p.amount1) revert SharesNotOnSafe();

        $.sharesOf[PROTOCOL][tokenId] = p.amount1;
        $.totalShares[PROTOCOL] += p.amount1;
        emit IdleSavingsAdopted(p.onBehalfOf, tokenId, p.amount1);
        return (tokenId, 0, p.amount1.toUint128());
    }

    /// @notice Idle savings accrue inside the share price; there is nothing
    ///         to harvest.
    function collectLp(CollectLpParams calldata) external view onlyDelegatecall {
        revert CollectNotSupported();
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Views for the backend (call on the handler directly, read the slot on
    //  the manager with eth_getStorageAt)
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Storage slot of `sharesOf[PROTOCOL][tokenId]` under the idle
    ///         savings namespace.
    function idleSavingsSharesSlot(uint256 tokenId) external view returns (bytes32) {
        bytes32 inner = keccak256(abi.encode(uint256(PROTOCOL), uint256(IDLE_SAVINGS_STORAGE_SLOT)));
        return keccak256(abi.encode(tokenId, inner));
    }

    /// @notice Storage slot of `totalShares[PROTOCOL]` under the idle savings
    ///         namespace.
    function idleSavingsTotalSharesSlot() external view returns (bytes32) {
        return keccak256(abi.encode(uint256(PROTOCOL), uint256(IDLE_SAVINGS_STORAGE_SLOT) + 1));
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Internals
    // ─────────────────────────────────────────────────────────────────────

    function _tokenIdOf(address safe) internal pure returns (uint256) {
        return uint256(uint160(safe));
    }

    function _rate() internal view returns (uint256) {
        return RATE_PROVIDER.rate(address(_shareToken()));
    }

    function _requireTolerance(uint16 toleranceBps) internal view {
        if (toleranceBps == 0) revert SlippageTooLow();
        if (toleranceBps > MAX_TOLERANCE_BPS) revert SlippageAboveMax();
    }

    /// @dev The operator can never redeem Safe B's shares against Safe A's
    ///      basis record: the position id IS the Safe.
    function _requirePosition(address safe, uint256 tokenId) internal pure {
        if (tokenId != _tokenIdOf(safe)) revert WrongPosition();
    }

    /// @dev The param must name this source's immutables AND be on the
    ///      manager's allow-list (read-only use of the manager namespace); the
    ///      allow-list is the routine kill switch for new deposits.
    function _validatePoolParam(bytes memory lpPoolParam) internal view {
        if (!_poolParamMatches(lpPoolParam)) revert WrongPoolParam();
        if (!_yieldStorage().allowedPoolKey[PROTOCOL][keccak256(lpPoolParam)]) revert PoolParamNotAllowed();
    }

    /// @dev Shares the floor demands for `usdc6` at `rate`, less the tolerance.
    function _minSharesOut(uint256 usdc6, uint256 rate, uint16 toleranceBps) internal pure returns (uint256) {
        uint256 expected = Math.mulDiv(usdc6 * USDC_TO_SHARE_SCALE, ONE, rate);
        uint256 minShares = Math.mulDiv(expected, BPS - toleranceBps, BPS);
        if (minShares == 0) revert InvalidSwapAmountOutMin();
        return minShares;
    }

    /// @dev USDC the floor demands for `shares` at `rate`, less the tolerance,
    ///      never below the caller's own minimum.
    function _minUsdcOut(
        uint256 shares,
        uint256 rate,
        uint16 toleranceBps,
        uint256 callerMin
    ) internal pure returns (uint256) {
        uint256 expected = Math.mulDiv(shares, rate, SHARES_TIMES_RATE_TO_USDC);
        uint256 floor = Math.mulDiv(expected, BPS - toleranceBps, BPS);
        return floor > callerMin ? floor : callerMin;
    }

    /// @dev Caps what the whole book could need to exit at what the venue can
    ///      pay right now.
    function _requireExposureHeadroom(IdleSavingsLayout storage $, uint256 usdc6, uint256 rate) internal view {
        uint256 available = _liquidityAvailable();
        uint256 tracked = Math.mulDiv($.totalShares[PROTOCOL], rate, SHARES_TIMES_RATE_TO_USDC);
        uint256 need = tracked + usdc6;
        if (need > Math.mulDiv(available, MAX_EXPOSURE_BPS, BPS)) revert ExposureCapExceeded(need, available);
    }

    /// @dev Tracked shares for a position, lowered to the Safe's balance when
    ///      shares were moved out around the module.
    function _reconcileShares(
        IdleSavingsLayout storage $,
        address safe,
        uint256 tokenId
    ) internal returns (uint256 tracked) {
        tracked = $.sharesOf[PROTOCOL][tokenId];
        uint256 balance = _shareToken().balanceOf(safe);
        if (balance < tracked) {
            emit IdleSavingsSharesShortfall(safe, tokenId, tracked, balance);
            $.totalShares[PROTOCOL] -= tracked - balance;
            $.sharesOf[PROTOCOL][tokenId] = balance;
            tracked = balance;
        }
    }

    /// @dev Module-mediated ERC20 approve from the Safe. Supports both
    ///      standard bool-returning tokens and no-return tokens, and rejects a
    ///      false return so a failed zero-reset cannot leave venue allowance
    ///      live after an otherwise-successful operation.
    function _safeApprove(address safe, address token, address spender, uint256 amount, uint8 step) internal {
        bytes memory ret = _safeExec(safe, token, abi.encodeCall(IERC20.approve, (spender, amount)), step);
        if (!TokenReturnLib.returnedTrue(ret)) revert TokenApprovalFailed(token);
    }

    /// @dev Module-mediated Safe call with inner-revert bubbling.
    function _safeExec(
        address safe,
        address target,
        bytes memory data,
        uint8 step
    ) internal returns (bytes memory ret) {
        bool ok;
        (ok, ret) = ISafe(safe).execTransactionFromModuleReturnData(target, 0, data, ISafe.Operation.Call);
        if (!ok) {
            if (ret.length > 0) Address.verifyCallResult(ok, ret);
            revert ModuleCallFailed(step);
        }
    }
}
