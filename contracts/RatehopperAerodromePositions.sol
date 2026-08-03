// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {ISlipstreamNonfungiblePositionManager} from "./interfaces/aerodrome/ISlipstreamNonfungiblePositionManager.sol";
import {ICLFactory} from "./interfaces/aerodrome/ICLFactory.sol";
import {ICLPool} from "./interfaces/aerodrome/ICLPool.sol";
import {ISafe} from "./interfaces/safe/ISafe.sol";

import {IProtocolRegistry} from "./interfaces/IProtocolRegistry.sol";

/// @title RatehopperAerodromePositions
/// @notice Safe module for unstaked Aerodrome Slipstream WETH/USDC LP NFTs.
///         Swaps are built on-chain; callers only provide min-out values.
/// @dev Slipstream uses `int24 tickSpacing` instead of Uniswap V3 fee tiers.
///      LP NFTs stay on the Safe, so direct NPM fee collection bypasses
///      `feeCollectBps`.
contract RatehopperAerodromePositions is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    /// @notice Timelocked role for fund-impacting setters.
    bytes32 public constant CRITICAL_ROLE = keccak256("CRITICAL_ROLE");

    /// @dev Slipstream SwapRouter `ExactInputSingleParams`.
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        int24 tickSpacing;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    ISlipstreamNonfungiblePositionManager public immutable POSITION_MANAGER;
    IProtocolRegistry public immutable REGISTRY;
    IERC20 public immutable USDC;
    IERC20 public immutable WETH;
    address public immutable SWAP_ROUTER;
    ICLFactory public immutable CL_FACTORY;
    uint16 public immutable MAX_FEE_BPS;

    /// @notice Timelock address required by critical setters.
    address public immutable timelock;

    address public treasury;
    uint16 public performanceFeeBps;
    uint16 public feeCollectBps;
    /// @notice Per-call slippage cap for LP opens/closes.
    uint16 public maxSlippageBps = 300;

    /// @notice Absolute owner-settable slippage cap.
    uint16 public constant MAX_SETTABLE_SLIPPAGE_BPS = 1000;

    /// @notice Allowed Slipstream tick spacings for LP and swap pools.
    mapping(int24 tickSpacing => bool) public allowedTickSpacing;

    /// @notice Remaining USDC basis per tokenId. Zero means unmanaged/closed.
    mapping(uint256 tokenId => uint128 residualBasisUsd6) public residualBasisUsd6Of;

    /// @notice Minimum pool liquidity for spot-price reads. Zero disables it.
    uint128 public minPoolLiquidity;

    /// @notice Minimum liquidity returned by NPM mint. Zero disables it.
    uint128 public minPositionLiquidity;

    // Slipstream exactInputSingle((address,address,int24,address,uint256,uint256,uint256,uint160)).
    bytes4 private constant EXACT_INPUT_SINGLE_SELECTOR = 0xa026383e;

    event PositionOpened(
        address indexed onBehalfOf,
        uint256 indexed tokenId,
        uint256 usdcInput,
        uint128 wethToLp,
        uint128 usdcToLp,
        uint128 currentValueUsd6
    );
    event PositionClosed(
        address indexed onBehalfOf,
        uint256 indexed tokenId,
        uint128 basisUsd6,
        uint128 currentValueUsd6,
        uint128 feeUsd6,
        uint16 exitBps
    );
    event FeesCollected(
        address indexed onBehalfOf,
        uint256 indexed tokenId,
        address token0,
        uint256 collected0,
        uint256 fee0,
        address token1,
        uint256 collected1,
        uint256 fee1,
        uint128 currentValueUsd6
    );
    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);
    event PerformanceFeeBpsUpdated(uint16 previousPerformanceFeeBps, uint16 newPerformanceFeeBps);
    event FeeCollectBpsUpdated(uint16 previousFeeCollectBps, uint16 newFeeCollectBps);
    event MaxSlippageBpsUpdated(uint16 previousMaxSlippageBps, uint16 newMaxSlippageBps);
    event TickSpacingAllowedUpdated(int24 indexed tickSpacing, bool previousAllowed, bool newAllowed);
    event MinPoolLiquidityUpdated(uint128 previousMinPoolLiquidity, uint128 newMinPoolLiquidity);
    event MinPositionLiquidityUpdated(uint128 previousMinPositionLiquidity, uint128 newMinPositionLiquidity);
    event TokenRescued(address indexed token, address indexed recipient, uint256 amount);
    event NftRescued(address indexed token, address indexed recipient, uint256 indexed tokenId);
    event FeeTransferFailed(address indexed onBehalfOf, uint256 indexed tokenId, uint128 feeUsd6);
    event CollectFeeTransferFailed(
        address indexed onBehalfOf,
        uint256 indexed tokenId,
        address indexed token,
        uint256 attemptedFee
    );

    error InvalidTreasury();
    error FeeAboveMax();
    error SwapFailed();
    error ZeroAddress();
    error InvalidUsdcAmount();
    error InvalidExitBps();
    error SlippageAboveMax();
    error TickSpacingNotAllowed();
    error UnknownPosition();
    error WrongTokenOrder();
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

    /// @notice Allows only the registry operator or the Safe itself.
    modifier onlyOperatorOrSafe(address _onBehalfOf) {
        if (_onBehalfOf == address(0)) revert ZeroAddress();
        bool isOperator = msg.sender == REGISTRY.safeOperator();
        bool isSafe = msg.sender == _onBehalfOf;
        if (!isOperator && !isSafe) revert NotAuthorized();
        _;
    }

    constructor(
        ISlipstreamNonfungiblePositionManager _positionManager,
        IProtocolRegistry _registry,
        IERC20 _usdc,
        IERC20 _weth,
        address _swapRouter,
        ICLFactory _clFactory,
        address _treasury,
        uint16 _performanceFeeBps,
        uint16 _feeCollectBps,
        uint16 _maxFeeBps,
        address _initialAdmin,
        address _timelock,
        uint128 _minPoolLiquidity,
        uint128 _minPositionLiquidity
    ) {
        if (_initialAdmin == address(0)) revert ZeroAddress();
        if (_timelock == address(0)) revert ZeroAddress();
        if (address(_positionManager) == address(0)) revert ZeroAddress();
        if (address(_registry) == address(0)) revert ZeroAddress();
        if (address(_usdc) == address(0)) revert ZeroAddress();
        if (address(_weth) == address(0)) revert ZeroAddress();
        // This helper assumes WETH is token0 and USDC is token1.
        if (address(_weth) >= address(_usdc)) revert WrongTokenOrder();
        if (_swapRouter == address(0)) revert ZeroAddress();
        if (address(_clFactory) == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert InvalidTreasury();
        if (_maxFeeBps > 10_000) revert FeeAboveMax();
        if (_performanceFeeBps > _maxFeeBps) revert FeeAboveMax();
        if (_feeCollectBps > _maxFeeBps) revert FeeAboveMax();

        POSITION_MANAGER = _positionManager;
        REGISTRY = _registry;
        USDC = _usdc;
        WETH = _weth;
        SWAP_ROUTER = _swapRouter;
        CL_FACTORY = _clFactory;
        MAX_FEE_BPS = _maxFeeBps;
        timelock = _timelock;
        treasury = _treasury;
        performanceFeeBps = _performanceFeeBps;
        feeCollectBps = _feeCollectBps;
        minPoolLiquidity = _minPoolLiquidity;
        minPositionLiquidity = _minPositionLiquidity;

        // Default liquid Base WETH/USDC CL spacings.
        allowedTickSpacing[100] = true;
        allowedTickSpacing[200] = true;

        _grantRole(DEFAULT_ADMIN_ROLE, _initialAdmin);
        _grantRole(CRITICAL_ROLE, _timelock);
        // Prevent DEFAULT_ADMIN_ROLE from bypassing timelock-only setters.
        _setRoleAdmin(CRITICAL_ROLE, CRITICAL_ROLE);

        emit TreasuryUpdated(address(0), _treasury);
        emit PerformanceFeeBpsUpdated(0, _performanceFeeBps);
        emit FeeCollectBpsUpdated(0, _feeCollectBps);
        emit MaxSlippageBpsUpdated(0, maxSlippageBps);
        emit MinPoolLiquidityUpdated(0, _minPoolLiquidity);
        emit MinPositionLiquidityUpdated(0, _minPositionLiquidity);
        emit TickSpacingAllowedUpdated(100, false, true);
        emit TickSpacingAllowedUpdated(200, false, true);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  openLp
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Swap half the Safe's USDC to WETH and mint a WETH/USDC CL NFT.
    /// @dev Safe must enable this contract as a module and already hold USDC.
    /// @return tokenId Newly minted LP NFT id, owned by the Safe.
    function openLp(
        address _onBehalfOf,
        uint256 usdcAmount,
        int24 tickLower,
        int24 tickUpper,
        int24 lpPoolTickSpacing,
        uint256 mintAmount0Min,
        uint256 mintAmount1Min,
        int24 swapPoolTickSpacing,
        uint256 swapAmountOutMin,
        uint256 expectedSwapOut,
        uint16 slippageBps,
        uint256 deadline
    ) external nonReentrant onlyOperatorOrSafe(_onBehalfOf) returns (uint256 tokenId) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (usdcAmount == 0) revert InvalidUsdcAmount();
        _validateLpTickSpacing(lpPoolTickSpacing);
        _validateSwapParams(swapPoolTickSpacing, swapAmountOutMin, expectedSwapOut, slippageBps);
        _validatePool(CL_FACTORY.getPool(address(USDC), address(WETH), swapPoolTickSpacing));
        _validatePool(CL_FACTORY.getPool(address(WETH), address(USDC), lpPoolTickSpacing));

        uint256 halfUsdc = usdcAmount / 2;
        uint256 retainedUsdc = usdcAmount - halfUsdc;

        // Only use WETH produced by this call.
        uint256 wethBefore = WETH.balanceOf(_onBehalfOf);

        // Swap half the USDC to WETH.
        _swapExactInputSingle(
            _onBehalfOf,
            address(USDC),
            address(WETH),
            swapPoolTickSpacing,
            halfUsdc,
            swapAmountOutMin,
            deadline,
            20,
            3,
            21
        );

        uint128 wethReceived = (WETH.balanceOf(_onBehalfOf) - wethBefore).toUint128();
        // Avoid accidental one-sided mints after a zero-output swap.
        if (wethReceived == 0) revert SwapFailed();

        // Approve NPM and mint the LP NFT to the Safe.
        _safeApprove(_onBehalfOf, address(WETH), address(POSITION_MANAGER), uint256(wethReceived), 22);
        _safeApprove(_onBehalfOf, address(USDC), address(POSITION_MANAGER), retainedUsdc, 23);

        uint128 usedWeth;
        uint128 usedUsdc;
        (tokenId, usedWeth, usedUsdc) = _safeMintLp(
            _onBehalfOf,
            lpPoolTickSpacing,
            tickLower,
            tickUpper,
            uint256(wethReceived),
            retainedUsdc,
            mintAmount0Min,
            mintAmount1Min,
            deadline
        );

        _safeApprove(_onBehalfOf, address(WETH), address(POSITION_MANAGER), 0, 24);
        _safeApprove(_onBehalfOf, address(USDC), address(POSITION_MANAGER), 0, 25);

        // Final sanity: NFT must be on the Safe.
        if (POSITION_MANAGER.ownerOf(tokenId) != _onBehalfOf) revert LpNotOnSafe();

        // Basis uses the just-executed swap rate for the WETH leg.
        uint128 currentValueUsd6;
        {
            uint256 wethValueInUsdc = Math.mulDiv(uint256(usedWeth), halfUsdc, uint256(wethReceived));
            currentValueUsd6 = (wethValueInUsdc + uint256(usedUsdc)).toUint128();
        }

        // Basis is prorated on partial closes and deleted on full close.
        residualBasisUsd6Of[tokenId] = currentValueUsd6;

        emit PositionOpened(_onBehalfOf, tokenId, usdcAmount, usedWeth, usedUsdc, currentValueUsd6);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  closeLp
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Harvest fees, remove liquidity, burn on full close, and swap WETH to USDC.
    /// @dev Debt repayment happens outside this function. `exitBps == 10_000` is a full close.
    function closeLp(
        address _onBehalfOf,
        uint256 tokenId,
        int24 swapPoolTickSpacing,
        uint256 swapAmountOutMin,
        uint256 expectedSwapOut,
        uint16 slippageBps,
        uint16 exitBps,
        uint256 decreaseAmount0Min,
        uint256 decreaseAmount1Min,
        uint256 deadline,
        uint256 minUsdcOut
    ) external nonReentrant onlyOperatorOrSafe(_onBehalfOf) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (exitBps == 0 || exitBps > 10_000) revert InvalidExitBps();

        // Keep unknown-position errors independent of NPM revert strings.
        uint128 residualBasis = residualBasisUsd6Of[tokenId];
        if (residualBasis == 0) revert UnknownPosition();

        _requireWethUsdcPositionOwnedBy(_onBehalfOf, tokenId);
        uint128 basisForExit = exitBps == 10_000
            ? residualBasis
            : Math.mulDiv(uint256(residualBasis), uint256(exitBps), 10_000).toUint128();
        if (exitBps == 10_000) {
            delete residualBasisUsd6Of[tokenId];
        } else {
            residualBasisUsd6Of[tokenId] = residualBasis - basisForExit;
        }

        // Measure only deltas from this close.
        uint256 wethBefore = WETH.balanceOf(_onBehalfOf);
        uint256 usdcBefore = USDC.balanceOf(_onBehalfOf);

        // Harvest fees before principal so feeCollectBps does not tax capital.
        _collectLp(_onBehalfOf, tokenId);

        // On full close, remove exact liquidity so burn can succeed.
        (, , , , , , , uint128 liquidity, , , , ) = POSITION_MANAGER.positions(tokenId);
        uint128 liquidityToRemove = exitBps == 10_000
            ? liquidity
            : Math.mulDiv(uint256(liquidity), uint256(exitBps), 10_000).toUint128();

        // Do not reduce basis when rounding removes zero liquidity.
        if (exitBps != 10_000 && basisForExit > 0 && liquidityToRemove == 0) {
            revert InvalidExitBps();
        }

        if (liquidityToRemove > 0) {
            _safeExec(
                _onBehalfOf,
                address(POSITION_MANAGER),
                0,
                abi.encodeCall(
                    ISlipstreamNonfungiblePositionManager.decreaseLiquidity,
                    (
                        ISlipstreamNonfungiblePositionManager.DecreaseLiquidityParams({
                            tokenId: tokenId,
                            liquidity: liquidityToRemove,
                            amount0Min: decreaseAmount0Min,
                            amount1Min: decreaseAmount1Min,
                            deadline: deadline
                        })
                    )
                ),
                7
            );

            // Collect principal to the Safe. No protocol fee on capital.
            _collectToRecipient(_onBehalfOf, tokenId, _onBehalfOf, 8);
        }

        // Burn only on a full close.
        if (exitBps == 10_000) {
            _safeExec(
                _onBehalfOf,
                address(POSITION_MANAGER),
                0,
                abi.encodeCall(ISlipstreamNonfungiblePositionManager.burn, (tokenId)),
                9
            );
        }

        // Swap only if this close produced WETH.
        uint128 wethToSwap = (WETH.balanceOf(_onBehalfOf) - wethBefore).toUint128();
        if (wethToSwap > 0) {
            _validateSwapParams(swapPoolTickSpacing, swapAmountOutMin, expectedSwapOut, slippageBps);
            _validatePool(CL_FACTORY.getPool(address(WETH), address(USDC), swapPoolTickSpacing));
            _swapExactInputSingle(
                _onBehalfOf,
                address(WETH),
                address(USDC),
                swapPoolTickSpacing,
                uint256(wethToSwap),
                swapAmountOutMin,
                deadline,
                26,
                10,
                27
            );
        }

        uint128 currentValueUsd6 = (USDC.balanceOf(_onBehalfOf) - usdcBefore).toUint128();
        // Final gross-USDC guard.
        if (uint256(currentValueUsd6) < minUsdcOut) revert MinUsdcOutNotMet();

        // Performance fee applies only to realized profit.
        uint128 feeUsd6 = 0;
        if (currentValueUsd6 > basisForExit) {
            uint256 profit = uint256(currentValueUsd6) - uint256(basisForExit);
            feeUsd6 = ((profit * performanceFeeBps) / 10_000).toUint128();
            if (feeUsd6 > 0) {
                // Fee failure must not block exits.
                if (!_trySafeTransfer(_onBehalfOf, address(USDC), treasury, feeUsd6)) {
                    emit FeeTransferFailed(_onBehalfOf, tokenId, feeUsd6);
                    feeUsd6 = 0;
                }
            }
        }

        emit PositionClosed(_onBehalfOf, tokenId, basisForExit, currentValueUsd6, feeUsd6, exitBps);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  collectLp
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Harvest LP fees, optionally swapping the WETH remainder to USDC.
    function collectLp(
        address _onBehalfOf,
        uint256 tokenId,
        bool swapWethToUsdc,
        int24 swapPoolTickSpacing,
        uint256 swapAmountOutMin,
        uint256 expectedSwapOut,
        uint16 slippageBps,
        uint256 deadline
    ) external nonReentrant onlyOperatorOrSafe(_onBehalfOf) {
        // Only manage positions opened by this helper.
        if (residualBasisUsd6Of[tokenId] == 0) revert UnknownPosition();
        _requireWethUsdcPositionOwnedBy(_onBehalfOf, tokenId);

        if (swapWethToUsdc) {
            // No-swap path intentionally ignores swap params.
            if (block.timestamp > deadline) revert DeadlineExpired();
            _validateSwapParams(swapPoolTickSpacing, swapAmountOutMin, expectedSwapOut, slippageBps);
            _validatePool(CL_FACTORY.getPool(address(WETH), address(USDC), swapPoolTickSpacing));

            uint256 wethBefore = WETH.balanceOf(_onBehalfOf);
            _collectLp(_onBehalfOf, tokenId);
            uint256 wethDelta = WETH.balanceOf(_onBehalfOf) - wethBefore;
            if (wethDelta > 0) {
                _swapExactInputSingle(
                    _onBehalfOf,
                    address(WETH),
                    address(USDC),
                    swapPoolTickSpacing,
                    wethDelta,
                    swapAmountOutMin,
                    deadline,
                    26,
                    10,
                    27
                );
            }
        } else {
            _collectLp(_onBehalfOf, tokenId);
        }
    }

    /// @dev Collect fees through this contract so `feeCollectBps` can be skimmed.
    function _collectLp(address _onBehalfOf, uint256 tokenId) internal {
        (, , address token0, address token1, int24 lpTickSpacing, , , , , , , ) = POSITION_MANAGER.positions(tokenId);

        uint256 bal0Before = IERC20(token0).balanceOf(address(this));
        uint256 bal1Before = IERC20(token1).balanceOf(address(this));

        _collectToRecipient(_onBehalfOf, tokenId, address(this), 6);

        uint256 collected0 = IERC20(token0).balanceOf(address(this)) - bal0Before;
        uint256 collected1 = IERC20(token1).balanceOf(address(this)) - bal1Before;

        // Value WETH fees at the LP pool spot price; USDC is already 6 decimals.
        uint128 currentValueUsd6;
        if (collected0 > 0) {
            address pool = CL_FACTORY.getPool(token0, token1, lpTickSpacing);
            uint160 sqrtPriceX96 = _validatePool(pool);
            // Avoid overflow from materializing sqrtPriceX96 squared.
            uint256 priceX96 = Math.mulDiv(uint256(sqrtPriceX96), uint256(sqrtPriceX96), 1 << 96);
            uint256 wethValueInUsdc = Math.mulDiv(collected0, priceX96, 1 << 96);
            currentValueUsd6 = (wethValueInUsdc + collected1).toUint128();
        } else {
            currentValueUsd6 = collected1.toUint128();
        }

        uint256 fee0 = _chargeCollectFee(token0, collected0, _onBehalfOf, tokenId);
        uint256 fee1 = _chargeCollectFee(token1, collected1, _onBehalfOf, tokenId);

        emit FeesCollected(_onBehalfOf, tokenId, token0, collected0, fee0, token1, collected1, fee1, currentValueUsd6);
    }

    /// @dev Module-mediated full NPM collect.
    function _collectToRecipient(address _onBehalfOf, uint256 tokenId, address recipient, uint8 step) internal {
        _safeExec(
            _onBehalfOf,
            address(POSITION_MANAGER),
            0,
            abi.encodeCall(
                ISlipstreamNonfungiblePositionManager.collect,
                (
                    ISlipstreamNonfungiblePositionManager.CollectParams({
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

    /// @dev Module-mediated exact-input swap on the pinned Slipstream router.
    function _swapExactInputSingle(
        address _onBehalfOf,
        address tokenIn,
        address tokenOut,
        int24 tickSpacing,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 deadline,
        uint8 approveStep,
        uint8 execStep,
        uint8 resetStep
    ) internal {
        bytes memory swapData = abi.encodeWithSelector(
            EXACT_INPUT_SINGLE_SELECTOR,
            ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                tickSpacing: tickSpacing,
                recipient: _onBehalfOf,
                deadline: deadline,
                amountIn: amountIn,
                amountOutMinimum: amountOutMin,
                sqrtPriceLimitX96: 0
            })
        );
        _safeApprove(_onBehalfOf, tokenIn, SWAP_ROUTER, amountIn, approveStep);
        _safeExec(_onBehalfOf, SWAP_ROUTER, 0, swapData, execStep);
        _safeApprove(_onBehalfOf, tokenIn, SWAP_ROUTER, 0, resetStep);
    }

    /// @dev Binds slippageBps to the caller's quoter-derived min-out.
    function _validateLpTickSpacing(int24 lpPoolTickSpacing) internal view {
        if (!allowedTickSpacing[lpPoolTickSpacing]) revert TickSpacingNotAllowed();
    }

    function _validateSwapParams(
        int24 swapPoolTickSpacing,
        uint256 swapAmountOutMin,
        uint256 expectedSwapOut,
        uint16 slippageBps
    ) internal view {
        if (slippageBps == 0) revert SlippageTooLow();
        if (slippageBps > maxSlippageBps) revert SlippageAboveMax();
        if (!allowedTickSpacing[swapPoolTickSpacing]) revert TickSpacingNotAllowed();
        if (swapAmountOutMin == 0) revert InvalidSwapAmountOutMin();
        if (expectedSwapOut == 0) revert InvalidExpectedSwapOut();
        if (swapAmountOutMin < (expectedSwapOut * (10_000 - slippageBps)) / 10_000) {
            revert SwapMinBelowSlippageFloor();
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Owner controls
    // ─────────────────────────────────────────────────────────────────────

    function setTreasury(address newTreasury) external onlyRole(CRITICAL_ROLE) {
        if (msg.sender != timelock) revert OnlyTimelock();
        if (newTreasury == address(0)) revert InvalidTreasury();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    function setPerformanceFeeBps(uint16 newPerformanceFeeBps) external onlyRole(CRITICAL_ROLE) {
        if (msg.sender != timelock) revert OnlyTimelock();
        if (newPerformanceFeeBps > MAX_FEE_BPS) revert FeeAboveMax();
        emit PerformanceFeeBpsUpdated(performanceFeeBps, newPerformanceFeeBps);
        performanceFeeBps = newPerformanceFeeBps;
    }

    function setFeeCollectBps(uint16 newFeeCollectBps) external onlyRole(CRITICAL_ROLE) {
        if (msg.sender != timelock) revert OnlyTimelock();
        if (newFeeCollectBps > MAX_FEE_BPS) revert FeeAboveMax();
        emit FeeCollectBpsUpdated(feeCollectBps, newFeeCollectBps);
        feeCollectBps = newFeeCollectBps;
    }

    /// @notice Update the per-call slippage ceiling.
    function setMaxSlippageBps(uint16 newMaxSlippageBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newMaxSlippageBps > MAX_SETTABLE_SLIPPAGE_BPS) revert SlippageAboveMax();
        emit MaxSlippageBpsUpdated(maxSlippageBps, newMaxSlippageBps);
        maxSlippageBps = newMaxSlippageBps;
    }

    /// @notice Enable or disable a Slipstream tick spacing.
    function setTickSpacingAllowed(int24 tickSpacing, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        bool previousAllowed = allowedTickSpacing[tickSpacing];
        emit TickSpacingAllowedUpdated(tickSpacing, previousAllowed, allowed);
        allowedTickSpacing[tickSpacing] = allowed;
    }

    /// @notice Update the pool-liquidity floor. Zero disables it.
    function setMinPoolLiquidity(uint128 newMinPoolLiquidity) external onlyRole(DEFAULT_ADMIN_ROLE) {
        emit MinPoolLiquidityUpdated(minPoolLiquidity, newMinPoolLiquidity);
        minPoolLiquidity = newMinPoolLiquidity;
    }

    /// @notice Update the minted-position liquidity floor. Zero disables it.
    function setMinPositionLiquidity(uint128 newMinPositionLiquidity) external onlyRole(DEFAULT_ADMIN_ROLE) {
        emit MinPositionLiquidityUpdated(minPositionLiquidity, newMinPositionLiquidity);
        minPositionLiquidity = newMinPositionLiquidity;
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
    //  Internal helpers
    // ─────────────────────────────────────────────────────────────────────

    /// @dev Accept empty ERC20 return data or the canonical true word only.
    ///      Malformed/false returndata must waive the fee without blocking an exit.
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
        if (ret.length == 0) return true;
        if (ret.length < 32) return false;
        uint256 word;
        assembly ("memory-safe") {
            word := mload(add(ret, 0x20))
        }
        return word == 1;
    }

    /// @dev Require a Safe-owned WETH/USDC LP NFT.
    function _requireWethUsdcPositionOwnedBy(address _onBehalfOf, uint256 tokenId) internal view {
        (, , address token0, address token1, , , , , , , , ) = POSITION_MANAGER.positions(tokenId);
        if (token0 != address(WETH) || token1 != address(USDC)) revert WrongTokenPair();
        if (POSITION_MANAGER.ownerOf(tokenId) != _onBehalfOf) revert LpNotOnSafe();
    }

    /// @notice Validate a WETH/USDC pool and return its spot price.
    function _validatePool(address pool) internal view returns (uint160 sqrtPriceX96) {
        if (pool == address(0)) revert PoolDoesNotExist();
        if (ICLPool(pool).token0() != address(WETH) || ICLPool(pool).token1() != address(USDC)) {
            revert WrongTokenPair();
        }
        (sqrtPriceX96, , , , , ) = ICLPool(pool).slot0();
        if (sqrtPriceX96 == 0) revert PoolNotInitialized();
        uint128 floor = minPoolLiquidity;
        if (floor > 0 && ICLPool(pool).liquidity() < floor) revert PoolTooThin();
    }

    /// @notice Skim the collect fee and forward the remainder to the Safe.
    /// @dev Treasury transfer failure waives the fee instead of blocking users.
    function _chargeCollectFee(
        address token,
        uint256 amount,
        address _onBehalfOf,
        uint256 tokenId
    ) internal returns (uint256 fee) {
        if (amount == 0) return 0;
        fee = (amount * feeCollectBps) / 10_000;
        uint256 toSafe = amount;
        if (fee > 0) {
            try IERC20(token).transfer(treasury, fee) returns (bool ok) {
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

    // ─────────────────────────────────────────────────────────────────────
    //  openLp helpers
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Module-mediated ERC20 approve from the Safe.
    /// @dev Assumes canonical WETH/USDC approval behavior.
    function _safeApprove(address _onBehalfOf, address token, address spender, uint256 amount, uint8 step) internal {
        bytes memory approveCall = abi.encodeCall(IERC20.approve, (spender, amount));
        (bool ok, bytes memory ret) = ISafe(_onBehalfOf).execTransactionFromModuleReturnData(
            token,
            0,
            approveCall,
            ISafe.Operation.Call
        );
        if (!ok) {
            if (ret.length > 0) Address.verifyCallResult(ok, ret);
            revert ModuleCallFailed(step);
        }
    }

    /// @notice Module-mediated Safe call with revert bubbling.
    function _safeExec(address _onBehalfOf, address target, uint256 value, bytes memory data, uint8 step) internal {
        (bool ok, bytes memory ret) = ISafe(_onBehalfOf).execTransactionFromModuleReturnData(
            target,
            value,
            data,
            ISafe.Operation.Call
        );
        if (!ok) {
            if (ret.length > 0) Address.verifyCallResult(ok, ret);
            revert ModuleCallFailed(step);
        }
    }

    /// @notice Module-mediated NPM mint from the Safe.
    function _safeMintLp(
        address _onBehalfOf,
        int24 lpPoolTickSpacing,
        int24 tickLower,
        int24 tickUpper,
        uint256 wethDesired,
        uint256 usdcDesired,
        uint256 amount0Min,
        uint256 amount1Min,
        uint256 deadline
    ) internal returns (uint256 tokenId, uint128 amount0Used, uint128 amount1Used) {
        ISlipstreamNonfungiblePositionManager.MintParams memory params = ISlipstreamNonfungiblePositionManager
            .MintParams({
                token0: address(WETH),
                token1: address(USDC),
                tickSpacing: lpPoolTickSpacing,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: wethDesired,
                amount1Desired: usdcDesired,
                amount0Min: amount0Min,
                amount1Min: amount1Min,
                recipient: _onBehalfOf,
                deadline: deadline,
                sqrtPriceX96: 0
            });

        bytes memory mintCall = abi.encodeCall(ISlipstreamNonfungiblePositionManager.mint, params);
        (bool ok, bytes memory ret) = ISafe(_onBehalfOf).execTransactionFromModuleReturnData(
            address(POSITION_MANAGER),
            0,
            mintCall,
            ISafe.Operation.Call
        );
        if (!ok) revert ModuleCallFailed(4);

        uint256 amount0Out;
        uint256 amount1Out;
        uint128 liquidityMinted;
        (tokenId, liquidityMinted, amount0Out, amount1Out) = abi.decode(ret, (uint256, uint128, uint256, uint256));
        // Avoid dust positions that make partial-close rounding unsafe.
        if (liquidityMinted < minPositionLiquidity) revert PositionLiquidityTooLow();
        amount0Used = amount0Out.toUint128();
        amount1Used = amount1Out.toUint128();
    }
}
