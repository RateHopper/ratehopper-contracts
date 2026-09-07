// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {ISafe} from "../../interfaces/safe/ISafe.sol";
import {IWETH9} from "../../interfaces/IWETH9.sol";
import {IYieldHandler, OpenLpParams, CloseLpParams, CollectLpParams, WithdrawLpParams, OpenLpInKindParams, SwapLeg} from "../../interfaces/IYieldHandler.sol";
import {PoolKey, ExactInputSingleParams} from "../../interfaces/uniswapV4/V4Types.sol";
import {IV4PositionManager} from "../../interfaces/uniswapV4/IV4PositionManager.sol";
import {IStateView} from "../../interfaces/uniswapV4/IStateView.sol";
import {IUniversalRouter} from "../../interfaces/uniswapV4/IUniversalRouter.sol";
import {IAllowanceTransfer} from "../../interfaces/uniswapV4/IAllowanceTransfer.sol";
import {V4Actions, V4Commands} from "../../interfaces/uniswapV4/V4Constants.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {TokenReturnLib} from "../libraries/TokenReturnLib.sol";
import {TwapOracle} from "../libraries/TwapOracle.sol";
import {YieldStorage} from "./YieldStorage.sol";
import "../../common/Types.sol";

/// @title UniV4YieldHandler
/// @notice Uniswap V4 adapter for SafeYieldManager, implementing IYieldHandler
///         directly (the V4 singleton/actions architecture does not fit
///         BaseYieldHandler's V3-shaped hooks). Pool params are the full
///         PoolKey tuple `abi.encode(currency0, currency1, fee, tickSpacing,
///         hooks)`, so `keccak256(poolParam)` IS the V4 PoolId and the
///         manager's `allowedPoolKey` allow-list pins exactly one pool per
///         param. Native ETH pools (`currency0 == address(0)`) are supported;
///         hooked pools are gated exclusively by the admin allow-list.
/// @dev    STATELESS: MUST NOT declare storage variables — all mutable state
///         lives in the ERC-7201 `YieldStorage` namespace (delegatecall from
///         the manager is layout-safe). Immutables are fine.
/// @dev    V4 differences absorbed here rather than in the manager:
///         - No pool contracts: state reads go through StateView by PoolId.
///         - `modifyLiquidities` returns nothing: the token id is read from
///           `nextTokenId()` before the mint (atomic within the tx), amounts
///           are measured as Safe balance deltas.
///         - Mint takes a LIQUIDITY amount (computed on-chain from the
///           post-swap sqrt price) with amount0Max/amount1Max settle caps;
///           the caller's V3-shaped mintAmount0Min/1Min are enforced post-hoc.
///         - ERC20 input reaches the PositionManager / UniversalRouter via
///           Permit2, so approvals are two-step and both hops are reset to
///           zero in the same flow. Native ETH needs no approvals; it rides
///           as call value and excess mint value is swept back to the Safe.
///         - The live manager cannot receive native ETH, so harvested fees
///           are taken straight to the Safe and `feeCollectBps` is skimmed
///           from the Safe by module call (waive-on-failure, mirroring the
///           manager's performance-fee semantics).
contract UniV4YieldHandler is IYieldHandler, YieldStorage {
    using SafeCast for uint256;

    /// @notice Native ETH sentinel (V4 `currency0` for native pools).
    address internal constant NATIVE = address(0);

    /// @notice Protocol id (canonical ids are the YIELD_PROTOCOL_* constants
    ///         in Types.sol). A constant — this handler is V4-only.
    uint8 public constant PROTOCOL = YIELD_PROTOCOL_UNISWAP_V4;

    IV4PositionManager public immutable POSITION_MANAGER;
    address public immutable UNIVERSAL_ROUTER;
    IAllowanceTransfer public immutable PERMIT2;
    IStateView public immutable STATE_VIEW;
    IERC20 public immutable USDC;
    /// @notice Wrapped native token. In-kind switch legs deal in ERC20s only,
    ///         so a native pool side is wrapped on withdraw / unwrapped on
    ///         open (1:1, no price exposure).
    IWETH9 public immutable WETH;

    /// @dev Own deployment address, captured at construction to enforce
    ///      delegatecall-only entry (a direct call would run against the
    ///      handler's empty storage).
    address private immutable __self = address(this);

    error OnlyDelegatecall();
    error TokenApprovalFailed(address token);
    /// @notice V4 has no stakePool; `OpenLpParams.stake` must be false.
    error StakingNotSupported();
    /// @notice V4 mint has no native amount minimums (only settle caps), so
    ///         the caller's mintAmount0Min/1Min are enforced after the mint
    ///         against the amounts actually consumed.
    error MintAmountBelowMin();

    /// @dev Inputs for `_mintFromAmounts`, the mint half shared by `openLp`
    ///      and `openLpInKind`. Grouped in a struct so the shared helper takes
    ///      three arguments instead of ten — the flat form pushes both callers
    ///      past the stack limit once coverage instrumentation is layered on.
    struct MintArgs {
        address onBehalfOf;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0;
        uint256 amount1;
        uint256 mintAmount0Min;
        uint256 mintAmount1Min;
        uint256 deadline;
    }

    /// @dev The five module-call step codes a Permit2 swap reports failures
    ///      under. Grouped for the same reason as `MintArgs`: passing them flat
    ///      alongside the swap's own arguments overruns the stack under viaIR.
    struct SwapSteps {
        uint8 approveStep;
        uint8 permit2Step;
        uint8 execStep;
        uint8 permit2ResetStep;
        uint8 resetStep;
    }

    modifier onlyDelegatecall() {
        if (address(this) == __self) revert OnlyDelegatecall();
        _;
    }

    constructor(
        IV4PositionManager _positionManager,
        address _universalRouter,
        IAllowanceTransfer _permit2,
        IStateView _stateView,
        IERC20 _usdc,
        IWETH9 _weth
    ) {
        if (address(_positionManager) == address(0)) revert ZeroAddress();
        if (_universalRouter == address(0)) revert ZeroAddress();
        if (address(_permit2) == address(0)) revert ZeroAddress();
        if (address(_stateView) == address(0)) revert ZeroAddress();
        if (address(_usdc) == address(0)) revert ZeroAddress();
        if (address(_weth) == address(0)) revert ZeroAddress();

        POSITION_MANAGER = _positionManager;
        UNIVERSAL_ROUTER = _universalRouter;
        PERMIT2 = _permit2;
        STATE_VIEW = _stateView;
        USDC = _usdc;
        WETH = _weth;
    }

    // ─────────────────────────────────────────────────────────────────────
    //  IYieldHandler
    // ─────────────────────────────────────────────────────────────────────

    /// @inheritdoc IYieldHandler
    function poolTokens(bytes calldata lpPoolParam) external pure returns (address token0, address token1) {
        PoolKey memory key = _decodePoolParam(lpPoolParam);
        return (key.currency0, key.currency1);
    }

    /// @inheritdoc IYieldHandler
    function openLp(
        OpenLpParams calldata p
    ) external onlyDelegatecall returns (uint256 tokenId, uint128 basisUsd6, uint128 used0, uint128 used1) {
        if (p.stake) revert StakingNotSupported();
        _validatePoolParamAllowed(p.lpPoolParam);
        (PoolKey memory key, ) = _validatePoolReady(p.lpPoolParam);

        uint256 half0 = p.usdcAmount / 2;
        uint256 half1 = p.usdcAmount - half0;

        uint256 desired0 = _acquireSide(p, key.currency0, half0, p.swap0, SwapSteps(41, 42, 43, 44, 45));
        uint256 desired1 = _acquireSide(p, key.currency1, half1, p.swap1, SwapSteps(46, 47, 48, 49, 50));

        // The leg swaps above moved the pool price, so the mint must price
        // against a FRESH read — not the one `_validatePoolReady` returned.
        (uint160 sqrtPriceX96, , , ) = STATE_VIEW.getSlot0(keccak256(p.lpPoolParam));
        (tokenId, used0, used1) = _mintFromAmounts(
            key,
            sqrtPriceX96,
            MintArgs({
                onBehalfOf: p.onBehalfOf,
                tickLower: p.tickLower,
                tickUpper: p.tickUpper,
                amount0: desired0,
                amount1: desired1,
                mintAmount0Min: p.mintAmount0Min,
                mintAmount1Min: p.mintAmount1Min,
                deadline: p.deadline
            })
        );

        // Value each leg at its just-executed swap rate (identity for USDC).
        basisUsd6 = (_legValueUsdc(key.currency0, used0, half0, desired0) +
            _legValueUsdc(key.currency1, used1, half1, desired1)).toUint128();
    }

    /// @inheritdoc IYieldHandler
    function closeLp(
        CloseLpParams calldata p,
        uint128 basisForExit
    ) external onlyDelegatecall returns (uint128 currentValueUsd6) {
        (PoolKey memory key, ) = POSITION_MANAGER.getPoolAndPositionInfo(p.tokenId);
        uint128 liquidity = POSITION_MANAGER.getPositionLiquidity(p.tokenId);
        _validateSwapLeg(key.currency0, p.swap0, p.slippageBps);
        _validateSwapLeg(key.currency1, p.swap1, p.slippageBps);
        _requireOwnedBy(p.onBehalfOf, p.tokenId);

        // Measure only deltas from this close (USDC sides need no snapshot —
        // their swap leg is skipped and the USDC delta is measured below).
        uint256 t0Before = key.currency0 == address(USDC) ? 0 : _balanceOf(key.currency0, p.onBehalfOf);
        uint256 t1Before = key.currency1 == address(USDC) ? 0 : _balanceOf(key.currency1, p.onBehalfOf);
        uint256 usdcBefore = USDC.balanceOf(p.onBehalfOf);

        // Harvest fees before principal so feeCollectBps does not tax capital.
        _collectV4Fees(p.onBehalfOf, p.tokenId, key);

        // On full close, BURN_POSITION auto-decreases all remaining liquidity.
        uint128 liquidityToRemove = p.exitBps == 10_000
            ? liquidity
            : Math.mulDiv(uint256(liquidity), uint256(p.exitBps), 10_000).toUint128();

        // Do not let the manager's basis decrement stand when rounding
        // removes zero liquidity (basis would shrink while principal stays).
        if (p.exitBps != 10_000 && basisForExit > 0 && liquidityToRemove == 0) {
            revert InvalidExitBps();
        }

        if (p.exitBps == 10_000) {
            bytes[] memory params = new bytes[](2);
            params[0] = abi.encode(
                p.tokenId,
                p.decreaseAmount0Min.toUint128(),
                p.decreaseAmount1Min.toUint128(),
                bytes("")
            );
            params[1] = abi.encode(key.currency0, key.currency1, p.onBehalfOf);
            _safeModifyLiquidities(
                p.onBehalfOf,
                abi.encodePacked(V4Actions.BURN_POSITION, V4Actions.TAKE_PAIR),
                params,
                p.deadline,
                62
            );
        } else if (liquidityToRemove > 0) {
            bytes[] memory params = new bytes[](2);
            params[0] = abi.encode(
                p.tokenId,
                uint256(liquidityToRemove),
                p.decreaseAmount0Min.toUint128(),
                p.decreaseAmount1Min.toUint128(),
                bytes("")
            );
            params[1] = abi.encode(key.currency0, key.currency1, p.onBehalfOf);
            _safeModifyLiquidities(
                p.onBehalfOf,
                abi.encodePacked(V4Actions.DECREASE_LIQUIDITY, V4Actions.TAKE_PAIR),
                params,
                p.deadline,
                61
            );
        }

        // Swap the non-USDC legs this close produced back to USDC. The deltas
        // are dynamic (principal + harvested fees), so a residue whose floor
        // rounds to zero stays in kind rather than failing the whole exit.
        _swapDeltaToUsdc(
            p.onBehalfOf,
            key.currency0,
            t0Before,
            p.swap0,
            p.deadline,
            p.slippageBps,
            SwapSteps(63, 64, 65, 66, 67),
            true
        );
        _swapDeltaToUsdc(
            p.onBehalfOf,
            key.currency1,
            t1Before,
            p.swap1,
            p.deadline,
            p.slippageBps,
            SwapSteps(68, 69, 70, 71, 72),
            true
        );

        currentValueUsd6 = (USDC.balanceOf(p.onBehalfOf) - usdcBefore).toUint128();
        // Caller's final-value guard on gross realized USDC.
        if (uint256(currentValueUsd6) < p.minUsdcOut) revert MinUsdcOutNotMet();
    }

    /// @inheritdoc IYieldHandler
    /// @dev In-kind close leg of a switch: fee harvest + full BURN_POSITION
    ///      with NO swaps. A native side is wrapped to WETH so the caller
    ///      always receives ERC20 addresses and amounts.
    function withdrawLp(
        WithdrawLpParams calldata p
    ) external onlyDelegatecall returns (address token0, address token1, uint256 amount0, uint256 amount1) {
        (PoolKey memory key, ) = POSITION_MANAGER.getPoolAndPositionInfo(p.tokenId);
        _requireOwnedBy(p.onBehalfOf, p.tokenId);

        uint256 c0Before = _balanceOf(key.currency0, p.onBehalfOf);
        uint256 c1Before = _balanceOf(key.currency1, p.onBehalfOf);

        // Harvest fees before principal so feeCollectBps does not tax capital.
        _collectV4Fees(p.onBehalfOf, p.tokenId, key);

        // BURN_POSITION auto-decreases all remaining liquidity.
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            p.tokenId,
            p.decreaseAmount0Min.toUint128(),
            p.decreaseAmount1Min.toUint128(),
            bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1, p.onBehalfOf);
        _safeModifyLiquidities(
            p.onBehalfOf,
            abi.encodePacked(V4Actions.BURN_POSITION, V4Actions.TAKE_PAIR),
            params,
            p.deadline,
            62
        );

        amount0 = _balanceOf(key.currency0, p.onBehalfOf) - c0Before;
        amount1 = _balanceOf(key.currency1, p.onBehalfOf) - c1Before;

        token0 = key.currency0;
        token1 = key.currency1;
        if (key.currency0 == NATIVE) {
            if (amount0 > 0) {
                _safeExecValue(p.onBehalfOf, address(WETH), amount0, abi.encodeCall(IWETH9.deposit, ()), 73);
            }
            token0 = address(WETH);
        }
    }

    /// @inheritdoc IYieldHandler
    /// @dev In-kind open leg of a switch: mint straight from the withdrawn
    ///      token amounts — no swaps. A native pool side settles in ETH, so
    ///      the provided WETH is unwrapped first (1:1, no price exposure);
    ///      SWEEP returns any unconsumed ETH to the Safe.
    function openLpInKind(
        OpenLpInKindParams calldata p
    ) external onlyDelegatecall returns (uint256 tokenId, uint128 used0, uint128 used1) {
        _validatePoolParamAllowed(p.lpPoolParam);
        (PoolKey memory key, uint160 sqrtPriceX96) = _validatePoolReady(p.lpPoolParam);
        bool native0 = key.currency0 == NATIVE;
        address want0 = native0 ? address(WETH) : key.currency0;
        if (p.token0 != want0 || p.token1 != key.currency1) revert WrongTokenPair();

        if (native0 && p.amount0 > 0) {
            _safeExecValue(p.onBehalfOf, address(WETH), 0, abi.encodeCall(IWETH9.withdraw, (p.amount0)), 74);
        }

        // No swaps ran, so the price `_validatePoolReady` read is still live.
        (tokenId, used0, used1) = _mintFromAmounts(
            key,
            sqrtPriceX96,
            MintArgs({
                onBehalfOf: p.onBehalfOf,
                tickLower: p.tickLower,
                tickUpper: p.tickUpper,
                amount0: p.amount0,
                amount1: p.amount1,
                mintAmount0Min: p.mintAmount0Min,
                mintAmount1Min: p.mintAmount1Min,
                deadline: p.deadline
            })
        );
    }

    /// @dev The mint half shared by `openLp` and `openLpInKind`. Derives the
    ///      liquidity for `amount0/amount1` at `sqrtPriceX96`, grants the
    ///      two-step Permit2 allowances (a native side rides as call value and
    ///      needs none), mints, resets BOTH allowance hops, and reports what
    ///      the mint actually consumed. `modifyLiquidities` returns nothing, so
    ///      the token id comes from `nextTokenId()` before the mint (atomic
    ///      within this tx) and consumption is measured as Safe balance deltas.
    function _mintFromAmounts(
        PoolKey memory key,
        uint160 sqrtPriceX96,
        MintArgs memory a
    ) internal returns (uint256 tokenId, uint128 used0, uint128 used1) {
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(a.tickLower),
            TickMath.getSqrtPriceAtTick(a.tickUpper),
            a.amount0,
            a.amount1
        );
        if (liquidity == 0 || liquidity < _yieldStorage().minPositionLiquidity[PROTOCOL]) {
            revert PositionLiquidityTooLow();
        }

        bool native0 = key.currency0 == NATIVE;
        if (!native0) {
            _safeApprove(a.onBehalfOf, key.currency0, address(PERMIT2), a.amount0, 51);
            _permit2Approve(a.onBehalfOf, key.currency0, address(POSITION_MANAGER), a.amount0, a.deadline, 52);
        }
        _safeApprove(a.onBehalfOf, key.currency1, address(PERMIT2), a.amount1, 53);
        _permit2Approve(a.onBehalfOf, key.currency1, address(POSITION_MANAGER), a.amount1, a.deadline, 54);

        tokenId = POSITION_MANAGER.nextTokenId();
        uint256 bal0Before = _balanceOf(key.currency0, a.onBehalfOf);
        uint256 bal1Before = _balanceOf(key.currency1, a.onBehalfOf);

        _safeMintLp(a.onBehalfOf, key, a.tickLower, a.tickUpper, liquidity, a.amount0, a.amount1, a.deadline);

        if (!native0) {
            _permit2Approve(a.onBehalfOf, key.currency0, address(POSITION_MANAGER), 0, 0, 56);
            _safeApprove(a.onBehalfOf, key.currency0, address(PERMIT2), 0, 57);
        }
        _permit2Approve(a.onBehalfOf, key.currency1, address(POSITION_MANAGER), 0, 0, 58);
        _safeApprove(a.onBehalfOf, key.currency1, address(PERMIT2), 0, 59);

        used0 = (bal0Before - _balanceOf(key.currency0, a.onBehalfOf)).toUint128();
        used1 = (bal1Before - _balanceOf(key.currency1, a.onBehalfOf)).toUint128();
        if (used0 < a.mintAmount0Min || used1 < a.mintAmount1Min) revert MintAmountBelowMin();

        _requireOwnedBy(a.onBehalfOf, tokenId);
    }

    /// @inheritdoc IYieldHandler
    function collectLp(CollectLpParams calldata p) external onlyDelegatecall {
        // V4 has no stakePool: `swapRewardToUsdc` / `rewardSwap` are ignored,
        // matching how unstaked positions behave on the staking protocols.
        (PoolKey memory key, ) = POSITION_MANAGER.getPoolAndPositionInfo(p.tokenId);
        _requireOwnedBy(p.onBehalfOf, p.tokenId);

        // Swap params are validated only on the swap path; the no-swap
        // path intentionally ignores them.
        uint256 t0Before;
        uint256 t1Before;
        if (p.swapFeesToUsdc) {
            if (block.timestamp > p.deadline) revert DeadlineExpired();
            _validateSwapLeg(key.currency0, p.swap0, p.slippageBps);
            _validateSwapLeg(key.currency1, p.swap1, p.slippageBps);
            t0Before = key.currency0 == address(USDC) ? 0 : _balanceOf(key.currency0, p.onBehalfOf);
            t1Before = key.currency1 == address(USDC) ? 0 : _balanceOf(key.currency1, p.onBehalfOf);
        }

        _collectV4Fees(p.onBehalfOf, p.tokenId, key);
        if (p.swapFeesToUsdc) {
            _swapDeltaToUsdc(
                p.onBehalfOf,
                key.currency0,
                t0Before,
                p.swap0,
                p.deadline,
                p.slippageBps,
                SwapSteps(63, 64, 65, 66, 67),
                true
            );
            _swapDeltaToUsdc(
                p.onBehalfOf,
                key.currency1,
                t1Before,
                p.swap1,
                p.deadline,
                p.slippageBps,
                SwapSteps(68, 69, 70, 71, 72),
                true
            );
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Open internals
    // ─────────────────────────────────────────────────────────────────────

    /// @dev Acquire one mint side from its USDC half: identity for USDC, a
    ///      leg-validated swap for any other currency (incl. native ETH).
    ///      The swap input is always USDC, so all five module steps apply.
    function _acquireSide(
        OpenLpParams calldata p,
        address currency,
        uint256 halfUsdc,
        SwapLeg calldata leg,
        SwapSteps memory steps
    ) internal returns (uint256 received) {
        if (currency == address(USDC)) return halfUsdc;

        // Allow-list membership is an open-side check only (see `_validateSwapLeg`).
        _validatePoolParamAllowed(leg.poolParam);
        _validateSwapLeg(currency, leg, p.slippageBps);
        // Only consume tokens produced by this call, never pre-existing ones.
        uint256 balanceBefore = _balanceOf(currency, p.onBehalfOf);
        _swapV4ViaSafe(
            p.onBehalfOf,
            address(USDC),
            currency,
            leg.poolParam,
            halfUsdc,
            leg.amountOutMin,
            p.deadline,
            p.slippageBps,
            steps,
            false
        );
        received = _balanceOf(currency, p.onBehalfOf) - balanceBefore;
        // Avoid accidental one-sided mints after a zero-output swap.
        if (received == 0) revert SwapFailed();
    }

    /// @dev Module-mediated V4 mint: MINT_POSITION + SETTLE_PAIR, plus a
    ///      SWEEP back to the Safe on native pools (the mint's call value is
    ///      the acquired ETH; SETTLE consumes only what the liquidity needs).
    function _safeMintLp(
        address _onBehalfOf,
        PoolKey memory key,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint256 desired0,
        uint256 desired1,
        uint256 deadline
    ) internal {
        bool native = key.currency0 == NATIVE;
        bytes memory actions = native
            ? abi.encodePacked(V4Actions.MINT_POSITION, V4Actions.SETTLE_PAIR, V4Actions.SWEEP)
            : abi.encodePacked(V4Actions.MINT_POSITION, V4Actions.SETTLE_PAIR);
        bytes[] memory params = new bytes[](native ? 3 : 2);
        params[0] = abi.encode(
            key,
            tickLower,
            tickUpper,
            uint256(liquidity),
            desired0.toUint128(),
            desired1.toUint128(),
            _onBehalfOf,
            bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1);
        if (native) params[2] = abi.encode(key.currency0, _onBehalfOf);

        _safeExecValue(
            _onBehalfOf,
            address(POSITION_MANAGER),
            native ? desired0 : 0,
            abi.encodeCall(IV4PositionManager.modifyLiquidities, (abi.encode(actions, params), deadline)),
            55
        );
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Fee collection
    // ─────────────────────────────────────────────────────────────────────

    /// @dev Harvest accrued fees with the canonical V4 pattern (decrease of 0
    ///      liquidity + TAKE_PAIR). Fees are taken straight to the SAFE — the
    ///      live manager has no receive() and cannot hold native ETH — and
    ///      `feeCollectBps` is then skimmed from the Safe by module call.
    function _collectV4Fees(address _onBehalfOf, uint256 tokenId, PoolKey memory key) internal {
        uint256 c0Before = _balanceOf(key.currency0, _onBehalfOf);
        uint256 c1Before = _balanceOf(key.currency1, _onBehalfOf);

        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(tokenId, uint256(0), uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1, _onBehalfOf);
        _safeModifyLiquidities(
            _onBehalfOf,
            abi.encodePacked(V4Actions.DECREASE_LIQUIDITY, V4Actions.TAKE_PAIR),
            params,
            // Fee harvest carries no price exposure; the flows' own deadline
            // checks (manager openLp/closeLp, collectLp swap path) still gate.
            block.timestamp,
            60
        );

        uint256 collected0 = _balanceOf(key.currency0, _onBehalfOf) - c0Before;
        uint256 collected1 = _balanceOf(key.currency1, _onBehalfOf) - c1Before;

        uint256 fee0 = _chargeCollectFee(key.currency0, collected0, _onBehalfOf, tokenId);
        uint256 fee1 = _chargeCollectFee(key.currency1, collected1, _onBehalfOf, tokenId);

        emit FeesCollected(
            _onBehalfOf,
            PROTOCOL,
            tokenId,
            key.currency0,
            collected0,
            fee0,
            key.currency1,
            collected1,
            fee1
        );
    }

    /// @dev Skim `feeCollectBps` from the Safe to the treasury by module
    ///      call (the harvested amount already sits on the Safe). A failed
    ///      transfer waives the fee instead of blocking users — the same
    ///      semantics as the base handlers and the manager's performance fee.
    function _chargeCollectFee(
        address currency,
        uint256 amount,
        address _onBehalfOf,
        uint256 tokenId
    ) internal returns (uint256 fee) {
        if (amount == 0) return 0;
        YieldLayout storage $ = _yieldStorage();
        fee = (amount * $.feeCollectBps) / 10_000;
        if (fee == 0) return 0;

        bool ok;
        bytes memory ret;
        if (currency == NATIVE) {
            (ok, ret) = ISafe(_onBehalfOf).execTransactionFromModuleReturnData(
                $.treasury,
                fee,
                "",
                ISafe.Operation.Call
            );
        } else {
            (ok, ret) = ISafe(_onBehalfOf).execTransactionFromModuleReturnData(
                currency,
                0,
                abi.encodeCall(IERC20.transfer, ($.treasury, fee)),
                ISafe.Operation.Call
            );
            if (ok) ok = TokenReturnLib.returnedTrue(ret);
        }
        if (!ok) {
            emit CollectFeeTransferFailed(_onBehalfOf, tokenId, currency, fee);
            fee = 0;
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Swaps
    // ─────────────────────────────────────────────────────────────────────

    /// @dev Module-mediated exact-input single V4 swap on the UniversalRouter;
    ///      calldata is built on-chain so callers cannot inject alternative
    ///      routes. ERC20 input goes through the two-step Permit2 approval
    ///      (both hops reset after); native ETH input rides as call value and
    ///      needs no approvals. `msg.sender` of `execute` is the Safe, so
    ///      SETTLE_ALL pulls from and TAKE_ALL pays to the Safe directly.
    function _swapV4ViaSafe(
        address _onBehalfOf,
        address currencyIn,
        address currencyOut,
        bytes memory poolParam,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 deadline,
        uint16 slippageBps,
        SwapSteps memory steps,
        bool leaveZeroFloorInKind
    ) internal {
        // Single funnel for every UniversalRouter call in this handler.
        amountOutMin = _twapMinOut(currencyIn, currencyOut, amountIn, amountOutMin, slippageBps);
        if (amountOutMin == 0) {
            if (leaveZeroFloorInKind) {
                emit SwapSkippedBelowFloor(_onBehalfOf, currencyIn, amountIn);
                return;
            }
            revert InvalidSwapAmountOutMin();
        }
        PoolKey memory key = _decodePoolParam(poolParam);

        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            ExactInputSingleParams({
                poolKey: key,
                zeroForOne: currencyIn == key.currency0,
                amountIn: amountIn.toUint128(),
                amountOutMinimum: amountOutMin.toUint128(),
                hookData: bytes("")
            })
        );
        params[1] = abi.encode(currencyIn, amountIn); // SETTLE_ALL: pay input from the Safe
        params[2] = abi.encode(currencyOut, amountOutMin); // TAKE_ALL: output to the Safe, router-level floor

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(
            abi.encodePacked(V4Actions.SWAP_EXACT_IN_SINGLE, V4Actions.SETTLE_ALL, V4Actions.TAKE_ALL),
            params
        );
        bytes memory execData = abi.encodeCall(
            IUniversalRouter.execute,
            (abi.encodePacked(V4Commands.V4_SWAP), inputs, deadline)
        );

        if (currencyIn == NATIVE) {
            _safeExecValue(_onBehalfOf, UNIVERSAL_ROUTER, amountIn, execData, steps.execStep);
        } else {
            _safeApprove(_onBehalfOf, currencyIn, address(PERMIT2), amountIn, steps.approveStep);
            _permit2Approve(_onBehalfOf, currencyIn, UNIVERSAL_ROUTER, amountIn, deadline, steps.permit2Step);
            _safeExecValue(_onBehalfOf, UNIVERSAL_ROUTER, 0, execData, steps.execStep);
            _permit2Approve(_onBehalfOf, currencyIn, UNIVERSAL_ROUTER, 0, 0, steps.permit2ResetStep);
            _safeApprove(_onBehalfOf, currencyIn, address(PERMIT2), 0, steps.resetStep);
        }
    }

    /// @dev Swap the `currency` the Safe accrued since `balanceBefore` back
    ///      to USDC. No-op for the USDC side itself — its "delta" IS the
    ///      realized output, measured by the caller.
    function _swapDeltaToUsdc(
        address _onBehalfOf,
        address currency,
        uint256 balanceBefore,
        SwapLeg calldata leg,
        uint256 deadline,
        uint16 slippageBps,
        SwapSteps memory steps,
        bool leaveZeroFloorInKind
    ) internal {
        if (currency == address(USDC)) return;
        uint256 delta = _balanceOf(currency, _onBehalfOf) - balanceBefore;
        if (delta > 0) {
            _swapV4ViaSafe(
                _onBehalfOf,
                currency,
                address(USDC),
                leg.poolParam,
                delta,
                leg.amountOutMin,
                deadline,
                slippageBps,
                steps,
                leaveZeroFloorInKind
            );
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Validation
    // ─────────────────────────────────────────────────────────────────────

    function _decodePoolParam(bytes memory poolParam) internal pure returns (PoolKey memory) {
        return abi.decode(poolParam, (PoolKey));
    }

    function _validatePoolParamAllowed(bytes memory poolParam) internal view {
        if (!_yieldStorage().allowedPoolKey[PROTOCOL][keccak256(poolParam)]) revert PoolParamNotAllowed();
    }

    /// @dev V4 analogue of the base's `_validatePool`: the pool has no
    ///      contract, so "exists" collapses into "initialized" (V4 pools are
    ///      lazily created; an uninitialized PoolId reads a zero sqrt price).
    function _validatePoolReady(
        bytes memory poolParam
    ) internal view returns (PoolKey memory key, uint160 sqrtPriceX96) {
        key = _decodePoolParam(poolParam);
        bytes32 poolId = keccak256(poolParam);
        (sqrtPriceX96, , , ) = STATE_VIEW.getSlot0(poolId);
        if (sqrtPriceX96 == 0) revert PoolNotInitialized();
        uint128 floor = _yieldStorage().minPoolLiquidity[PROTOCOL];
        if (floor > 0 && STATE_VIEW.getLiquidity(poolId) < floor) revert PoolTooThin();
    }

    /// @dev Route checks only: a hookless, initialized pool above the liquidity
    ///      floor that actually trades {currency, USDC} (native ETH sorts
    ///      first: address(0) < any token). The USDC side of a pair has no
    ///      swap, so its (ignored) leg is not validated. Allow-list membership
    ///      is checked by opens only (`_acquireSide`): exits must survive a
    ///      de-listing, and the price is protected by the TWAP floor, not the
    ///      allow-list (SECURITY_MODEL.md). The PRICE check needs the input
    ///      amount and so lives in `_swapV4ViaSafe`.
    function _validateSwapLeg(address currency, SwapLeg calldata leg, uint16 slippageBps) internal view {
        if (currency == address(USDC)) return;
        if (slippageBps == 0) revert SlippageTooLow();
        if (slippageBps > _yieldStorage().maxSlippageBps) revert SlippageAboveMax();
        (address expect0, address expect1) = currency < address(USDC)
            ? (currency, address(USDC))
            : (address(USDC), currency);
        (PoolKey memory key, ) = _validatePoolReady(leg.poolParam);
        if (key.currency0 != expect0 || key.currency1 != expect1) revert WrongTokenPair();
    }

    /// @dev Min-out for a UniversalRouter call, read from the SAME Uniswap V3
    ///      reference history the V3 and Aerodrome handlers use — the reference
    ///      prices a token, not a venue. Native ETH uses the address(0) config
    ///      key, while quote orientation substitutes WETH so the sentinel is
    ///      never passed to tick math. Caller may tighten, never loosen.
    function _twapMinOut(
        address currencyIn,
        address currencyOut,
        uint256 amountIn,
        uint256 callerMinOut,
        uint16 slippageBps
    ) internal view returns (uint256) {
        address currency = currencyIn == address(USDC) ? currencyOut : currencyIn;
        TwapConfig memory cfg = _yieldStorage().twapConfigOf[currency];
        if (cfg.pool == address(0)) revert TwapOracle.TwapNotConfigured(currency);
        address tokenIn = currencyIn == NATIVE ? address(WETH) : currencyIn;
        address tokenOut = currencyOut == NATIVE ? address(WETH) : currencyOut;
        uint256 floor = Math.mulDiv(TwapOracle.quote(cfg, tokenIn, tokenOut, amountIn), 10_000 - slippageBps, 10_000);
        return callerMinOut > floor ? callerMinOut : floor;
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Shared internals
    // ─────────────────────────────────────────────────────────────────────

    /// @dev Balance read that treats address(0) as native ETH.
    function _balanceOf(address currency, address account) internal view returns (uint256) {
        return currency == NATIVE ? account.balance : IERC20(currency).balanceOf(account);
    }

    /// @dev USDC value of a mint leg: the used amount itself for USDC, else
    ///      the used amount priced at the leg's just-executed swap rate
    ///      (`halfUsdc` bought `received`, the mint consumed `used` of it).
    function _legValueUsdc(
        address currency,
        uint128 used,
        uint256 halfUsdc,
        uint256 received
    ) internal view returns (uint256) {
        if (currency == address(USDC)) return uint256(used);
        return Math.mulDiv(uint256(used), halfUsdc, received);
    }

    /// @dev Require the Safe to own `tokenId` on the position manager.
    function _requireOwnedBy(address _onBehalfOf, uint256 tokenId) internal view {
        if (IERC721(address(POSITION_MANAGER)).ownerOf(tokenId) != _onBehalfOf) revert LpNotOnSafe();
    }

    /// @dev Module-mediated `modifyLiquidities` batch (no call value — the
    ///      only value-bearing batch is the native mint in `_safeMintLp`).
    function _safeModifyLiquidities(
        address _onBehalfOf,
        bytes memory actions,
        bytes[] memory params,
        uint256 deadline,
        uint8 step
    ) internal {
        _safeExecValue(
            _onBehalfOf,
            address(POSITION_MANAGER),
            0,
            abi.encodeCall(IV4PositionManager.modifyLiquidities, (abi.encode(actions, params), deadline)),
            step
        );
    }

    /// @dev Module-mediated Permit2 sub-allowance update. Grants expire at
    ///      the flow's deadline so even a missed reset dies on its own.
    function _permit2Approve(
        address _onBehalfOf,
        address token,
        address spender,
        uint256 amount,
        uint256 expiration,
        uint8 step
    ) internal {
        _safeExecValue(
            _onBehalfOf,
            address(PERMIT2),
            0,
            abi.encodeCall(IAllowanceTransfer.approve, (token, spender, amount.toUint160(), uint48(expiration))),
            step
        );
    }

    /// @dev Module-mediated ERC20 approve from the Safe. Supports both
    ///      standard bool-returning tokens and no-return tokens, and rejects a
    ///      false return so a failed zero-reset cannot leave Permit2 allowance
    ///      live after an otherwise-successful operation.
    function _safeApprove(address _onBehalfOf, address token, address spender, uint256 amount, uint8 step) internal {
        bytes memory ret = _safeExecValue(
            _onBehalfOf,
            token,
            0,
            abi.encodeCall(IERC20.approve, (spender, amount)),
            step
        );
        if (!TokenReturnLib.returnedTrue(ret)) revert TokenApprovalFailed(token);
    }

    /// @dev Module-mediated Safe call with inner-revert bubbling and native
    ///      call value (the base's `_safeExec` hardcodes value 0; native V4
    ///      settlement needs it).
    function _safeExecValue(
        address _onBehalfOf,
        address target,
        uint256 value,
        bytes memory data,
        uint8 step
    ) internal returns (bytes memory ret) {
        bool ok;
        (ok, ret) = ISafe(_onBehalfOf).execTransactionFromModuleReturnData(target, value, data, ISafe.Operation.Call);
        if (!ok) {
            if (ret.length > 0) Address.verifyCallResult(ok, ret);
            revert ModuleCallFailed(step);
        }
    }
}
