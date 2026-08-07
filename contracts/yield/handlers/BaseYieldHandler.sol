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
import {IYieldHandler, OpenLpParams, CloseLpParams, CollectLpParams, SwapLeg} from "../../interfaces/IYieldHandler.sol";
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
    /// @notice Thrown when `OpenLpParams.stakeInGauge` is set for a protocol
    ///         whose handler has no gauge (e.g. Uniswap V3).
    error GaugeStakingNotSupported();

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

    /// @dev Stake the just-minted NFT into the protocol's gauge. Default: the
    ///      protocol has no gauge, so opting in reverts. Aerodrome overrides it.
    function _stakeInGauge(
        address /* _onBehalfOf */,
        uint256 /* tokenId */,
        bytes memory /* lpPoolParam */
    ) internal virtual {
        revert GaugeStakingNotSupported();
    }

    /// @dev Unstake `tokenId` from the protocol's gauge when it is staked, so
    ///      the close flow's `ownerOf == Safe` guard holds. Default: no gauge →
    ///      no-op. Aerodrome overrides it; idempotent for unstaked positions.
    function _unstakeIfStaked(address /* _onBehalfOf */, uint256 /* tokenId */) internal virtual {}

    /// @dev Harvest gauge rewards for a STAKED `tokenId` to the Safe and report
    ///      whether the NFT must be temporarily unstaked for the normal LP-fee
    ///      collect. Default: no gauge → false. Aerodrome overrides it.
    function _collectStakedRewardIfStaked(
        address /* _onBehalfOf */,
        uint256 /* tokenId */
    ) internal virtual returns (bool) {
        return false;
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

        (uint256 desired0, uint256 spent0) = _acquireSide(p, token0, half0, p.swap0, 20, 3, 21);
        (uint256 desired1, uint256 spent1) = _acquireSide(p, token1, half1, p.swap1, 31, 32, 33);

        _safeApprove(p.onBehalfOf, token0, POSITION_MANAGER, desired0, 22);
        _safeApprove(p.onBehalfOf, token1, POSITION_MANAGER, desired1, 23);

        uint128 liquidityMinted;
        (tokenId, liquidityMinted, used0, used1) = _safeMintLp(p, desired0, desired1);
        if (liquidityMinted < _yieldStorage().minPositionLiquidity[PROTOCOL]) revert PositionLiquidityTooLow();

        _safeApprove(p.onBehalfOf, token0, POSITION_MANAGER, 0, 24);
        _safeApprove(p.onBehalfOf, token1, POSITION_MANAGER, 0, 25);

        if (IERC721(POSITION_MANAGER).ownerOf(tokenId) != p.onBehalfOf) revert LpNotOnSafe();

        // Value each leg at its just-executed swap rate (identity for USDC).
        basisUsd6 = (_legValueUsdc(token0, used0, spent0, desired0) + _legValueUsdc(token1, used1, spent1, desired1))
            .toUint128();

        // Opt-in gauge stake. Runs AFTER the ownerOf==Safe check and basis so
        // the mint accounting is unaffected; staking then moves the NFT to the
        // gauge (closeLp unstakes it first).
        if (p.stakeInGauge) {
            _stakeInGauge(p.onBehalfOf, tokenId, p.lpPoolParam);
        }
    }

    /// @inheritdoc IYieldHandler
    function closeLp(
        CloseLpParams calldata p,
        uint128 basisForExit
    ) external onlyDelegatecall returns (uint128 currentValueUsd6) {
        (address token0, address token1, , ) = _position(p.tokenId);
        if (token0 != address(USDC)) _validateSwapLeg(token0, p.swap0, p.slippageBps);
        if (token1 != address(USDC)) _validateSwapLeg(token1, p.swap1, p.slippageBps);
        // A staked position is owned by the gauge; unstake it back to the Safe
        // first so the ownership guard and the existing decrease/collect/burn/swap
        // flow run unchanged. No-op for non-gauge protocols or an unstaked NFT.
        _unstakeIfStaked(p.onBehalfOf, p.tokenId);
        if (IERC721(POSITION_MANAGER).ownerOf(p.tokenId) != p.onBehalfOf) revert LpNotOnSafe();

        // Measure only deltas from this close.
        uint256 t0Before = IERC20(token0).balanceOf(p.onBehalfOf);
        uint256 t1Before = IERC20(token1).balanceOf(p.onBehalfOf);
        uint256 usdcBefore = USDC.balanceOf(p.onBehalfOf);

        // Harvest fees before principal so feeCollectBps does not tax capital.
        _collectLpFees(p.onBehalfOf, p.tokenId, token0, token1);

        // On full close, remove exact liquidity so burn can succeed.
        (, , , uint128 liquidity) = _position(p.tokenId);
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

        // Swap the non-USDC legs this close produced back to USDC.
        if (token0 != address(USDC)) _swapDeltaToUsdc(p.onBehalfOf, token0, t0Before, p.swap0, p.deadline, 26, 10, 27);
        if (token1 != address(USDC)) _swapDeltaToUsdc(p.onBehalfOf, token1, t1Before, p.swap1, p.deadline, 34, 35, 36);

        currentValueUsd6 = (USDC.balanceOf(p.onBehalfOf) - usdcBefore).toUint128();
        // Caller's final-value guard on gross realized USDC.
        if (uint256(currentValueUsd6) < p.minUsdcOut) revert MinUsdcOutNotMet();
    }

    /// @inheritdoc IYieldHandler
    function collectLp(CollectLpParams calldata p) external onlyDelegatecall {
        (address token0, address token1, bytes memory lpPoolParam, ) = _position(p.tokenId);

        // A staked position is owned by the gauge, so claim its incentives,
        // temporarily return the NFT to the Safe, harvest the position's LP
        // trading fees, then restore the stake. Returning after getReward would
        // silently leave all trading fees uncollected until the final close.
        bool wasStaked = _collectStakedRewardIfStaked(p.onBehalfOf, p.tokenId);
        if (wasStaked) _unstakeIfStaked(p.onBehalfOf, p.tokenId);
        if (IERC721(POSITION_MANAGER).ownerOf(p.tokenId) != p.onBehalfOf) revert LpNotOnSafe();

        // Swap params are validated only on the swap path; the no-swap
        // path intentionally ignores them.
        if (p.swapFeesToUsdc) {
            if (block.timestamp > p.deadline) revert DeadlineExpired();
            if (token0 != address(USDC)) _validateSwapLeg(token0, p.swap0, p.slippageBps);
            if (token1 != address(USDC)) _validateSwapLeg(token1, p.swap1, p.slippageBps);
        }

        uint256 t0Before = IERC20(token0).balanceOf(p.onBehalfOf);
        uint256 t1Before = IERC20(token1).balanceOf(p.onBehalfOf);
        _collectLpFees(p.onBehalfOf, p.tokenId, token0, token1);
        if (p.swapFeesToUsdc) {
            if (token0 != address(USDC)) {
                _swapDeltaToUsdc(p.onBehalfOf, token0, t0Before, p.swap0, p.deadline, 26, 10, 27);
            }
            if (token1 != address(USDC)) {
                _swapDeltaToUsdc(p.onBehalfOf, token1, t1Before, p.swap1, p.deadline, 34, 35, 36);
            }
        }

        if (wasStaked) _stakeInGauge(p.onBehalfOf, p.tokenId, lpPoolParam);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Shared internals
    // ─────────────────────────────────────────────────────────────────────

    /// @dev Acquire one mint side from its USDC half: identity for USDC, a
    ///      leg-validated swap for any other token. Returns the amount now
    ///      available for the mint and the USDC spent acquiring it.
    function _acquireSide(
        OpenLpParams calldata p,
        address token,
        uint256 halfUsdc,
        SwapLeg calldata leg,
        uint8 approveStep,
        uint8 execStep,
        uint8 resetStep
    ) internal returns (uint256 received, uint256 spentUsdc) {
        if (token == address(USDC)) return (halfUsdc, halfUsdc);

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
            approveStep,
            execStep,
            resetStep
        );
        received = IERC20(token).balanceOf(p.onBehalfOf) - balanceBefore;
        // Avoid accidental one-sided mints after a zero-output swap.
        if (received == 0) revert SwapFailed();
        spentUsdc = halfUsdc;
    }

    /// @dev USDC value of a mint leg: the used amount itself for USDC, else
    ///      the used amount priced at the leg's just-executed swap rate.
    function _legValueUsdc(
        address token,
        uint128 used,
        uint256 spentUsdc,
        uint256 received
    ) internal view returns (uint256) {
        if (token == address(USDC)) return uint256(used);
        return Math.mulDiv(uint256(used), spentUsdc, received);
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
    function _chargeCollectFee(
        address token,
        uint256 amount,
        address _onBehalfOf,
        uint256 tokenId
    ) internal returns (uint256 fee) {
        if (amount == 0) return 0;
        YieldLayout storage $ = _yieldStorage();
        fee = (amount * $.feeCollectBps) / 10_000;
        uint256 toSafe = amount;
        if (fee > 0) {
            try IERC20(token).transfer($.treasury, fee) returns (bool ok) {
                if (ok) {
                    toSafe = amount - fee;
                } else {
                    emit CollectFeeTransferFailed(_onBehalfOf, tokenId, token, fee);
                    fee = 0;
                }
            } catch {
                emit CollectFeeTransferFailed(_onBehalfOf, tokenId, token, fee);
                fee = 0;
            }
        }
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
        uint8 approveStep,
        uint8 execStep,
        uint8 resetStep
    ) internal {
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

    /// @dev Swap the `token` the Safe accrued since `balanceBefore` back to USDC.
    function _swapDeltaToUsdc(
        address _onBehalfOf,
        address token,
        uint256 balanceBefore,
        SwapLeg calldata leg,
        uint256 deadline,
        uint8 approveStep,
        uint8 execStep,
        uint8 resetStep
    ) internal {
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
                approveStep,
                execStep,
                resetStep
            );
        }
    }

    /// @dev Ties `slippageBps` to the caller's quoter-derived min-out, checks
    ///      the leg's pool param against the allow-list, and pins the leg's
    ///      pool to the {token, USDC} pair so swaps can only route through a
    ///      pool that actually trades the leg's token against USDC.
    function _validateSwapLeg(address token, SwapLeg calldata leg, uint16 slippageBps) internal view {
        if (slippageBps == 0) revert SlippageTooLow();
        if (slippageBps > _yieldStorage().maxSlippageBps) revert SlippageAboveMax();
        _validatePoolParamAllowed(leg.poolParam);
        if (leg.amountOutMin == 0) revert InvalidSwapAmountOutMin();
        if (leg.expectedOut == 0) revert InvalidExpectedSwapOut();
        if (leg.amountOutMin < (leg.expectedOut * (10_000 - slippageBps)) / 10_000) {
            revert SwapMinBelowSlippageFloor();
        }
        (address expect0, address expect1) = token < address(USDC) ? (token, address(USDC)) : (address(USDC), token);
        _validatePool(_getPool(leg.poolParam), expect0, expect1);
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
        if (ret.length > 0 && !abi.decode(ret, (bool))) revert TokenApprovalFailed(token);
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

    /// @dev Module-mediated NPM mint; the (tokenId, liquidity, amount0,
    ///      amount1) return shape is shared by both position managers.
    function _safeMintLp(
        OpenLpParams calldata p,
        uint256 amount0Desired,
        uint256 amount1Desired
    ) internal returns (uint256 tokenId, uint128 liquidityMinted, uint128 amount0Used, uint128 amount1Used) {
        bytes memory mintCall = _buildMintCalldata(
            p.lpPoolParam,
            p.tickLower,
            p.tickUpper,
            amount0Desired,
            amount1Desired,
            p.mintAmount0Min,
            p.mintAmount1Min,
            p.onBehalfOf,
            p.deadline
        );
        bytes memory ret = _safeExec(p.onBehalfOf, POSITION_MANAGER, mintCall, 4);

        uint256 amount0Out;
        uint256 amount1Out;
        (tokenId, liquidityMinted, amount0Out, amount1Out) = abi.decode(ret, (uint256, uint128, uint256, uint256));
        amount0Used = amount0Out.toUint128();
        amount1Used = amount1Out.toUint128();
    }
}
