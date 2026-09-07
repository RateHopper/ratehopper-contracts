// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {ISafe} from "../../interfaces/safe/ISafe.sol";
import {INonfungiblePositionManager} from "../../interfaces/uniswapV3/INonfungiblePositionManager.sol";
import {IYieldHandler, OpenLpParams, CloseLpParams, CollectLpParams, WithdrawLpParams, OpenLpInKindParams, SwapLeg} from "../../interfaces/IYieldHandler.sol";
import {TokenReturnLib} from "../libraries/TokenReturnLib.sol";
import {TwapOracle} from "../libraries/TwapOracle.sol";
import {YieldStorage} from "./YieldStorage.sol";
import "../../common/Types.sol";

/// @dev Surface shared by Uniswap V3 pools and Aerodrome Slipstream CL pools.
///      `slot0` is NOT here — its return arity differs, so reading the sqrt
///      price goes through the `_poolSqrtPriceX96` hook.
interface IPoolMinimal {
    function token0() external view returns (address);

    function token1() external view returns (address);

    function liquidity() external view returns (uint128);
}

/// @title BaseYieldHandler
/// @notice Shared open/close/collect flow for LP positions of ANY token pair
///         on V3-style concentrated-liquidity protocols, executed via
///         delegatecall from SafeYieldManager. The pair is part of the pool
///         identity carried in the ABI-encoded pool params; USDC stays the
///         sole funding and accounting currency — each non-USDC side is
///         acquired/realized through its own USDC swap leg (a side that IS
///         USDC needs no swap). Protocol differences are isolated in virtual
///         hooks (pool resolution, pair decoding, sqrt-price read, swap
///         calldata, mint calldata, position decoding). A protocol whose
///         mechanics don't fit this shape (e.g. Uniswap V4) can bypass this
///         base entirely and implement IYieldHandler directly.
/// @dev    STATELESS: this contract and its children MUST NOT declare
///         storage variables. All mutable state is read from the ERC-7201
///         `YieldStorage` namespace so delegatecall from the manager is
///         layout-safe. Immutables are fine (they live in code).
/// @dev    `decreaseLiquidity` / `collect` / `burn` are ABI-identical across
///         Uniswap V3 and Slipstream position managers, so they are encoded
///         here against the Uniswap interface for both.
abstract contract BaseYieldHandler is IYieldHandler, YieldStorage {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    /// @notice Protocol id (canonical ids are the YIELD_PROTOCOL_* constants
    ///         in Types.sol; plain uint8 so the manager stays extensible).
    uint8 public immutable PROTOCOL;
    address public immutable POSITION_MANAGER;
    IERC20 public immutable USDC;
    address public immutable SWAP_ROUTER;

    /// @dev Own deployment address, captured at construction to enforce
    ///      delegatecall-only entry (a direct call would run against the
    ///      handler's empty storage).
    address private immutable __self = address(this);

    error OnlyDelegatecall();
    error TokenApprovalFailed(address token);
    /// @notice Thrown when `OpenLpParams.stake` is set for a protocol whose
    ///         handler has no stakePool (e.g. Uniswap V3) or whose stakePool
    ///         no longer accepts deposits (`_stakePoolAcceptsDeposits`).
    error StakingNotSupported();

    /// @dev Inputs for `_mintFromAmounts`, the mint half shared by `openLp`
    ///      and `openLpInKind`. Grouped in a struct so the shared helper takes
    ///      three arguments instead of eleven — the flat form pushes both
    ///      callers past the stack limit once coverage instrumentation is
    ///      layered on (viaIR, see .solcover.js).
    struct MintArgs {
        address onBehalfOf;
        bytes lpPoolParam;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0;
        uint256 amount1;
        uint256 mintAmount0Min;
        uint256 mintAmount1Min;
        uint256 deadline;
    }

    modifier onlyDelegatecall() {
        if (address(this) == __self) revert OnlyDelegatecall();
        _;
    }

    constructor(uint8 _protocol, address _positionManager, IERC20 _usdc, address _swapRouter) {
        if (_positionManager == address(0)) revert ZeroAddress();
        if (address(_usdc) == address(0)) revert ZeroAddress();
        if (_swapRouter == address(0)) revert ZeroAddress();

        PROTOCOL = _protocol;
        POSITION_MANAGER = _positionManager;
        USDC = _usdc;
        SWAP_ROUTER = _swapRouter;
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Protocol hooks
    // ─────────────────────────────────────────────────────────────────────

    /// @dev Resolve the pool for an ABI-encoded pool param.
    function _getPool(bytes memory poolParam) internal view virtual returns (address);

    /// @dev Decode the (token0, token1) pair declared by a pool param.
    function _poolTokens(bytes memory poolParam) internal pure virtual returns (address token0, address token1);

    /// @inheritdoc IYieldHandler
    function poolTokens(bytes calldata lpPoolParam) external pure returns (address token0, address token1) {
        return _poolTokens(lpPoolParam);
    }

    /// @inheritdoc IYieldHandler
    function poolParamHasHooks(bytes calldata) external pure returns (bool) {
        return false;
    }

    /// @dev Read `sqrtPriceX96` from a pool (slot0 arity differs per protocol).
    function _poolSqrtPriceX96(address pool) internal view virtual returns (uint160);

    /// @dev Build exact-input-single swap calldata for the pinned router.
    function _buildSwapCalldata(
        address tokenIn,
        address tokenOut,
        bytes memory poolParam,
        address recipient,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 deadline
    ) internal view virtual returns (bytes memory);

    /// @dev Build NPM mint calldata (MintParams shapes differ per protocol).
    function _buildMintCalldata(
        bytes memory lpPoolParam,
        int24 tickLower,
        int24 tickUpper,
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 amount0Min,
        uint256 amount1Min,
        address recipient,
        uint256 deadline
    ) internal view virtual returns (bytes memory);

    /// @dev Decode `positions(tokenId)` (fee vs tickSpacing slot differs).
    function _position(
        uint256 tokenId
    ) internal view virtual returns (address token0, address token1, bytes memory lpPoolParam, uint128 liquidity);

    /// @dev Stake the just-minted NFT into the protocol's stakePool. Default: the
    ///      protocol has no stakePool, so opting in reverts. Aerodrome overrides it.
    function _stake(address /* _onBehalfOf */, uint256 /* tokenId */, bytes memory /* lpPoolParam */) internal virtual {
        revert StakingNotSupported();
    }

    /// @dev Unstake `tokenId` from the protocol's stakePool when it is staked, so
    ///      the close flow's `ownerOf == Safe` guard holds. Returns the pool the
    ///      NFT came OUT of (address(0) when it was not staked) so a surviving
    ///      partial position can go back into that exact pool. The stake pin is
    ///      deliberately preserved here — only a full close clears it, via
    ///      `_clearStakePin`. Default: no stakePool → no-op. Aerodrome overrides
    ///      it; idempotent for unstaked positions.
    function _unstakeIfStaked(address /* _onBehalfOf */, uint256 /* tokenId */) internal virtual returns (address) {
        return address(0);
    }

    /// @dev Put `tokenId` back into `stakePool` — the pool it was just unstaked
    ///      from, NEVER a freshly resolved one: the protocol's gauge mapping is
    ///      governance-controlled and may have rotated since the position was
    ///      staked. Only reached for protocols that staked in the first place.
    function _restakeInto(address /* _onBehalfOf */, uint256 /* tokenId */, address /* stakePool */) internal virtual {
        revert StakingNotSupported();
    }

    /// @dev Whether `stakePool` still takes deposits. A gauge that governance
    ///      has killed keeps honouring withdrawals but rejects deposits, so a
    ///      partial close must not try to put the surviving NFT back — the
    ///      restake would revert and strand the position behind the very exit
    ///      meant to free it. Default: always. Aerodrome overrides it with the
    ///      Voter's liveness flag.
    function _stakePoolAcceptsDeposits(address /* stakePool */) internal view virtual returns (bool) {
        return true;
    }

    /// @dev Forget which pool a position was staked in. Full close only — the NFT
    ///      is gone, so the pin would otherwise outlive the position.
    function _clearStakePin(uint256 tokenId) internal {
        delete _yieldStorage().stakePoolOf[PROTOCOL][tokenId];
    }

    /// @dev Harvest stakePool rewards for a STAKED `tokenId` to the Safe and report
    ///      whether the position was staked, plus the reward token and the Safe's
    ///      pre-claim balance of it. The snapshot is taken UNCONDITIONALLY: the
    ///      claimed delta is fee-bearing yield whether or not the caller asked to
    ///      swap it. Default: no stakePool → false. Aerodrome overrides it.
    function _collectStakedRewardIfStaked(
        address /* _onBehalfOf */,
        uint256 /* tokenId */
    ) internal virtual returns (bool wasStaked, address rewardToken, uint256 rewardBalanceBefore) {
        return (false, address(0), 0);
    }

    /// @dev Charge `feeCollectBps` on emissions newly credited to the Safe since
    ///      `balanceBefore`, and report what was claimed and what was actually
    ///      paid. Every claim route funnels through here — an explicit collect and
    ///      the gauge withdrawal inside a close or switch — so emissions can never
    ///      reach a user untaxed. Measuring a delta (not a balance) leaves any
    ///      reward the Safe already held alone.
    ///
    ///      A failed treasury transfer waives the fee instead of blocking the
    ///      collect or exit, mirroring the LP-fee and performance-fee semantics;
    ///      the emitted `feePaid` is then zero, so the event always states what
    ///      really moved.
    function _settleStakedReward(
        address _onBehalfOf,
        uint256 tokenId,
        address rewardToken,
        uint256 balanceBefore
    ) internal returns (uint256 grossReward, uint256 feePaid) {
        if (rewardToken == address(0)) return (0, 0);
        grossReward = IERC20(rewardToken).balanceOf(_onBehalfOf) - balanceBefore;
        if (grossReward == 0) return (0, 0);

        YieldLayout storage $ = _yieldStorage();
        uint256 fee = (grossReward * $.feeCollectBps) / 10_000;
        if (fee > 0) {
            if (_trySafeTokenTransfer(_onBehalfOf, rewardToken, $.treasury, fee)) {
                feePaid = fee;
            } else {
                emit CollectFeeTransferFailed(_onBehalfOf, tokenId, rewardToken, fee);
            }
        }
        emit StakedRewardCollected(_onBehalfOf, PROTOCOL, tokenId, rewardToken, grossReward, feePaid);
    }

    /// @dev Module-mediated ERC20 transfer OUT of the Safe that reports failure
    ///      instead of reverting: accepts empty or canonical-true returndata and
    ///      treats a false return, malformed returndata, or an inner revert as a
    ///      failed transfer the caller must waive.
    function _trySafeTokenTransfer(
        address _onBehalfOf,
        address token,
        address to,
        uint256 amount
    ) internal returns (bool) {
        (bool ok, bytes memory ret) = ISafe(_onBehalfOf).execTransactionFromModuleReturnData(
            token,
            0,
            abi.encodeCall(IERC20.transfer, (to, amount)),
            ISafe.Operation.Call
        );
        if (!ok) return false;
        return TokenReturnLib.returnedTrue(ret);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  IYieldHandler
    // ─────────────────────────────────────────────────────────────────────

    /// @inheritdoc IYieldHandler
    function openLp(
        OpenLpParams calldata p
    ) external onlyDelegatecall returns (uint256 tokenId, uint128 basisUsd6, uint128 used0, uint128 used1) {
        _validatePoolParamAllowed(p.lpPoolParam);
        (address token0, address token1) = _poolTokens(p.lpPoolParam);
        _validatePool(_getPool(p.lpPoolParam), token0, token1);

        uint256 half0 = p.usdcAmount / 2;
        uint256 half1 = p.usdcAmount - half0;

        uint256 desired0 = _acquireSide(p, token0, half0, p.swap0, 20, 3, 21);
        uint256 desired1 = _acquireSide(p, token1, half1, p.swap1, 31, 32, 33);

        (tokenId, used0, used1) = _mintFromAmounts(
            token0,
            token1,
            MintArgs({
                onBehalfOf: p.onBehalfOf,
                lpPoolParam: p.lpPoolParam,
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
        basisUsd6 = (_legValueUsdc(token0, used0, half0, desired0) + _legValueUsdc(token1, used1, half1, desired1))
            .toUint128();

        // Opt-in stakePool stake. Runs AFTER the ownerOf==Safe check and basis so
        // the mint accounting is unaffected; staking then moves the NFT to the
        // stakePool (closeLp unstakes it first).
        if (p.stake) {
            _stake(p.onBehalfOf, tokenId, p.lpPoolParam);
        }
    }

    /// @inheritdoc IYieldHandler
    function closeLp(
        CloseLpParams calldata p,
        uint128 basisForExit
    ) external onlyDelegatecall returns (uint128 currentValueUsd6) {
        (address token0, address token1, , uint128 liquidity) = _position(p.tokenId);
        _validateSwapLeg(token0, p.swap0, p.slippageBps);
        _validateSwapLeg(token1, p.swap1, p.slippageBps);
        // A staked position is owned by the stakePool; unstake it back to the Safe
        // first so the ownership guard and the existing decrease/collect/burn/swap
        // flow run unchanged. No-op for non-stakePool protocols or an unstaked NFT.
        address unstakedFrom = _unstakeIfStaked(p.onBehalfOf, p.tokenId);
        _requireOwnedBy(p.onBehalfOf, p.tokenId);

        // Measure only deltas from this close (USDC sides need no snapshot —
        // their swap leg is skipped and the USDC delta is measured below).
        uint256 t0Before = token0 == address(USDC) ? 0 : IERC20(token0).balanceOf(p.onBehalfOf);
        uint256 t1Before = token1 == address(USDC) ? 0 : IERC20(token1).balanceOf(p.onBehalfOf);
        uint256 usdcBefore = USDC.balanceOf(p.onBehalfOf);

        // Harvest fees before principal so feeCollectBps does not tax capital.
        _collectLpFees(p.onBehalfOf, p.tokenId, token0, token1);

        // On full close, remove exact liquidity so burn can succeed.
        uint128 liquidityToRemove = p.exitBps == 10_000
            ? liquidity
            : Math.mulDiv(uint256(liquidity), uint256(p.exitBps), 10_000).toUint128();

        // Do not let the manager's basis decrement stand when rounding
        // removes zero liquidity (basis would shrink while principal stays).
        if (p.exitBps != 10_000 && basisForExit > 0 && liquidityToRemove == 0) {
            revert InvalidExitBps();
        }

        if (liquidityToRemove > 0) {
            _safeExec(
                p.onBehalfOf,
                POSITION_MANAGER,
                abi.encodeCall(
                    INonfungiblePositionManager.decreaseLiquidity,
                    (
                        INonfungiblePositionManager.DecreaseLiquidityParams({
                            tokenId: p.tokenId,
                            liquidity: liquidityToRemove,
                            amount0Min: p.decreaseAmount0Min,
                            amount1Min: p.decreaseAmount1Min,
                            deadline: p.deadline
                        })
                    )
                ),
                7
            );

            // Collect principal straight to the Safe. No fee on capital.
            _collectToRecipient(p.onBehalfOf, p.tokenId, p.onBehalfOf, 8);
        }

        // Burn only on a full close.
        if (p.exitBps == 10_000) {
            _safeExec(p.onBehalfOf, POSITION_MANAGER, abi.encodeCall(INonfungiblePositionManager.burn, (p.tokenId)), 9);
        }

        // Staking continuity: a position that was staked goes back into the SAME
        // pool when it survives this close, so emissions resume and the pin keeps
        // matching reality. A full close burned the NFT, so the pin is dropped.
        // A restake failure reverts the whole close — a half-closed, unstaked
        // position with a live pin is exactly the divergence this guards against.
        // A pool that no longer takes deposits (`_stakePoolAcceptsDeposits`) is
        // the one exception: nothing to restake into, so the pin is dropped.
        if (unstakedFrom != address(0)) {
            if (p.exitBps == 10_000) {
                _clearStakePin(p.tokenId);
            } else if (_stakePoolAcceptsDeposits(unstakedFrom)) {
                _restakeInto(p.onBehalfOf, p.tokenId, unstakedFrom);
            } else {
                _clearStakePin(p.tokenId);
                emit RestakeSkipped(p.onBehalfOf, PROTOCOL, p.tokenId, unstakedFrom);
            }
        }

        // Swap the non-USDC legs this close produced back to USDC. The deltas
        // are dynamic (principal + harvested fees), so a residue whose floor
        // rounds to zero stays in kind rather than failing the whole exit.
        _swapDeltaToUsdc(p.onBehalfOf, token0, t0Before, p.swap0, p.deadline, p.slippageBps, 26, 10, 27, true);
        _swapDeltaToUsdc(p.onBehalfOf, token1, t1Before, p.swap1, p.deadline, p.slippageBps, 34, 35, 36, true);

        currentValueUsd6 = (USDC.balanceOf(p.onBehalfOf) - usdcBefore).toUint128();
        // Caller's final-value guard on gross realized USDC.
        if (uint256(currentValueUsd6) < p.minUsdcOut) revert MinUsdcOutNotMet();
    }

    /// @inheritdoc IYieldHandler
    /// @dev In-kind close leg of a switch: decrease-all + collect + burn with
    ///      NO swaps — both pool tokens land on the Safe as-is. Fees are
    ///      harvested first through the manager so `feeCollectBps` applies to
    ///      fees only, exactly as in closeLp.
    function withdrawLp(
        WithdrawLpParams calldata p
    ) external onlyDelegatecall returns (address token0, address token1, uint256 amount0, uint256 amount1) {
        uint128 liquidity;
        (token0, token1, , liquidity) = _position(p.tokenId);
        // A staked position is owned by the stakePool; unstake it back to the
        // Safe first so the ownership guard and decrease/collect/burn hold.
        address unstakedFrom = _unstakeIfStaked(p.onBehalfOf, p.tokenId);
        _requireOwnedBy(p.onBehalfOf, p.tokenId);

        uint256 t0Before = IERC20(token0).balanceOf(p.onBehalfOf);
        uint256 t1Before = IERC20(token1).balanceOf(p.onBehalfOf);

        // Harvest fees before principal so feeCollectBps does not tax capital.
        _collectLpFees(p.onBehalfOf, p.tokenId, token0, token1);

        if (liquidity > 0) {
            _safeExec(
                p.onBehalfOf,
                POSITION_MANAGER,
                abi.encodeCall(
                    INonfungiblePositionManager.decreaseLiquidity,
                    (
                        INonfungiblePositionManager.DecreaseLiquidityParams({
                            tokenId: p.tokenId,
                            liquidity: liquidity,
                            amount0Min: p.decreaseAmount0Min,
                            amount1Min: p.decreaseAmount1Min,
                            deadline: p.deadline
                        })
                    )
                ),
                7
            );

            // Collect principal straight to the Safe. No fee on capital.
            _collectToRecipient(p.onBehalfOf, p.tokenId, p.onBehalfOf, 8);
        }

        _safeExec(p.onBehalfOf, POSITION_MANAGER, abi.encodeCall(INonfungiblePositionManager.burn, (p.tokenId)), 9);

        // The NFT is gone: a withdraw is always a full exit, so the pin goes too.
        if (unstakedFrom != address(0)) _clearStakePin(p.tokenId);

        amount0 = IERC20(token0).balanceOf(p.onBehalfOf) - t0Before;
        amount1 = IERC20(token1).balanceOf(p.onBehalfOf) - t1Before;
    }

    /// @inheritdoc IYieldHandler
    /// @dev In-kind open leg of a switch: mint straight from the withdrawn
    ///      token amounts — no swaps, so the only price protection is the
    ///      mint minimums (the withdraw leg's decrease minimums bound the
    ///      input side). Never staked: staking stays an explicit openLp
    ///      opt-in.
    function openLpInKind(
        OpenLpInKindParams calldata p
    ) external onlyDelegatecall returns (uint256 tokenId, uint128 used0, uint128 used1) {
        _validatePoolParamAllowed(p.lpPoolParam);
        (address token0, address token1) = _poolTokens(p.lpPoolParam);
        if (token0 != p.token0 || token1 != p.token1) revert WrongTokenPair();
        _validatePool(_getPool(p.lpPoolParam), token0, token1);

        (tokenId, used0, used1) = _mintFromAmounts(
            token0,
            token1,
            MintArgs({
                onBehalfOf: p.onBehalfOf,
                lpPoolParam: p.lpPoolParam,
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

    /// @inheritdoc IYieldHandler
    function collectLp(CollectLpParams calldata p) external onlyDelegatecall {
        // A staked position earns stakePool emissions INSTEAD of trading fees —
        // the pool redirects its fees away from staked liquidity — so claiming
        // the emissions IS the complete harvest and the NFT never leaves the
        // stakePool. Fees from unstaked periods are still collected on close.
        // Opt-in: swap the claimed reward (e.g. AERO) to USDC through its leg.
        (bool wasStaked, address rewardToken, uint256 rewardBefore) = _collectStakedRewardIfStaked(
            p.onBehalfOf,
            p.tokenId
        );
        if (wasStaked) {
            // The claim is yield, so it pays feeCollectBps whether or not it is
            // swapped. Charging first also means the swap below moves only the
            // NET reward: `_swapDeltaToUsdc` measures the delta from the same
            // pre-claim snapshot, which the fee transfer has already reduced.
            _settleStakedReward(p.onBehalfOf, p.tokenId, rewardToken, rewardBefore);
            if (p.swapRewardToUsdc) {
                if (block.timestamp > p.deadline) revert DeadlineExpired();
                _validateSwapLeg(rewardToken, p.rewardSwap, p.slippageBps);
                _swapDeltaToUsdc(
                    p.onBehalfOf,
                    rewardToken,
                    rewardBefore,
                    p.rewardSwap,
                    p.deadline,
                    p.slippageBps,
                    38,
                    39,
                    40,
                    true
                );
            }
            return;
        }

        (address token0, address token1, , ) = _position(p.tokenId);
        _requireOwnedBy(p.onBehalfOf, p.tokenId);

        // Swap params are validated only on the swap path; the no-swap
        // path intentionally ignores them.
        uint256 t0Before;
        uint256 t1Before;
        if (p.swapFeesToUsdc) {
            if (block.timestamp > p.deadline) revert DeadlineExpired();
            _validateSwapLeg(token0, p.swap0, p.slippageBps);
            _validateSwapLeg(token1, p.swap1, p.slippageBps);
            t0Before = token0 == address(USDC) ? 0 : IERC20(token0).balanceOf(p.onBehalfOf);
            t1Before = token1 == address(USDC) ? 0 : IERC20(token1).balanceOf(p.onBehalfOf);
        }

        _collectLpFees(p.onBehalfOf, p.tokenId, token0, token1);
        if (p.swapFeesToUsdc) {
            _swapDeltaToUsdc(p.onBehalfOf, token0, t0Before, p.swap0, p.deadline, p.slippageBps, 26, 10, 27, true);
            _swapDeltaToUsdc(p.onBehalfOf, token1, t1Before, p.swap1, p.deadline, p.slippageBps, 34, 35, 36, true);
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Shared internals
    // ─────────────────────────────────────────────────────────────────────

    /// @dev Acquire one mint side from its USDC half: identity for USDC, a
    ///      leg-validated swap for any other token. Returns the amount now
    ///      available for the mint.
    function _acquireSide(
        OpenLpParams calldata p,
        address token,
        uint256 halfUsdc,
        SwapLeg calldata leg,
        uint8 approveStep,
        uint8 execStep,
        uint8 resetStep
    ) internal returns (uint256 received) {
        if (token == address(USDC)) return halfUsdc;

        // Allow-list membership is an open-side check only (see `_validateSwapLeg`).
        _validatePoolParamAllowed(leg.poolParam);
        _validateSwapLeg(token, leg, p.slippageBps);
        // Only consume tokens produced by this call, never pre-existing ones.
        uint256 balanceBefore = IERC20(token).balanceOf(p.onBehalfOf);
        _swapViaSafe(
            p.onBehalfOf,
            address(USDC),
            token,
            leg.poolParam,
            halfUsdc,
            leg.amountOutMin,
            p.deadline,
            p.slippageBps,
            approveStep,
            execStep,
            resetStep,
            false
        );
        received = IERC20(token).balanceOf(p.onBehalfOf) - balanceBefore;
        // Avoid accidental one-sided mints after a zero-output swap.
        if (received == 0) revert SwapFailed();
    }

    /// @dev USDC value of a mint leg: the used amount itself for USDC, else
    ///      the used amount priced at the leg's just-executed swap rate
    ///      (`halfUsdc` bought `received`, the mint consumed `used` of it).
    function _legValueUsdc(
        address token,
        uint128 used,
        uint256 halfUsdc,
        uint256 received
    ) internal view returns (uint256) {
        if (token == address(USDC)) return uint256(used);
        return Math.mulDiv(uint256(used), halfUsdc, received);
    }

    /// @dev Require the Safe to own `tokenId` on the position manager.
    function _requireOwnedBy(address _onBehalfOf, uint256 tokenId) internal view {
        if (IERC721(POSITION_MANAGER).ownerOf(tokenId) != _onBehalfOf) revert LpNotOnSafe();
    }

    /// @dev Collect accrued fees through the manager so `feeCollectBps` can
    ///      be skimmed before forwarding the remainder to the Safe.
    function _collectLpFees(address _onBehalfOf, uint256 tokenId, address token0, address token1) internal {
        uint256 t0Before = IERC20(token0).balanceOf(address(this));
        uint256 t1Before = IERC20(token1).balanceOf(address(this));

        _collectToRecipient(_onBehalfOf, tokenId, address(this), 6);

        uint256 collected0 = IERC20(token0).balanceOf(address(this)) - t0Before;
        uint256 collected1 = IERC20(token1).balanceOf(address(this)) - t1Before;

        uint256 fee0 = _chargeCollectFee(token0, collected0, _onBehalfOf, tokenId);
        uint256 fee1 = _chargeCollectFee(token1, collected1, _onBehalfOf, tokenId);

        emit FeesCollected(_onBehalfOf, PROTOCOL, tokenId, token0, collected0, fee0, token1, collected1, fee1);
    }

    /// @dev Module-mediated NPM collect of the full owed balance.
    function _collectToRecipient(address _onBehalfOf, uint256 tokenId, address recipient, uint8 step) internal {
        _safeExec(
            _onBehalfOf,
            POSITION_MANAGER,
            abi.encodeCall(
                INonfungiblePositionManager.collect,
                (
                    INonfungiblePositionManager.CollectParams({
                        tokenId: tokenId,
                        recipient: recipient,
                        amount0Max: type(uint128).max,
                        amount1Max: type(uint128).max
                    })
                )
            ),
            step
        );
    }

    /// @dev Skim `feeCollectBps` to the treasury, forward the rest to the
    ///      Safe. Treasury transfer failure waives the fee instead of
    ///      blocking users (e.g. USDC blacklist on the treasury).
    ///      The skim uses SafeERC20's non-reverting variant rather than a typed
    ///      `try`: a no-return token (USDT-style) makes the typed call's
    ///      returndata decode fail, and THAT failure is not caught by `catch` —
    ///      it reverts the harvest after the treasury was already paid.
    function _chargeCollectFee(
        address token,
        uint256 amount,
        address _onBehalfOf,
        uint256 tokenId
    ) internal returns (uint256 fee) {
        if (amount == 0) return 0;
        YieldLayout storage $ = _yieldStorage();
        fee = (amount * $.feeCollectBps) / 10_000;
        if (fee > 0 && !IERC20(token).trySafeTransfer($.treasury, fee)) {
            emit CollectFeeTransferFailed(_onBehalfOf, tokenId, token, fee);
            fee = 0;
        }
        uint256 toSafe = amount - fee;
        if (toSafe > 0) IERC20(token).safeTransfer(_onBehalfOf, toSafe);
    }

    /// @dev Module-mediated exact-input swap on the pinned router; calldata
    ///      is built on-chain so callers cannot inject alternative routes.
    function _swapViaSafe(
        address _onBehalfOf,
        address tokenIn,
        address tokenOut,
        bytes memory poolParam,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 deadline,
        uint16 slippageBps,
        uint8 approveStep,
        uint8 execStep,
        uint8 resetStep,
        bool leaveZeroFloorInKind
    ) internal {
        // Every router call in this handler funnels through here, so the floor
        // is enforced structurally rather than by remembering to call it.
        amountOutMin = _twapMinOut(tokenIn, tokenOut, amountIn, amountOutMin, slippageBps);
        // Dynamic harvest/reward/close deltas can be non-zero while their
        // quoted output rounds to zero in raw token units. There is no
        // enforceable price boundary in that case, so keep the dust on the Safe
        // instead of either making an unprotected router call or reverting the
        // harvest or exit. Known-input swaps (open legs) pass false and remain
        // fail-closed.
        if (amountOutMin == 0) {
            if (leaveZeroFloorInKind) {
                emit SwapSkippedBelowFloor(_onBehalfOf, tokenIn, amountIn);
                return;
            }
            revert InvalidSwapAmountOutMin();
        }
        bytes memory swapData = _buildSwapCalldata(
            tokenIn,
            tokenOut,
            poolParam,
            _onBehalfOf,
            amountIn,
            amountOutMin,
            deadline
        );
        _safeApprove(_onBehalfOf, tokenIn, SWAP_ROUTER, amountIn, approveStep);
        _safeExec(_onBehalfOf, SWAP_ROUTER, swapData, execStep);
        _safeApprove(_onBehalfOf, tokenIn, SWAP_ROUTER, 0, resetStep);
    }

    /// @dev Swap the `token` the Safe accrued since `balanceBefore` back to
    ///      USDC. No-op for the USDC side itself — its "delta" IS the realized
    ///      output, measured by the caller.
    function _swapDeltaToUsdc(
        address _onBehalfOf,
        address token,
        uint256 balanceBefore,
        SwapLeg calldata leg,
        uint256 deadline,
        uint16 slippageBps,
        uint8 approveStep,
        uint8 execStep,
        uint8 resetStep,
        bool leaveZeroFloorInKind
    ) internal {
        if (token == address(USDC)) return;
        uint256 delta = IERC20(token).balanceOf(_onBehalfOf) - balanceBefore;
        if (delta > 0) {
            _swapViaSafe(
                _onBehalfOf,
                token,
                address(USDC),
                leg.poolParam,
                delta,
                leg.amountOutMin,
                deadline,
                slippageBps,
                approveStep,
                execStep,
                resetStep,
                leaveZeroFloorInKind
            );
        }
    }

    /// @dev Route checks only: the leg's pool param must resolve to a pool that
    ///      actually trades {token, USDC} and clears the liquidity floor. The
    ///      USDC side of a pair has no swap, so its (ignored) leg is not
    ///      validated. Allow-list membership is checked by opens only
    ///      (`_acquireSide`): exits must survive a de-listing, and the price is
    ///      protected by the TWAP floor, not the allow-list (SECURITY_MODEL.md).
    ///      The PRICE check is not here — it needs the input amount, which is
    ///      only known at the swap itself, so it lives in `_swapViaSafe`.
    function _validateSwapLeg(address token, SwapLeg calldata leg, uint16 slippageBps) internal view {
        if (token == address(USDC)) return;
        if (slippageBps == 0) revert SlippageTooLow();
        if (slippageBps > _yieldStorage().maxSlippageBps) revert SlippageAboveMax();
        (address expect0, address expect1) = token < address(USDC) ? (token, address(USDC)) : (address(USDC), token);
        _validatePool(_getPool(leg.poolParam), expect0, expect1);
    }

    /// @dev Min-out actually handed to the router: what the reference TWAP says
    ///      `amountIn` is worth, less `slippageBps`, and never less than what
    ///      the caller asked for. The caller may TIGHTEN the bound; it can no
    ///      longer loosen it, which is the whole point — the previous floor was
    ///      checked against a number the same caller supplied.
    ///
    ///      Deriving rather than merely validating also fixes the case that has
    ///      no honest answer otherwise: `collectLp` swaps fees whose size is
    ///      unknown until the collect executes, so no caller-supplied absolute
    ///      minimum can be right. Such callers pass 0 and get the floor.
    ///
    ///      Reverts when the token has no reference configured — swapping a
    ///      token nobody has priced is exactly the case that must not proceed,
    ///      and `withdrawLp` still exits such a position in kind.
    function _twapMinOut(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 callerMinOut,
        uint16 slippageBps
    ) internal view returns (uint256) {
        address token = tokenIn == address(USDC) ? tokenOut : tokenIn;
        TwapConfig memory cfg = _yieldStorage().twapConfigOf[token];
        if (cfg.pool == address(0)) revert TwapOracle.TwapNotConfigured(token);
        uint256 floor = Math.mulDiv(TwapOracle.quote(cfg, tokenIn, tokenOut, amountIn), 10_000 - slippageBps, 10_000);
        return callerMinOut > floor ? callerMinOut : floor;
    }

    function _validatePoolParamAllowed(bytes memory poolParam) internal view {
        if (!_yieldStorage().allowedPoolKey[PROTOCOL][keccak256(poolParam)]) revert PoolParamNotAllowed();
    }

    /// @dev Validate a resolved pool: exists, trades the expected pair,
    ///      initialized, and above the per-protocol liquidity floor. Returns
    ///      the sqrt price so valuation callers don't re-read slot0.
    function _validatePool(
        address pool,
        address expectedToken0,
        address expectedToken1
    ) internal view returns (uint160 sqrtPriceX96) {
        if (pool == address(0)) revert PoolDoesNotExist();
        if (IPoolMinimal(pool).token0() != expectedToken0 || IPoolMinimal(pool).token1() != expectedToken1) {
            revert WrongTokenPair();
        }
        sqrtPriceX96 = _poolSqrtPriceX96(pool);
        if (sqrtPriceX96 == 0) revert PoolNotInitialized();
        uint128 floor = _yieldStorage().minPoolLiquidity[PROTOCOL];
        if (floor > 0 && IPoolMinimal(pool).liquidity() < floor) revert PoolTooThin();
    }

    /// @dev Module-mediated ERC20 approve from the Safe. Supports both
    ///      standard bool-returning tokens and no-return tokens, and rejects a
    ///      false return so a failed zero-reset cannot leave router allowance
    ///      live after an otherwise-successful operation.
    function _safeApprove(address _onBehalfOf, address token, address spender, uint256 amount, uint8 step) internal {
        bytes memory ret = _safeExec(_onBehalfOf, token, abi.encodeCall(IERC20.approve, (spender, amount)), step);
        if (!TokenReturnLib.returnedTrue(ret)) revert TokenApprovalFailed(token);
    }

    /// @dev Module-mediated Safe call with inner-revert bubbling.
    function _safeExec(
        address _onBehalfOf,
        address target,
        bytes memory data,
        uint8 step
    ) internal returns (bytes memory ret) {
        bool ok;
        (ok, ret) = ISafe(_onBehalfOf).execTransactionFromModuleReturnData(target, 0, data, ISafe.Operation.Call);
        if (!ok) {
            if (ret.length > 0) Address.verifyCallResult(ok, ret);
            revert ModuleCallFailed(step);
        }
    }

    /// @dev The mint half shared by `openLp` and `openLpInKind`: approve the
    ///      position manager for both sides, mint through the Safe, enforce the
    ///      per-protocol liquidity floor, reset both allowances, and confirm the
    ///      Safe owns the new NFT. The (tokenId, liquidity, amount0, amount1)
    ///      mint return shape is shared by both position managers.
    function _mintFromAmounts(
        address token0,
        address token1,
        MintArgs memory a
    ) internal returns (uint256 tokenId, uint128 used0, uint128 used1) {
        _safeApprove(a.onBehalfOf, token0, POSITION_MANAGER, a.amount0, 22);
        _safeApprove(a.onBehalfOf, token1, POSITION_MANAGER, a.amount1, 23);

        bytes memory mintCall = _buildMintCalldata(
            a.lpPoolParam,
            a.tickLower,
            a.tickUpper,
            a.amount0,
            a.amount1,
            a.mintAmount0Min,
            a.mintAmount1Min,
            a.onBehalfOf,
            a.deadline
        );
        bytes memory ret = _safeExec(a.onBehalfOf, POSITION_MANAGER, mintCall, 4);

        uint128 liquidityMinted;
        {
            uint256 amount0Out;
            uint256 amount1Out;
            (tokenId, liquidityMinted, amount0Out, amount1Out) = abi.decode(ret, (uint256, uint128, uint256, uint256));
            used0 = amount0Out.toUint128();
            used1 = amount1Out.toUint128();
        }
        if (liquidityMinted < _yieldStorage().minPositionLiquidity[PROTOCOL]) revert PositionLiquidityTooLow();

        _safeApprove(a.onBehalfOf, token0, POSITION_MANAGER, 0, 24);
        _safeApprove(a.onBehalfOf, token1, POSITION_MANAGER, 0, 25);

        _requireOwnedBy(a.onBehalfOf, tokenId);
    }
}
