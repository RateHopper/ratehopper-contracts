// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {ISafe} from "../interfaces/safe/ISafe.sol";
import {INonfungiblePositionManager} from "../interfaces/uniswapV3/INonfungiblePositionManager.sol";
import {IYieldHandler, OpenLpParams, CloseLpParams, CollectLpParams} from "../interfaces/IYieldHandler.sol";
import {YieldStorage} from "./YieldStorage.sol";
import "../Types.sol";

/// @dev Surface shared by Uniswap V3 pools and Aerodrome Slipstream CL pools.
///      `slot0` is NOT here — its return arity differs, so reading the sqrt
///      price goes through the `_poolSqrtPriceX96` hook.
interface IPoolMinimal {
    function token0() external view returns (address);

    function token1() external view returns (address);

    function liquidity() external view returns (uint128);
}

/// @title BaseYieldHandler
/// @notice Shared open/close/collect flow for WETH/USDC LP positions on
///         V3-style concentrated-liquidity protocols, executed via
///         delegatecall from SafeYieldManager. Protocol differences are
///         isolated in five virtual hooks (pool resolution, sqrt-price read,
///         swap calldata, mint calldata, position decoding); everything the
///         two existing standalone contracts had in common lives here once.
///         A protocol whose mechanics don't fit this shape (e.g. Uniswap V4)
///         can bypass this base entirely and implement IYieldHandler
///         directly.
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
    IERC20 public immutable WETH;
    address public immutable SWAP_ROUTER;

    /// @dev Own deployment address, captured at construction to enforce
    ///      delegatecall-only entry (a direct call would run against the
    ///      handler's empty storage).
    address private immutable __self = address(this);

    error OnlyDelegatecall();

    modifier onlyDelegatecall() {
        if (address(this) == __self) revert OnlyDelegatecall();
        _;
    }

    constructor(uint8 _protocol, address _positionManager, IERC20 _usdc, IERC20 _weth, address _swapRouter) {
        if (_positionManager == address(0)) revert ZeroAddress();
        if (address(_usdc) == address(0)) revert ZeroAddress();
        if (address(_weth) == address(0)) revert ZeroAddress();
        // The shared flow pins WETH = token0 / USDC = token1 (true on Base).
        if (address(_weth) >= address(_usdc)) revert WrongTokenPair();
        if (_swapRouter == address(0)) revert ZeroAddress();

        PROTOCOL = _protocol;
        POSITION_MANAGER = _positionManager;
        USDC = _usdc;
        WETH = _weth;
        SWAP_ROUTER = _swapRouter;
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Protocol hooks
    // ─────────────────────────────────────────────────────────────────────

    /// @dev Resolve the WETH/USDC pool for an ABI-encoded pool param.
    function _getPool(bytes memory poolParam) internal view virtual returns (address);

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
        uint256 wethDesired,
        uint256 usdcDesired,
        uint256 amount0Min,
        uint256 amount1Min,
        address recipient,
        uint256 deadline
    ) internal view virtual returns (bytes memory);

    /// @dev Decode `positions(tokenId)` (fee vs tickSpacing slot differs).
    function _position(
        uint256 tokenId
    ) internal view virtual returns (address token0, address token1, bytes memory lpPoolParam, uint128 liquidity);

    // ─────────────────────────────────────────────────────────────────────
    //  IYieldHandler
    // ─────────────────────────────────────────────────────────────────────

    /// @inheritdoc IYieldHandler
    function openLp(
        OpenLpParams calldata p
    ) external onlyDelegatecall returns (uint256 tokenId, uint128 basisUsd6, uint128 usedWeth, uint128 usedUsdc) {
        _validateSwapParams(p.swapPoolParam, p.swapAmountOutMin, p.expectedSwapOut, p.slippageBps);
        _validatePoolParamAllowed(p.lpPoolParam);
        _validatePool(_getPool(p.swapPoolParam));
        _validatePool(_getPool(p.lpPoolParam));

        uint256 halfUsdc = p.usdcAmount / 2;
        uint256 retainedUsdc = p.usdcAmount - halfUsdc;

        // Only consume WETH produced by this call, never pre-existing WETH.
        uint256 wethBefore = WETH.balanceOf(p.onBehalfOf);

        _swapViaSafe(
            p.onBehalfOf,
            address(USDC),
            address(WETH),
            p.swapPoolParam,
            halfUsdc,
            p.swapAmountOutMin,
            p.deadline,
            20,
            3,
            21
        );

        uint128 wethReceived = (WETH.balanceOf(p.onBehalfOf) - wethBefore).toUint128();
        // Avoid accidental one-sided mints after a zero-output swap.
        if (wethReceived == 0) revert SwapFailed();

        _safeApprove(p.onBehalfOf, address(WETH), POSITION_MANAGER, uint256(wethReceived), 22);
        _safeApprove(p.onBehalfOf, address(USDC), POSITION_MANAGER, retainedUsdc, 23);

        uint128 liquidityMinted;
        (tokenId, liquidityMinted, usedWeth, usedUsdc) = _safeMintLp(p, uint256(wethReceived), retainedUsdc);
        if (liquidityMinted < _yieldStorage().minPositionLiquidity[PROTOCOL]) revert PositionLiquidityTooLow();

        _safeApprove(p.onBehalfOf, address(WETH), POSITION_MANAGER, 0, 24);
        _safeApprove(p.onBehalfOf, address(USDC), POSITION_MANAGER, 0, 25);

        if (IERC721(POSITION_MANAGER).ownerOf(tokenId) != p.onBehalfOf) revert LpNotOnSafe();

        // Value the WETH leg at the just-executed swap rate.
        uint256 wethValueInUsdc = Math.mulDiv(uint256(usedWeth), halfUsdc, uint256(wethReceived));
        basisUsd6 = (wethValueInUsdc + uint256(usedUsdc)).toUint128();
    }

    /// @inheritdoc IYieldHandler
    function closeLp(
        CloseLpParams calldata p,
        uint128 basisForExit
    ) external onlyDelegatecall returns (uint128 currentValueUsd6) {
        _validateSwapParams(p.swapPoolParam, p.swapAmountOutMin, p.expectedSwapOut, p.slippageBps);
        _validatePool(_getPool(p.swapPoolParam));
        _requireWethUsdcPositionOwnedBy(p.onBehalfOf, p.tokenId);

        // Measure only deltas from this close.
        uint256 wethBefore = WETH.balanceOf(p.onBehalfOf);
        uint256 usdcBefore = USDC.balanceOf(p.onBehalfOf);

        // Harvest fees before principal so feeCollectBps does not tax capital.
        _collectLpFees(p.onBehalfOf, p.tokenId);

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

        // Swap the WETH this close produced back to USDC.
        _swapWethDeltaToUsdc(p.onBehalfOf, wethBefore, p.swapPoolParam, p.swapAmountOutMin, p.deadline);

        currentValueUsd6 = (USDC.balanceOf(p.onBehalfOf) - usdcBefore).toUint128();
        // Caller's final-value guard on gross realized USDC.
        if (uint256(currentValueUsd6) < p.minUsdcOut) revert MinUsdcOutNotMet();
    }

    /// @inheritdoc IYieldHandler
    function collectLp(CollectLpParams calldata p) external onlyDelegatecall {
        _requireWethUsdcPositionOwnedBy(p.onBehalfOf, p.tokenId);

        // Swap params are validated only on the swap path; the no-swap
        // path intentionally ignores them.
        if (p.swapWethToUsdc) {
            if (block.timestamp > p.deadline) revert DeadlineExpired();
            _validateSwapParams(p.swapPoolParam, p.swapAmountOutMin, p.expectedSwapOut, p.slippageBps);
            _validatePool(_getPool(p.swapPoolParam));
        }

        uint256 wethBefore = WETH.balanceOf(p.onBehalfOf);
        _collectLpFees(p.onBehalfOf, p.tokenId);
        if (p.swapWethToUsdc) {
            _swapWethDeltaToUsdc(p.onBehalfOf, wethBefore, p.swapPoolParam, p.swapAmountOutMin, p.deadline);
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Shared internals
    // ─────────────────────────────────────────────────────────────────────

    /// @dev Collect accrued fees through the manager so `feeCollectBps` can
    ///      be skimmed before forwarding the remainder to the Safe.
    function _collectLpFees(address _onBehalfOf, uint256 tokenId) internal {
        uint256 wethBefore = WETH.balanceOf(address(this));
        uint256 usdcBefore = USDC.balanceOf(address(this));

        _collectToRecipient(_onBehalfOf, tokenId, address(this), 6);

        uint256 collectedWeth = WETH.balanceOf(address(this)) - wethBefore;
        uint256 collectedUsdc = USDC.balanceOf(address(this)) - usdcBefore;

        uint256 wethFee = _chargeCollectFee(address(WETH), collectedWeth, _onBehalfOf, tokenId);
        uint256 usdcFee = _chargeCollectFee(address(USDC), collectedUsdc, _onBehalfOf, tokenId);

        emit FeesCollected(
            _onBehalfOf,
            PROTOCOL,
            tokenId,
            address(WETH),
            collectedWeth,
            wethFee,
            address(USDC),
            collectedUsdc,
            usdcFee
        );
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

    /// @dev Swap the WETH the Safe accrued since `wethBefore` back to USDC.
    function _swapWethDeltaToUsdc(
        address _onBehalfOf,
        uint256 wethBefore,
        bytes memory swapPoolParam,
        uint256 swapAmountOutMin,
        uint256 deadline
    ) internal {
        uint256 wethDelta = WETH.balanceOf(_onBehalfOf) - wethBefore;
        if (wethDelta > 0) {
            _swapViaSafe(
                _onBehalfOf,
                address(WETH),
                address(USDC),
                swapPoolParam,
                wethDelta,
                swapAmountOutMin,
                deadline,
                26,
                10,
                27
            );
        }
    }

    /// @dev Ties `slippageBps` to the caller's quoter-derived min-out and
    ///      checks the swap pool param against the allow-list.
    function _validateSwapParams(
        bytes memory swapPoolParam,
        uint256 swapAmountOutMin,
        uint256 expectedSwapOut,
        uint16 slippageBps
    ) internal view {
        if (slippageBps == 0) revert SlippageTooLow();
        if (slippageBps > _yieldStorage().maxSlippageBps) revert SlippageAboveMax();
        _validatePoolParamAllowed(swapPoolParam);
        if (swapAmountOutMin == 0) revert InvalidSwapAmountOutMin();
        if (expectedSwapOut == 0) revert InvalidExpectedSwapOut();
        if (swapAmountOutMin < (expectedSwapOut * (10_000 - slippageBps)) / 10_000) {
            revert SwapMinBelowSlippageFloor();
        }
    }

    function _validatePoolParamAllowed(bytes memory poolParam) internal view {
        if (!_yieldStorage().allowedPoolKey[PROTOCOL][keccak256(poolParam)]) revert PoolParamNotAllowed();
    }

    /// @dev Validate a resolved pool: exists, WETH/USDC pair, initialized,
    ///      and above the per-protocol liquidity floor. Returns the sqrt
    ///      price so valuation callers don't re-read slot0.
    function _validatePool(address pool) internal view returns (uint160 sqrtPriceX96) {
        if (pool == address(0)) revert PoolDoesNotExist();
        if (IPoolMinimal(pool).token0() != address(WETH) || IPoolMinimal(pool).token1() != address(USDC)) {
            revert WrongTokenPair();
        }
        sqrtPriceX96 = _poolSqrtPriceX96(pool);
        if (sqrtPriceX96 == 0) revert PoolNotInitialized();
        uint128 floor = _yieldStorage().minPoolLiquidity[PROTOCOL];
        if (floor > 0 && IPoolMinimal(pool).liquidity() < floor) revert PoolTooThin();
    }

    /// @dev Require a Safe-owned WETH/USDC LP NFT.
    function _requireWethUsdcPositionOwnedBy(address _onBehalfOf, uint256 tokenId) internal view {
        (address token0, address token1, , ) = _position(tokenId);
        if (token0 != address(WETH) || token1 != address(USDC)) revert WrongTokenPair();
        if (IERC721(POSITION_MANAGER).ownerOf(tokenId) != _onBehalfOf) revert LpNotOnSafe();
    }

    /// @dev Module-mediated ERC20 approve from the Safe. Raw `approve` is
    ///      fine for canonical WETH/USDC (no USDT-style two-step approvals).
    function _safeApprove(address _onBehalfOf, address token, address spender, uint256 amount, uint8 step) internal {
        _safeExec(_onBehalfOf, token, abi.encodeCall(IERC20.approve, (spender, amount)), step);
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
        uint256 wethDesired,
        uint256 usdcDesired
    ) internal returns (uint256 tokenId, uint128 liquidityMinted, uint128 amount0Used, uint128 amount1Used) {
        bytes memory mintCall = _buildMintCalldata(
            p.lpPoolParam,
            p.tickLower,
            p.tickUpper,
            wethDesired,
            usdcDesired,
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
