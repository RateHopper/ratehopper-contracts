// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {INonfungiblePositionManager} from "./interfaces/uniswapV3/INonfungiblePositionManager.sol";
import {IUniswapV3Factory} from "./interfaces/uniswapV3/IUniswapV3Factory.sol";
import {IUniswapV3Pool} from "./interfaces/uniswapV3/IUniswapV3Pool.sol";
import {ISafe} from "./interfaces/safe/ISafe.sol";

import {IProtocolRegistry} from "./interfaces/IProtocolRegistry.sol";

/// @title RatehopperUniV3Positions
/// @notice Atomic Uniswap V3 WETH/USDC LP lifecycle helper for Gnosis Safes:
///           - `openLp()` splits the Safe's USDC, swaps half to WETH on the
///             pinned SwapRouter02, then mints a WETH/USDC LP NFT on the Safe.
///           - `closeLp()` pulls the LP NFT, decreaseLiquidity + collect +
///             burn, swaps the WETH leg back to USDC, and forwards realized
///             USDC to the Safe.
///           - `collectLp()` harvests accrued LP fees without exiting; a
///             `feeCollectBps` cut is sent to `treasury`, remainder to Safe.
///         All swap calldata is built on-chain to prevent caller injection;
///         spot-price-based slippage is applied per-call via `slippageBps`.
///         Supply/borrow on a lending protocol (e.g. Fluid) and debt repayment
///         are the user's responsibility via separate Safe transactions.
contract RatehopperUniV3Positions is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev Mirror of SwapRouter02's `ExactInputSingleParams`. Inlined so we
    ///      can build the swap calldata on-chain without trusting any
    ///      caller-supplied bytes blob.
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    INonfungiblePositionManager public immutable POSITION_MANAGER;
    IProtocolRegistry public immutable REGISTRY;
    IERC20 public immutable USDC;
    IERC20 public immutable WETH;
    address public immutable SWAP_ROUTER;
    IUniswapV3Factory public immutable UNISWAP_V3_FACTORY;
    uint16 public immutable MAX_FEE_BPS;

    address public treasury;
    uint16 public performanceFeeBps;
    uint16 public feeCollectBps;
    /// @notice Hard ceiling on the caller-supplied `slippageBps` accepted by
    ///         `openLp` / `closeLp` / `_quoteSwapAmountOutMin`. Defaults to
    ///         300 (3%). Owner-mutable via `setMaxSlippageBps`, but capped at
    ///         `MAX_SETTABLE_SLIPPAGE_BPS = 1000` (10%) to bound the owner's
    ///         authority — even a compromised owner cannot disable slippage
    ///         protection entirely.
    uint16 public maxSlippageBps = 300;

    /// @notice Absolute ceiling on what owner can set `maxSlippageBps` to.
    ///         Hard-coded user-protection guardrail.
    uint16 public constant MAX_SETTABLE_SLIPPAGE_BPS = 1000;

    /// @notice Allow-list of acceptable Uniswap V3 fee tiers for both the LP
    ///         pool (mint side) and the swap pool. Constrains caller / operator
    ///         routing away from thin pools where `slot0` manipulation is
    ///         cheap and slippage extraction is large. Defaults at deploy:
    ///         {100, 500, 3000} = enabled; everything else (notably the
    ///         10000-bps WETH/USDC tier on Base) = disabled. Mutable via
    ///         `setFeeTierAllowed`.
    mapping(uint24 feeTier => bool) public allowedFeeTier;

    /// @notice Per-tokenId cost basis remaining to be drawn down by future
    ///         `closeLp` calls. Set at `openLp` to the freshly-minted LP's
    ///         USDC-equivalent value (immutable to the caller); decremented
    ///         by `basis * exitBps / 10_000` on each `closeLp`, deleted on a
    ///         full close. A value of 0 means "no active position recorded
    ///         under this tokenId" (never opened via this contract OR already
    ///         fully closed). This replaces the prior caller-attested
    ///         `initialValueUsd6` parameter — neither a Safe owner nor a
    ///         compromised operator can lie about the perf-fee basis anymore.
    mapping(uint256 tokenId => uint128 residualBasisUsd6) public residualBasisUsd6Of;

    bytes4 private constant EXACT_INPUT_SINGLE_SELECTOR = 0x04e45aaf;

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
    event FeeTierAllowedUpdated(uint24 indexed feeTier, bool previousAllowed, bool newAllowed);
    event TokenRescued(address indexed token, address indexed recipient, uint256 amount);

    error InvalidTreasury();
    error FeeAboveMax();
    error SwapFailed();
    error ZeroAddress();
    error InvalidUsdcAmount();
    error InvalidExitBps();
    error SlippageAboveMax();
    error FeeTierNotAllowed();
    error UnknownPosition();
    error ModuleCallFailed(uint8 step);
    error LpNotOnSafe();
    error NotAuthorized();
    error DeadlineExpired();

    /// @notice Restricts a call to either the backend operator (the registry's
    ///         `safeOperator`) or the Safe itself. The operator drives closes
    ///         on the Safe's behalf; the Safe can always self-serve.
    /// @dev    `exit()` is invoked module-mediated (msg.sender == _onBehalfOf), so the
    ///         registry's `safeOperator` slot is free to be the backend EOA —
    ///         it is NOT this contract.
    modifier onlyOperatorOrSafe(address _onBehalfOf) {
        if (_onBehalfOf == address(0)) revert ZeroAddress();
        if (msg.sender != REGISTRY.safeOperator() && msg.sender != _onBehalfOf) {
            revert NotAuthorized();
        }
        _;
    }

    constructor(
        INonfungiblePositionManager _positionManager,
        IProtocolRegistry _registry,
        IERC20 _usdc,
        IERC20 _weth,
        address _swapRouter,
        IUniswapV3Factory _uniswapV3Factory,
        address _treasury,
        uint16 _performanceFeeBps,
        uint16 _feeCollectBps,
        uint16 _maxFeeBps,
        address _initialOwner
    ) Ownable(_initialOwner) {
        if (address(_positionManager) == address(0)) revert ZeroAddress();
        if (address(_registry) == address(0)) revert ZeroAddress();
        if (address(_usdc) == address(0)) revert ZeroAddress();
        if (address(_weth) == address(0)) revert ZeroAddress();
        if (_swapRouter == address(0)) revert ZeroAddress();
        if (address(_uniswapV3Factory) == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert InvalidTreasury();
        if (_performanceFeeBps > _maxFeeBps) revert FeeAboveMax();
        if (_feeCollectBps > _maxFeeBps) revert FeeAboveMax();

        POSITION_MANAGER = _positionManager;
        REGISTRY = _registry;
        USDC = _usdc;
        WETH = _weth;
        SWAP_ROUTER = _swapRouter;
        UNISWAP_V3_FACTORY = _uniswapV3Factory;
        MAX_FEE_BPS = _maxFeeBps;
        treasury = _treasury;
        performanceFeeBps = _performanceFeeBps;
        feeCollectBps = _feeCollectBps;

        // Default allow-list: the three liquid Base WETH/USDC tiers. Excludes
        // 10000 deliberately — that pool is thin and is the cheap target for
        // slot0 manipulation. Owner can flip individual tiers later via
        // `setFeeTierAllowed`.
        allowedFeeTier[100] = true;
        allowedFeeTier[500] = true;
        allowedFeeTier[3000] = true;
    }

    // ─────────────────────────────────────────────────────────────────────
    //  openLp
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Atomic LP-mint helper. The Safe must already hold
    ///         `usdcAmount` USDC (supply ETH as collateral + borrow USDC are
    ///         performed by the user outside this function — typically a
    ///         separate Safe transaction).
    ///         openLp does just two things:
    ///           1. Swap half of the held USDC to WETH via the pinned
    ///              SwapRouter02. The swap calldata is built on-chain so
    ///              the caller cannot inject a `multicall` / `sweepToken` /
    ///              alternative recipient.
    ///           2. Mint a Uniswap V3 WETH/USDC LP position on the Safe
    ///              with the swap-output WETH + retained USDC.
    /// @dev    PRECONDITIONS:
    ///           (a) The Safe MUST have enabled this contract as a Safe
    ///               module. Every sub-step is executed via
    ///               `Safe.execTransactionFromModule`. If RHP is not a
    ///               module, the first sub-step reverts with
    ///               `ModuleCallFailed`.
    ///           (b) The Safe MUST hold at least `usdcAmount` of USDC.
    /// @return tokenId  The newly-minted LP NFT id (owned by the Safe).
    function openLp(
        address _onBehalfOf,
        uint256 usdcAmount,
        int24 tickLower,
        int24 tickUpper,
        uint24 lpPoolFeeTier,
        uint256 mintAmount0Min,
        uint256 mintAmount1Min,
        uint24 swapPoolFeeTier,
        uint256 swapAmountOutMin,
        uint16 slippageBps,
        uint256 deadline
    )
        external
        nonReentrant
        onlyOperatorOrSafe(_onBehalfOf)
        returns (uint256 tokenId)
    {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (usdcAmount == 0) revert InvalidUsdcAmount();
        if (slippageBps > maxSlippageBps) revert SlippageAboveMax();
        if (!allowedFeeTier[lpPoolFeeTier]) revert FeeTierNotAllowed();
        if (!allowedFeeTier[swapPoolFeeTier]) revert FeeTierNotAllowed();

        uint256 halfUsdc = usdcAmount / 2;
        uint256 retainedUsdc = usdcAmount - halfUsdc;

        // Snapshot Safe's WETH balance so we only consume what the swap
        // produces (don't drain any pre-existing WETH the Safe held).
        uint256 wethBefore = WETH.balanceOf(_onBehalfOf);

        // 1. Build the swap calldata in-contract — caller controls only the
        //    fee tier, not the selector / tokens / recipient. `amountOutMinimum`
        //    is caller-supplied (`swapAmountOutMin`, derived off-chain from a
        //    quote with a tolerance buffer); spot-price-based fallback is
        //    intentionally removed (per C-01) to prevent in-block manipulation.
        bytes memory swapData = abi.encodeWithSelector(
            EXACT_INPUT_SINGLE_SELECTOR,
            ExactInputSingleParams({
                tokenIn: address(USDC),
                tokenOut: address(WETH),
                fee: swapPoolFeeTier,
                recipient: _onBehalfOf,
                amountIn: halfUsdc,
                amountOutMinimum: swapAmountOutMin,
                sqrtPriceLimitX96: 0
            })
        );

        // 2. Approve SwapRouter for halfUsdc and run the swap.
        _safeApprove(_onBehalfOf, address(USDC), SWAP_ROUTER, halfUsdc);
        _safeExec(_onBehalfOf, SWAP_ROUTER, 0, swapData, 3);
        _safeApprove(_onBehalfOf, address(USDC), SWAP_ROUTER, 0); // reset

        uint128 wethReceived = uint128(WETH.balanceOf(_onBehalfOf) - wethBefore);

        // 3. Approve NPM and mint the LP. NFT lands on Safe. amount0Min /
        //    amount1Min come from the caller (typically derived off-chain
        //    from a quote with a tolerance buffer); set both to 0 to opt out
        //    of slippage protection (e.g. for one-sided ranges).
        _safeApprove(_onBehalfOf, address(WETH), address(POSITION_MANAGER), uint256(wethReceived));
        _safeApprove(_onBehalfOf, address(USDC), address(POSITION_MANAGER), retainedUsdc);

        uint128 usedWeth;
        uint128 usedUsdc;
        (tokenId, usedWeth, usedUsdc) = _safeMintLp(
            _onBehalfOf,
            lpPoolFeeTier,
            tickLower,
            tickUpper,
            uint256(wethReceived),
            retainedUsdc,
            mintAmount0Min,
            mintAmount1Min,
            deadline
        );

        _safeApprove(_onBehalfOf, address(WETH), address(POSITION_MANAGER), 0);
        _safeApprove(_onBehalfOf, address(USDC), address(POSITION_MANAGER), 0);

        // 4. Final sanity: NFT must be on the Safe.
        if (POSITION_MANAGER.ownerOf(tokenId) != _onBehalfOf) revert LpNotOnSafe();

        // USDC-equivalent value of the freshly-minted LP position. WETH leg
        // is valued using the just-executed swap rate (halfUsdc / wethReceived)
        // instead of a separate oracle / slot0 read — same data, no extra gas.
        uint128 currentValueUsd6;
        {
            uint256 wethValueInUsdc = wethReceived > 0
                ? Math.mulDiv(uint256(usedWeth), halfUsdc, uint256(wethReceived))
                : 0;
            currentValueUsd6 = uint128(wethValueInUsdc + uint256(usedUsdc));
        }

        // Persist the open-time basis on-chain so `closeLp` can no longer
        // accept a caller-attested value. The slot is decremented on each
        // partial close and deleted on a full close (C-03).
        residualBasisUsd6Of[tokenId] = currentValueUsd6;

        emit PositionOpened(_onBehalfOf, tokenId, usdcAmount, usedWeth, usedUsdc, currentValueUsd6);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  closeLp
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Atomic LP unwind: harvest fees → decreaseLiquidity (partial or
    ///         full) → collect principal → (full only) burn → swap WETH leg to
    ///         USDC. The NFT stays on the Safe throughout; every sub-step is
    ///         module-mediated.
    /// @dev    Debt repayment happens outside this function (the user runs
    ///         Fluid `exit()` via a separate Safe transaction once the USDC
    ///         lands on the Safe). PRECONDITION: the Safe MUST have enabled
    ///         this contract as a Safe module. Callable by the Safe itself
    ///         or the backend operator (`registry.safeOperator()`).
    /// @param  _onBehalfOf  The Safe whose position is being closed.
    /// @param  tokenId      Uniswap V3 LP NFT id (owned by `_onBehalfOf`).
    /// @param  swapPoolFeeTier      Uniswap V3 pool fee tier used to swap the WETH
    ///                      leg back to USDC.
    /// @param  slippageBps  Slippage tolerance in bps applied to the swap's
    ///                      spot-price quote.
    /// @param  exitBps      Fraction of remaining liquidity to remove, in bps.
    ///                      `10_000` = full close (NFT is burned, residual
    ///                      basis deleted); any value in `(0, 10_000)` is a
    ///                      partial close (NFT kept alive, accrued fees still
    ///                      fully harvested up-front, residual basis
    ///                      decremented by `residual * exitBps / 10_000`).
    ///                      Must satisfy `0 < exitBps <= 10_000`.
    /// @dev    The performance-fee basis is read from `residualBasisUsd6Of`
    ///         (set at `openLp` to the freshly-minted LP's USDC-equivalent
    ///         value) and prorated by `exitBps`. Caller cannot lie about
    ///         basis (C-03). On full close the slot is deleted; on partial
    ///         close it is decremented so subsequent closes always price
    ///         against the correct residual without off-chain bookkeeping.
    function closeLp(
        address _onBehalfOf,
        uint256 tokenId,
        uint24 swapPoolFeeTier,
        uint256 swapAmountOutMin,
        uint16 slippageBps,
        uint16 exitBps,
        uint256 decreaseAmount0Min,
        uint256 decreaseAmount1Min,
        uint256 deadline
    ) external nonReentrant onlyOperatorOrSafe(_onBehalfOf) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (exitBps == 0 || exitBps > 10_000) revert InvalidExitBps();
        if (slippageBps > maxSlippageBps) revert SlippageAboveMax();
        if (!allowedFeeTier[swapPoolFeeTier]) revert FeeTierNotAllowed();

        // Read + decrement stored basis BEFORE any module call (CEI). Zero
        // means either never opened via this contract or already fully closed.
        uint128 residualBasis = residualBasisUsd6Of[tokenId];
        if (residualBasis == 0) revert UnknownPosition();
        uint128 basisForExit = exitBps == 10_000
            ? residualBasis
            : uint128(Math.mulDiv(uint256(residualBasis), uint256(exitBps), 10_000));
        if (exitBps == 10_000) {
            delete residualBasisUsd6Of[tokenId];
        } else {
            residualBasisUsd6Of[tokenId] = residualBasis - basisForExit;
        }

        // Snapshot Safe balances so we measure only what this closeLp adds.
        uint256 wethBefore = WETH.balanceOf(_onBehalfOf);
        uint256 usdcBefore = USDC.balanceOf(_onBehalfOf);

        // 1. Harvest accrued LP fees first. Before `decreaseLiquidity`, the
        //    position's `tokensOwed` contains ONLY the accrued fees, so
        //    `_collectLp` charges `feeCollectBps` on the fees alone (not on
        //    principal). Done on every close — partial or full — so the user
        //    always receives the full accrued-fee accounting.
        _collectLp(_onBehalfOf, tokenId);

        // 2. Decrease liquidity (partial or full), module-mediated. Principal
        //    moves into `tokensOwed0`/`tokensOwed1`, ready to be collected.
        //    On full close (`exitBps == 10_000`), avoid the mulDiv round-down
        //    and remove exactly `liquidity` so `burn` succeeds.
        (, , , , , , , uint128 liquidity, , , , ) = POSITION_MANAGER.positions(tokenId);
        uint128 liquidityToRemove = exitBps == 10_000
            ? liquidity
            : uint128(Math.mulDiv(uint256(liquidity), uint256(exitBps), 10_000));

        if (liquidityToRemove > 0) {
            _safeExec(
                _onBehalfOf,
                address(POSITION_MANAGER),
                0,
                abi.encodeCall(
                    INonfungiblePositionManager.decreaseLiquidity,
                    (INonfungiblePositionManager.DecreaseLiquidityParams({
                        tokenId: tokenId,
                        liquidity: liquidityToRemove,
                        amount0Min: decreaseAmount0Min,
                        amount1Min: decreaseAmount1Min,
                        deadline: deadline
                    }))
                ),
                7
            );

            // 3. Collect the principal directly to the Safe (no fee — capital).
            //    Also needed for `burn` to succeed (NPM requires tokensOwed == 0).
            _collectToRecipient(_onBehalfOf, tokenId, _onBehalfOf, 8);
        }

        // 4. Burn the now-empty NFT only on a full close. Partial closes leave
        //    the position open so it can keep earning fees / be unwound later.
        if (exitBps == 10_000) {
            _safeExec(
                _onBehalfOf,
                address(POSITION_MANAGER),
                0,
                abi.encodeCall(INonfungiblePositionManager.burn, (tokenId)),
                9
            );
        }

        // 5. Swap the WETH delta on the Safe → USDC, mirroring openLp's
        //    structure (module-mediated, on-chain calldata). `amountOutMinimum`
        //    is caller-supplied (`swapAmountOutMin`) — spot-price-derived
        //    fallback removed per C-01 to prevent in-block manipulation.
        uint128 wethToSwap = uint128(WETH.balanceOf(_onBehalfOf) - wethBefore);
        if (wethToSwap > 0) {
            bytes memory swapData = abi.encodeWithSelector(
                EXACT_INPUT_SINGLE_SELECTOR,
                ExactInputSingleParams({
                    tokenIn: address(WETH),
                    tokenOut: address(USDC),
                    fee: swapPoolFeeTier,
                    recipient: _onBehalfOf,
                    amountIn: uint256(wethToSwap),
                    amountOutMinimum: swapAmountOutMin,
                    sqrtPriceLimitX96: 0
                })
            );
            _safeApprove(_onBehalfOf, address(WETH), SWAP_ROUTER, uint256(wethToSwap));
            _safeExec(_onBehalfOf, SWAP_ROUTER, 0, swapData, 10);
            _safeApprove(_onBehalfOf, address(WETH), SWAP_ROUTER, 0);
        }

        uint128 currentValueUsd6 = uint128(USDC.balanceOf(_onBehalfOf) - usdcBefore);

        // 6. Performance fee: charge `performanceFeeBps` on NET PROFIT only —
        //    realized USDC above the stored basis (already prorated by exitBps
        //    at the top of the function). No fee on break-even or losses.
        //    Pulled from the Safe to the treasury module-mediated.
        uint128 feeUsd6 = 0;
        if (currentValueUsd6 > basisForExit) {
            uint256 profit = uint256(currentValueUsd6) - uint256(basisForExit);
            feeUsd6 = uint128((profit * performanceFeeBps) / 10_000);
            if (feeUsd6 > 0) {
                _safeExec(
                    _onBehalfOf,
                    address(USDC),
                    0,
                    abi.encodeCall(IERC20.transfer, (treasury, uint256(feeUsd6))),
                    11
                );
            }
        }

        emit PositionClosed(_onBehalfOf, tokenId, basisForExit, currentValueUsd6, feeUsd6, exitBps);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  collectLp
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Harvest the accrued Uniswap V3 fees of an open LP position
    ///         WITHOUT exiting it (no decreaseLiquidity, no burn). Charges
    ///         `feeCollectBps` (default 2.5%) in-kind on each collected token
    ///         to the treasury, and forwards the remainder to the Safe.
    /// @dev    PRECONDITION: the Safe MUST have enabled this contract as a
    ///         Safe module — the collect is executed module-mediated so the
    ///         Safe (NFT owner) authorizes it; fees are collected into this
    ///         contract so the protocol fee can be skimmed on-chain before
    ///         the remainder is returned. Callable by the Safe itself or the
    ///         backend operator (`registry.safeOperator()`).
    /// @param  _onBehalfOf     The Safe that owns the LP position.
    /// @param  tokenId  Uniswap V3 LP NFT id (owned by `_onBehalfOf`).
    function collectLp(address _onBehalfOf, uint256 tokenId)
        external
        nonReentrant
        onlyOperatorOrSafe(_onBehalfOf)
    {
        _collectLp(_onBehalfOf, tokenId);
    }

    /// @dev Internal collect-and-charge-fee helper. Routes the position's
    ///      `tokensOwed` through this contract so `feeCollectBps` can be
    ///      skimmed before forwarding the remainder to the Safe. Used by
    ///      `collectLp` (mid-position fee harvest) and by `closeLp` (close-
    ///      time fee harvest, BEFORE decreaseLiquidity so principal isn't
    ///      taxed).
    function _collectLp(address _onBehalfOf, uint256 tokenId) internal {
        (, , address token0, address token1, uint24 lpPoolFee, , , , , , , ) = POSITION_MANAGER.positions(tokenId);

        uint256 bal0Before = IERC20(token0).balanceOf(address(this));
        uint256 bal1Before = IERC20(token1).balanceOf(address(this));

        _collectToRecipient(_onBehalfOf, tokenId, address(this), 6);

        uint256 collected0 = IERC20(token0).balanceOf(address(this)) - bal0Before;
        uint256 collected1 = IERC20(token1).balanceOf(address(this)) - bal1Before;

        // USDC-equivalent gross value of the collected legs. token0 = WETH
        // (since WETH < USDC on Base), so collected0 is valued at the LP
        // pool's spot price; collected1 is already in USDC.
        uint128 currentValueUsd6;
        if (collected0 > 0) {
            address pool = UNISWAP_V3_FACTORY.getPool(token0, token1, lpPoolFee);
            (uint160 sqrtPriceX96, , , , , , ) = IUniswapV3Pool(pool).slot0();
            uint256 priceX192 = uint256(sqrtPriceX96) * uint256(sqrtPriceX96);
            uint256 wethValueInUsdc = Math.mulDiv(collected0, priceX192, 1 << 192);
            currentValueUsd6 = uint128(wethValueInUsdc + collected1);
        } else {
            currentValueUsd6 = uint128(collected1);
        }

        uint256 fee0 = _chargeCollectFee(token0, collected0, _onBehalfOf);
        uint256 fee1 = _chargeCollectFee(token1, collected1, _onBehalfOf);

        emit FeesCollected(_onBehalfOf, tokenId, token0, collected0, fee0, token1, collected1, fee1, currentValueUsd6);
    }

    /// @dev Module-mediated `POSITION_MANAGER.collect` for the full owed
    ///      balance, sent to `recipient`. No fee logic — pure plumbing.
    function _collectToRecipient(
        address _onBehalfOf,
        uint256 tokenId,
        address recipient,
        uint8 step
    ) internal {
        _safeExec(
            _onBehalfOf,
            address(POSITION_MANAGER),
            0,
            abi.encodeCall(
                INonfungiblePositionManager.collect,
                (INonfungiblePositionManager.CollectParams({
                    tokenId: tokenId,
                    recipient: recipient,
                    amount0Max: type(uint128).max,
                    amount1Max: type(uint128).max
                }))
            ),
            step
        );
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Owner controls
    // ─────────────────────────────────────────────────────────────────────

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert InvalidTreasury();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    function setPerformanceFeeBps(uint16 newPerformanceFeeBps) external onlyOwner {
        if (newPerformanceFeeBps > MAX_FEE_BPS) revert FeeAboveMax();
        emit PerformanceFeeBpsUpdated(performanceFeeBps, newPerformanceFeeBps);
        performanceFeeBps = newPerformanceFeeBps;
    }

    function setFeeCollectBps(uint16 newFeeCollectBps) external onlyOwner {
        if (newFeeCollectBps > MAX_FEE_BPS) revert FeeAboveMax();
        emit FeeCollectBpsUpdated(feeCollectBps, newFeeCollectBps);
        feeCollectBps = newFeeCollectBps;
    }

    /// @notice Update the ceiling on caller-supplied `slippageBps` for
    ///         `openLp` / `closeLp`. Hard-capped at `MAX_SETTABLE_SLIPPAGE_BPS`
    ///         (1000 = 10%) so even a compromised owner cannot disable
    ///         slippage protection.
    function setMaxSlippageBps(uint16 newMaxSlippageBps) external onlyOwner {
        if (newMaxSlippageBps > MAX_SETTABLE_SLIPPAGE_BPS) revert SlippageAboveMax();
        emit MaxSlippageBpsUpdated(maxSlippageBps, newMaxSlippageBps);
        maxSlippageBps = newMaxSlippageBps;
    }

    /// @notice Enable or disable a Uniswap V3 fee tier for use as either the
    ///         LP pool or the swap pool in `openLp` / `closeLp`. Constrains
    ///         routing away from thin pools that are cheap to manipulate.
    function setFeeTierAllowed(uint24 feeTier, bool allowed) external onlyOwner {
        bool previousAllowed = allowedFeeTier[feeTier];
        emit FeeTierAllowedUpdated(feeTier, previousAllowed, allowed);
        allowedFeeTier[feeTier] = allowed;
    }

    /// @notice Recover an ERC20 token accidentally sent to or stranded in
    ///         this contract (e.g. dust from rounding, direct transfers,
    ///         residue from a failed mid-position step).
    /// @dev    onlyOwner. Does NOT touch tokens on the Safe — only this
    ///         contract's own balance. Used as a transparent escape hatch:
    ///         every rescue emits `TokenRescued`.
    function rescueToken(address token, address recipient, uint256 amount) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (recipient == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(recipient, amount);
        emit TokenRescued(token, recipient, amount);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Internal helpers
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Compute the minimum acceptable output for a Uniswap V3
    ///         `exactInputSingle` swap from `tokenIn` to `tokenOut` of
    ///         `amountIn`, using the pool's spot price and the caller-supplied
    ///         slippage tolerance.
    /// @dev    Spot price is read from `slot0` and the pool fee is subtracted
    ///         from input before the price conversion so the quote accounts
    ///         for it. This catches honest misconfigurations + natural price
    ///         drift but does NOT defend against sandwich/MEV attacks.
    function _quoteSwapAmountOutMin(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint24 swapPoolFeeTier,
        uint16 slippageBps
    ) internal view returns (uint256) {
        if (slippageBps > maxSlippageBps) revert SlippageAboveMax();
        if (!allowedFeeTier[swapPoolFeeTier]) revert FeeTierNotAllowed();
        address pool = UNISWAP_V3_FACTORY.getPool(tokenIn, tokenOut, swapPoolFeeTier);
        (uint160 sqrtPriceX96, , , , , , ) = IUniswapV3Pool(pool).slot0();
        uint256 amountInAfterFee = Math.mulDiv(amountIn, 1_000_000 - uint256(swapPoolFeeTier), 1_000_000);
        uint256 priceX192 = uint256(sqrtPriceX96) * uint256(sqrtPriceX96);
        uint256 expectedOut = tokenIn < tokenOut
            ? Math.mulDiv(amountInAfterFee, priceX192, 1 << 192)
            : Math.mulDiv(amountInAfterFee, 1 << 192, priceX192);
        return (expectedOut * (10_000 - slippageBps)) / 10_000;
    }

    /// @notice Skim `feeCollectBps` of `amount` of `token` to the treasury and
    ///         forward the remainder to `_onBehalfOf`. Returns the fee charged.
    function _chargeCollectFee(address token, uint256 amount, address _onBehalfOf) internal returns (uint256 fee) {
        if (amount == 0) return 0;
        fee = (amount * feeCollectBps) / 10_000;
        if (fee > 0) IERC20(token).safeTransfer(treasury, fee);
        uint256 toSafe = amount - fee;
        if (toSafe > 0) IERC20(token).safeTransfer(_onBehalfOf, toSafe);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  openLp helpers
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Module-mediated `IERC20.approve(spender, amount)` from the Safe.
    function _safeApprove(address _onBehalfOf, address token, address spender, uint256 amount) internal {
        bytes memory approveCall = abi.encodeCall(IERC20.approve, (spender, amount));
        bool ok = ISafe(_onBehalfOf).execTransactionFromModule(
            token,
            0,
            approveCall,
            ISafe.Operation.Call
        );
        if (!ok) revert ModuleCallFailed(2);
    }

    /// @notice Generic module-mediated `target.call(value, data)` from the Safe.
    function _safeExec(address _onBehalfOf, address target, uint256 value, bytes memory data, uint8 step) internal {
        bool ok = ISafe(_onBehalfOf).execTransactionFromModule(
            target,
            value,
            data,
            ISafe.Operation.Call
        );
        if (!ok) revert ModuleCallFailed(step);
    }

    /// @notice Module-mediated NPM.mint from the Safe; decodes the return
    ///         data to surface the new tokenId + amounts consumed.
    /// @dev    `amount0Min`/`amount1Min` are caller-supplied (derive off-chain
    ///         from a quote with a tolerance buffer; pass 0 to opt out — e.g.
    ///         for one-sided ranges). `deadline` is caller-supplied and
    ///         validated at the public `openLp` entry — passed straight
    ///         through here.
    function _safeMintLp(
        address _onBehalfOf,
        uint24 lpPoolFeeTier,
        int24 tickLower,
        int24 tickUpper,
        uint256 wethDesired,
        uint256 usdcDesired,
        uint256 amount0Min,
        uint256 amount1Min,
        uint256 deadline
    ) internal returns (uint256 tokenId, uint128 amount0Used, uint128 amount1Used) {
        INonfungiblePositionManager.MintParams memory params = INonfungiblePositionManager.MintParams({
            token0: address(WETH),
            token1: address(USDC),
            fee: lpPoolFeeTier,
            tickLower: tickLower,
            tickUpper: tickUpper,
            amount0Desired: wethDesired,
            amount1Desired: usdcDesired,
            amount0Min: amount0Min,
            amount1Min: amount1Min,
            recipient: _onBehalfOf,
            deadline: deadline
        });

        bytes memory mintCall = abi.encodeCall(INonfungiblePositionManager.mint, params);
        (bool ok, bytes memory ret) = ISafe(_onBehalfOf).execTransactionFromModuleReturnData(
            address(POSITION_MANAGER),
            0,
            mintCall,
            ISafe.Operation.Call
        );
        if (!ok) revert ModuleCallFailed(4);

        uint256 amount0Out;
        uint256 amount1Out;
        (tokenId, , amount0Out, amount1Out) =
            abi.decode(ret, (uint256, uint128, uint256, uint256));
        amount0Used = uint128(amount0Out);
        amount1Used = uint128(amount1Out);
    }
}
