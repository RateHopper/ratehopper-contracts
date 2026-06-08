// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
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
///         the caller supplies `swapAmountOutMin` for slippage protection.
///         Supply/borrow on a lending protocol (e.g. Fluid) and debt repayment
///         are the user's responsibility via separate Safe transactions.
///
///         WETH/USDC-ONLY by design — every NonfungiblePositionManager mint and runtime
///         token-pair check is hardcoded to the constructor-pinned `WETH` and
///         `USDC` immutables. The constructor only enforces `_weth < _usdc`
///         ordering (required by Uniswap V3's token0/token1 convention);
///         picking the right pair is a deploy-process responsibility.
///         The raw module-mediated `IERC20.approve` in `_safeApprove` relies
///         on the deployed pair accepting non-zero→non-zero approvals — which
///         is true for canonical WETH and USDC, but NOT for USDT-style
///         two-step tokens. Deploying with such a token will surface as a
///         revert at the first `_safeApprove` call. Adding support for any
///         non-WETH/USDC token requires switching `_safeApprove` to
///         `SafeERC20.forceApprove` via the Safe module.
///
///         FEE-HARVEST CAVEAT (I-1 informational): LP NFTs are minted to the
///         Safe (`recipient = _onBehalfOf`), NOT held by this contract. The
///         protocol's `feeCollectBps` is only applied when fees are harvested
///         through `collectLp()` / `closeLp()` (which route `tokensOwed`
///         through this contract before forwarding the remainder to the Safe).
///         A Safe owner CAN call Uniswap V3 `NonfungiblePositionManager.collect()`
///         directly and receive accrued fees without paying `feeCollectBps`.
///         This is by design — user funds are never at risk and no third party
///         can steal fees — but protocol fee accrual depends on harvests going
///         through `collectLp()` / `closeLp()` rather than direct NPM calls.
contract RatehopperUniV3Positions is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    /// @notice Timelocked role for fund-impacting setters. Granted to
    ///         a `TimelockController` at construction; mutations require a
    ///         scheduled call through the timelock, giving users time to
    ///         react to malicious changes. Matches the `ProtocolRegistry`
    ///         CRITICAL_ROLE convention.
    bytes32 public constant CRITICAL_ROLE = keccak256("CRITICAL_ROLE");

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

    /// @notice The immutable `TimelockController` address. Critical setters
    ///         (`setTreasury`, `setPerformanceFeeBps`, `setFeeCollectBps`)
    ///         require `msg.sender == timelock` so a `DEFAULT_ADMIN_ROLE`
    ///         holder cannot self-grant `CRITICAL_ROLE` and bypass the delay.
    address public immutable timelock;

    address public treasury;
    uint16 public performanceFeeBps;
    uint16 public feeCollectBps;
    /// @notice Hard ceiling on the caller-supplied `slippageBps` accepted by
    ///         `openLp` / `closeLp`. Defaults to
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

    /// @notice Minimum `pool.liquidity()` required for any pool this contract
    ///         reads spot price from (LP pool in `_collectLp` for fee valuation;
    ///         LP + swap pools in `openLp`/`closeLp` pre-flight). Defense in
    ///         depth on top of the
    ///         fee-tier allow-list — protects against allow-listed pools that
    ///         drain in the future. Set at construction (`_minPoolLiquidity`);
    ///         0 disables the check. Owner-mutable via `setMinPoolLiquidity`.
    uint128 public minPoolLiquidity;

    /// @notice Floor on the `liquidity` returned by NPM `mint` inside
    ///         `_safeMintLp`. Dust-sized positions are the class of LP that
    ///         can suffer the `liquidityToRemove == 0` partial-close path
    ///         (basis decrements but principal does not move); enforcing a
    ///         floor at mint time keeps the protocol away from that regime.
    ///         Set at construction (`_minPositionLiquidity`); 0 disables the
    ///         check. Owner-mutable via `setMinPositionLiquidity`.
    uint128 public minPositionLiquidity;

    // SwapRouter02 `exactInputSingle` selector. Verify with:
    //   cast sig "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))"
    //   = 0x04e45aaf
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
    error FeeTierNotAllowed();
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
        // Base WETH < Base USDC as addresses; the contract pins WETH=token0
        // / USDC=token1 in `_safeMintLp` and assumes token0=WETH in
        // `_collectLp`. Assert at deploy so a wrong-chain deployment fails
        // loud rather than silently inverting valuations later.
        if (address(_weth) >= address(_usdc)) revert WrongTokenOrder();
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
        timelock = _timelock;
        treasury = _treasury;
        performanceFeeBps = _performanceFeeBps;
        feeCollectBps = _feeCollectBps;
        minPoolLiquidity = _minPoolLiquidity;
        minPositionLiquidity = _minPositionLiquidity;

        // Default allow-list: the three liquid Base WETH/USDC tiers. Excludes
        // 10000 deliberately — that pool is thin and is the cheap target for
        // slot0 manipulation. Owner can flip individual tiers later via
        // `setFeeTierAllowed`.
        allowedFeeTier[100] = true;
        allowedFeeTier[500] = true;
        allowedFeeTier[3000] = true;

        _grantRole(DEFAULT_ADMIN_ROLE, _initialAdmin);
        _grantRole(CRITICAL_ROLE, _timelock);
        // Make CRITICAL_ROLE self-administered so DEFAULT_ADMIN_ROLE cannot
        // grant itself CRITICAL_ROLE and bypass the timelock-only setters.
        _setRoleAdmin(CRITICAL_ROLE, CRITICAL_ROLE);

        emit TreasuryUpdated(address(0), _treasury);
        emit PerformanceFeeBpsUpdated(0, _performanceFeeBps);
        emit FeeCollectBpsUpdated(0, _feeCollectBps);
        emit MaxSlippageBpsUpdated(0, maxSlippageBps);
        emit MinPoolLiquidityUpdated(0, _minPoolLiquidity);
        emit MinPositionLiquidityUpdated(0, _minPositionLiquidity);
        emit FeeTierAllowedUpdated(100, false, true);
        emit FeeTierAllowedUpdated(500, false, true);
        emit FeeTierAllowedUpdated(3000, false, true);
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
    ///           (c) The Safe MUST implement `IERC721Receiver` (return
    ///               the `onERC721Received` selector). Standard Gnosis Safe
    ///               with `DefaultCallbackHandler` does; Safes without it
    ///               will revert during NonfungiblePositionManager's `_safeMint` with the inner
    ///               revert bubbled by.
    /// @return tokenId  The newly-minted LP NFT id (owned by the Safe).
    /// @param  expectedSwapOut Off-chain (quoter-derived) expected WETH output
    ///                         for the USDC→WETH swap of `halfUsdc`. Binds
    ///                         `slippageBps` to actual swap protection: the
    ///                         contract requires
    ///                         `swapAmountOutMin >= expectedSwapOut * (10_000 - slippageBps) / 10_000`.
    ///                         Must be > 0. NPM `mintAmount{0,1}Min` are
    ///                         independent caller-supplied guards (kept
    ///                         configurable for one-sided ranges).
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
        uint256 expectedSwapOut,
        uint16 slippageBps,
        uint256 deadline
    ) external nonReentrant onlyOperatorOrSafe(_onBehalfOf) returns (uint256 tokenId) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (usdcAmount == 0) revert InvalidUsdcAmount();
        if (slippageBps == 0) revert SlippageTooLow();
        if (slippageBps > maxSlippageBps) revert SlippageAboveMax();
        if (!allowedFeeTier[lpPoolFeeTier]) revert FeeTierNotAllowed();
        if (!allowedFeeTier[swapPoolFeeTier]) revert FeeTierNotAllowed();
        if (swapAmountOutMin == 0) revert InvalidSwapAmountOutMin();
        if (expectedSwapOut == 0) revert InvalidExpectedSwapOut();
        // Tie `slippageBps` to the swap min. Without this check `slippageBps`
        // is only an entry guard — the swap itself uses `swapAmountOutMin`
        // alone. Forcing the caller-supplied min to honor the quoter-derived
        // floor means a tight `slippageBps` cannot coexist with a weak
        // `swapAmountOutMin`.
        if (swapAmountOutMin < (expectedSwapOut * (10_000 - slippageBps)) / 10_000) {
            revert SwapMinBelowSlippageFloor();
        }
        _validatePool(UNISWAP_V3_FACTORY.getPool(address(USDC), address(WETH), swapPoolFeeTier));
        _validatePool(UNISWAP_V3_FACTORY.getPool(address(WETH), address(USDC), lpPoolFeeTier));

        uint256 halfUsdc = usdcAmount / 2;
        uint256 retainedUsdc = usdcAmount - halfUsdc;

        // Snapshot Safe's WETH balance so we only consume what the swap
        // produces (don't drain any pre-existing WETH the Safe held).
        uint256 wethBefore = WETH.balanceOf(_onBehalfOf);

        // 1. Build the swap calldata in-contract — caller controls only the
        //    fee tier, not the selector / tokens / recipient. `amountOutMinimum`
        //    is caller-supplied (`swapAmountOutMin`, derived off-chain from a
        //    quote with a tolerance buffer); spot-price-based fallback is
        //    intentionally removed to prevent in-block manipulation.
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
        _safeApprove(_onBehalfOf, address(USDC), SWAP_ROUTER, halfUsdc, 20);
        _safeExec(_onBehalfOf, SWAP_ROUTER, 0, swapData, 3);
        _safeApprove(_onBehalfOf, address(USDC), SWAP_ROUTER, 0, 21); // reset

        uint128 wethReceived = (WETH.balanceOf(_onBehalfOf) - wethBefore).toUint128();
        // post-swap zero-output guard. Even with caller-supplied
        // `swapAmountOutMin`, an exotic router path could silently succeed
        // with zero output; without WETH we'd mint a one-sided USDC LP at a
        // tick we likely intended balanced for.
        if (wethReceived == 0) revert SwapFailed();

        // 3. Approve NonfungiblePositionManager and mint the LP. NFT lands on Safe. amount0Min /
        //    amount1Min come from the caller (typically derived off-chain
        //    from a quote with a tolerance buffer); set both to 0 to opt out
        //    of slippage protection (e.g. for one-sided ranges).
        _safeApprove(_onBehalfOf, address(WETH), address(POSITION_MANAGER), uint256(wethReceived), 22);
        _safeApprove(_onBehalfOf, address(USDC), address(POSITION_MANAGER), retainedUsdc, 23);

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

        _safeApprove(_onBehalfOf, address(WETH), address(POSITION_MANAGER), 0, 24);
        _safeApprove(_onBehalfOf, address(USDC), address(POSITION_MANAGER), 0, 25);

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
            currentValueUsd6 = (wethValueInUsdc + uint256(usedUsdc)).toUint128();
        }

        // Persist the open-time basis on-chain so `closeLp` can no longer
        // accept a caller-attested value. The slot is decremented on each
        // partial close and deleted on a full close.
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
    /// @param  minUsdcOut   Caller's final-value guard. Reverts `MinUsdcOutNotMet`
    ///                      if gross realized USDC < this. Set to 0 to disable.
    ///                      Bounds the *total* swap output regardless of
    ///                      `swapAmountOutMin` (which only bounds the WETH→USDC
    ///                      swap leg in isolation)
    /// @dev    The performance-fee basis is read from `residualBasisUsd6Of`
    ///         (set at `openLp` to the freshly-minted LP's USDC-equivalent
    ///         value) and prorated by `exitBps`. Caller cannot lie about
    ///         basis. On full close the slot is deleted; on partial
    ///         close it is decremented so subsequent closes always price
    ///         against the correct residual without off-chain bookkeeping.
    /// @param  expectedSwapOut Off-chain (quoter-derived) expected USDC output
    ///                         of the WETH→USDC unwind swap. Binds
    ///                         `slippageBps` to actual swap protection: the
    ///                         contract requires
    ///                         `swapAmountOutMin >= expectedSwapOut * (10_000 - slippageBps) / 10_000`.
    ///                         Must be > 0. `decreaseAmount{0,1}Min` and
    ///                         `minUsdcOut` are independent caller-supplied
    ///                         guards (separate behavior — see their docs).
    function closeLp(
        address _onBehalfOf,
        uint256 tokenId,
        uint24 swapPoolFeeTier,
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
        if (slippageBps == 0) revert SlippageTooLow();
        if (slippageBps > maxSlippageBps) revert SlippageAboveMax();
        if (!allowedFeeTier[swapPoolFeeTier]) revert FeeTierNotAllowed();
        if (swapAmountOutMin == 0) revert InvalidSwapAmountOutMin();
        if (expectedSwapOut == 0) revert InvalidExpectedSwapOut();
        // Tie `slippageBps` to the swap min. See `openLp` for the rationale.
        if (swapAmountOutMin < (expectedSwapOut * (10_000 - slippageBps)) / 10_000) {
            revert SwapMinBelowSlippageFloor();
        }
        _validatePool(UNISWAP_V3_FACTORY.getPool(address(WETH), address(USDC), swapPoolFeeTier));

        // Read stored basis FIRST so unknown tokenIds revert with the precise
        // `UnknownPosition` error instead of NonfungiblePositionManager's "Invalid token ID" string
        // (which would happen if the token-pair check's `positions(tokenId)`
        // call ran first). Zero means either never opened via this contract
        // or already fully closed. The token-pair check is therefore
        // defense-in-depth here (any tokenId in `residualBasisUsd6Of` was
        // minted by this contract, so token0/token1 are guaranteed WETH/USDC)
        // but the ownership half still adds real value if the Safe
        // transferred the NFT out after opening.
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
            : Math.mulDiv(uint256(liquidity), uint256(exitBps), 10_000).toUint128();

        // L-4 guard: on partial close, refuse to advance the basis decrement
        // without removing any liquidity. `Math.mulDiv` rounds down
        // independently for the basis and liquidity legs, so for dust /
        // pathologically small `exitBps` the basis can shrink while
        // `liquidityToRemove` truncates to zero — letting a later close
        // measure profit against an artificially low basis and over-charge
        // `performanceFeeBps`. Reverts the basis mutation atomically.
        if (exitBps != 10_000 && basisForExit > 0 && liquidityToRemove == 0) {
            revert InvalidExitBps();
        }

        if (liquidityToRemove > 0) {
            _safeExec(
                _onBehalfOf,
                address(POSITION_MANAGER),
                0,
                abi.encodeCall(
                    INonfungiblePositionManager.decreaseLiquidity,
                    (
                        INonfungiblePositionManager.DecreaseLiquidityParams({
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

            // 3. Collect the principal directly to the Safe (no fee — capital).
            //    Also needed for `burn` to succeed (NonfungiblePositionManager requires tokensOwed == 0).
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
        //    is caller-supplied (`swapAmountOutMin`) — no spot-price-derived
        //    fallback to prevent in-block manipulation.
        uint128 wethToSwap = (WETH.balanceOf(_onBehalfOf) - wethBefore).toUint128();
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
            _safeApprove(_onBehalfOf, address(WETH), SWAP_ROUTER, uint256(wethToSwap), 26);
            _safeExec(_onBehalfOf, SWAP_ROUTER, 0, swapData, 10);
            _safeApprove(_onBehalfOf, address(WETH), SWAP_ROUTER, 0, 27);
        }

        uint128 currentValueUsd6 = (USDC.balanceOf(_onBehalfOf) - usdcBefore).toUint128();
        // caller's final-value guard on gross realized USDC.
        // Independent of `swapAmountOutMin` (which only bounds the WETH→USDC
        // swap leg) and the perf-fee rate (which can shift via setter).
        if (uint256(currentValueUsd6) < minUsdcOut) revert MinUsdcOutNotMet();

        // 6. Performance fee: charge `performanceFeeBps` on NET PROFIT only —
        //    realized USDC above the stored basis (already prorated by exitBps
        //    at the top of the function). No fee on break-even or losses.
        //    Pulled from the Safe to the treasury module-mediated.
        uint128 feeUsd6 = 0;
        if (currentValueUsd6 > basisForExit) {
            uint256 profit = uint256(currentValueUsd6) - uint256(basisForExit);
            feeUsd6 = ((profit * performanceFeeBps) / 10_000).toUint128();
            if (feeUsd6 > 0) {
                // non-fatal fee transfer. If the treasury address is
                // ever blacklisted (e.g. Circle USDC blacklist), users must
                // still be able to exit their positions. Emit on failure for
                // off-chain monitoring; zero out feeUsd6 so the event reflects
                // what actually moved.
                (bool ok, ) = ISafe(_onBehalfOf).execTransactionFromModuleReturnData(
                    address(USDC),
                    0,
                    abi.encodeCall(IERC20.transfer, (treasury, uint256(feeUsd6))),
                    ISafe.Operation.Call
                );
                if (!ok) {
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
    function collectLp(address _onBehalfOf, uint256 tokenId) external nonReentrant onlyOperatorOrSafe(_onBehalfOf) {
        // Reject tokenIds the protocol does not manage: only positions opened
        // via `openLp` ever populate `residualBasisUsd6Of`. Without this gate
        // the Safe or `safeOperator` could route any Safe-owned WETH/USDC NPM
        // NFT through this contract and pay `feeCollectBps` on its fees.
        if (residualBasisUsd6Of[tokenId] == 0) revert UnknownPosition();
        // Defense in depth: any tokenId with a stored basis was minted by this
        // contract (so the pair is already WETH/USDC), but the Safe could have
        // transferred the NFT away afterwards — still verify ownership.
        _requireWethUsdcPositionOwnedBy(_onBehalfOf, tokenId);
        _collectLp(_onBehalfOf, tokenId);
    }

    /// @dev Internal collect-and-charge-fee helper. Routes the position's
    ///      `tokensOwed` through this contract so `feeCollectBps` can be
    ///      skimmed before forwarding the remainder to the Safe. Used by
    ///      `collectLp` (mid-position fee harvest) and by `closeLp` (close-
    ///      time fee harvest, BEFORE decreaseLiquidity so principal isn't
    ///      taxed). `tokensOwed` is expected to contain ONLY accrued
    ///      fees because the protocol owns the position lifecycle — direct
    ///      external `decreaseLiquidity` on the NFT (which would move
    ///      principal into `tokensOwed`) is outside the supported flow.
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
            uint160 sqrtPriceX96 = _validatePool(pool);
            // Avoid materializing `sqrtPriceX96 * sqrtPriceX96` (would overflow
            // uint256 at extreme prices). Compute `priceX96` via mulDiv then
            // value the WETH leg with a second mulDiv.
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

    /// @dev Module-mediated `POSITION_MANAGER.collect` for the full owed
    ///      balance, sent to `recipient`. No fee logic — pure plumbing.
    function _collectToRecipient(address _onBehalfOf, uint256 tokenId, address recipient, uint8 step) internal {
        _safeExec(
            _onBehalfOf,
            address(POSITION_MANAGER),
            0,
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

    /// @notice Update the ceiling on caller-supplied `slippageBps` for
    ///         `openLp` / `closeLp`. Hard-capped at `MAX_SETTABLE_SLIPPAGE_BPS`
    ///         (1000 = 10%) so even a compromised owner cannot disable
    ///         slippage protection.
    function setMaxSlippageBps(uint16 newMaxSlippageBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newMaxSlippageBps > MAX_SETTABLE_SLIPPAGE_BPS) revert SlippageAboveMax();
        emit MaxSlippageBpsUpdated(maxSlippageBps, newMaxSlippageBps);
        maxSlippageBps = newMaxSlippageBps;
    }

    /// @notice Enable or disable a Uniswap V3 fee tier for use as either the
    ///         LP pool or the swap pool in `openLp` / `closeLp`. Constrains
    ///         routing away from thin pools that are cheap to manipulate.
    function setFeeTierAllowed(uint24 feeTier, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        bool previousAllowed = allowedFeeTier[feeTier];
        emit FeeTierAllowedUpdated(feeTier, previousAllowed, allowed);
        allowedFeeTier[feeTier] = allowed;
    }

    /// @notice Update the minimum `pool.liquidity()` floor enforced in
    ///         `_validatePool`. Set to 0 to disable the check.
    function setMinPoolLiquidity(uint128 newMinPoolLiquidity) external onlyRole(DEFAULT_ADMIN_ROLE) {
        emit MinPoolLiquidityUpdated(minPoolLiquidity, newMinPoolLiquidity);
        minPoolLiquidity = newMinPoolLiquidity;
    }

    /// @notice Update the floor on `liquidity` returned by NPM `mint` inside
    ///         `_safeMintLp`. Set to 0 to disable the check.
    function setMinPositionLiquidity(uint128 newMinPositionLiquidity) external onlyRole(DEFAULT_ADMIN_ROLE) {
        emit MinPositionLiquidityUpdated(minPositionLiquidity, newMinPositionLiquidity);
        minPositionLiquidity = newMinPositionLiquidity;
    }

    /// @notice Recover an ERC20 token accidentally sent to or stranded in
    ///         this contract (e.g. dust from rounding, direct transfers,
    ///         residue from a failed mid-position step).
    /// @dev    onlyOwner. Does NOT touch tokens on the Safe — only this
    ///         contract's own balance. Used as a transparent escape hatch:
    ///         every rescue emits `TokenRescued`.
    function rescueToken(address token, address recipient, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        if (recipient == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(recipient, amount);
        emit TokenRescued(token, recipient, amount);
    }

    /// @notice Recover an ERC721 token accidentally sent to or stranded in
    ///         this contract (e.g. an LP NFT misdirected here instead of to
    ///         a Safe). DOES NOT touch NFTs held by a Safe — only this
    ///         contract's own ownership..
    function rescueERC721(address token, uint256 tokenId, address recipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        if (recipient == address(0)) revert ZeroAddress();
        IERC721(token).safeTransferFrom(address(this), recipient, tokenId);
        emit NftRescued(token, recipient, tokenId);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Internal helpers
    // ─────────────────────────────────────────────────────────────────────

    /// @dev Assert that `tokenId` is a WETH/USDC LP position currently owned
    ///      by `_onBehalfOf`. Called at the top of `closeLp` and `collectLp`
    ///      to fail fast before any module-mediated NonfungiblePositionManager call. Without this,
    ///      an operator could route a non-WETH/USDC position through these
    ///      functions and skim `feeCollectBps` of the non-USDC leg, or
    ///      process a position the Safe doesn't actually own.
    function _requireWethUsdcPositionOwnedBy(address _onBehalfOf, uint256 tokenId) internal view {
        (, , address token0, address token1, , , , , , , , ) = POSITION_MANAGER.positions(tokenId);
        if (token0 != address(WETH) || token1 != address(USDC)) revert WrongTokenPair();
        if (POSITION_MANAGER.ownerOf(tokenId) != _onBehalfOf) revert LpNotOnSafe();
    }

    /// @notice Validate a Uniswap V3 pool address: must exist, hold the
    ///         constructor-pinned WETH/USDC pair, be initialized, and (if
    ///         `minPoolLiquidity > 0`) hold at least that much in-range
    ///         liquidity. Returns the pool's `sqrtPriceX96` so the caller
    ///         doesn't need a second SLOAD.
    /// @dev    The pair assertion (I-3) is defense-in-depth: every caller
    ///         resolves the pool via `UNISWAP_V3_FACTORY.getPool(WETH, USDC,
    ///         tier)`, which already returns the canonically-sorted WETH/USDC
    ///         pool, and `_collectLp` only forwards a position this contract
    ///         minted. Asserting `token0/token1` here keeps the spot-price
    ///         read (used to value the WETH leg) provably bound to WETH/USDC,
    ///         so a future caller cannot route valuation through an unrelated
    ///         pool.
    function _validatePool(address pool) internal view returns (uint160 sqrtPriceX96) {
        if (pool == address(0)) revert PoolDoesNotExist();
        if (IUniswapV3Pool(pool).token0() != address(WETH) || IUniswapV3Pool(pool).token1() != address(USDC)) {
            revert WrongTokenPair();
        }
        (sqrtPriceX96, , , , , , ) = IUniswapV3Pool(pool).slot0();
        if (sqrtPriceX96 == 0) revert PoolNotInitialized();
        uint128 floor = minPoolLiquidity;
        if (floor > 0 && IUniswapV3Pool(pool).liquidity() < floor) revert PoolTooThin();
    }

    /// @notice Skim `feeCollectBps` of `amount` of `token` to the treasury and
    ///         forward the remainder to `_onBehalfOf`. Returns the fee actually
    ///         charged.
    /// @dev    The treasury leg is non-fatal — same shape as the perf-fee path
    ///         in `closeLp`. If the treasury hop reverts (e.g. USDC blacklist
    ///         on the configured treasury), the full `amount` is forwarded to
    ///         the Safe instead and `fee` is returned as 0 so the
    ///         `FeesCollected` event accurately reports what moved. The
    ///         `CollectFeeTransferFailed` event surfaces the failure so
    ///         off-chain monitoring can rotate the treasury via the
    ///         timelocked admin path. Without this property, a blacklisted
    ///         treasury would brick every `closeLp` / `collectLp` with a
    ///         non-zero USDC fee leg until the timelock unlocked a setter.
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

    /// @notice Module-mediated `IERC20.approve(spender, amount)` from the Safe.
    /// @dev    Uses raw `IERC20.approve` rather than `SafeERC20.forceApprove`.
    ///         This is safe ONLY for tokens that accept non-zero→non-zero
    ///         approvals — true for canonical WETH and USDC, but NOT for
    ///         USDT-style two-step tokens. The contract is shape-locked to
    ///         the constructor-pinned `WETH` / `USDC` immutables; the deploy
    ///         process is responsible for picking canonical addresses.
    ///         Deploying with USDT or similar will revert at the first
    ///         non-zero→non-zero approve. To support such tokens, switch to
    ///         `SafeERC20.forceApprove` via the Safe module.
    function _safeApprove(address _onBehalfOf, address token, address spender, uint256 amount, uint8 step) internal {
        bytes memory approveCall = abi.encodeCall(IERC20.approve, (spender, amount));
        (bool ok, bytes memory ret) = ISafe(_onBehalfOf).execTransactionFromModuleReturnData(
            token,
            0,
            approveCall,
            ISafe.Operation.Call
        );
        if (!ok) {
            if (ret.length > 0) {
                assembly ("memory-safe") {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
            revert ModuleCallFailed(step);
        }
    }

    /// @notice Generic module-mediated `target.call(value, data)` from the Safe.
    /// @dev    Uses `execTransactionFromModuleReturnData` and bubbles
    ///         the inner revert via assembly when present, so production
    ///         debug surfaces the NonfungiblePositionManager/SwapRouter reason instead of an opaque
    ///         `ModuleCallFailed(step)`. Falls back to the typed step error
    ///         if the inner call returned no revert data.
    function _safeExec(address _onBehalfOf, address target, uint256 value, bytes memory data, uint8 step) internal {
        (bool ok, bytes memory ret) = ISafe(_onBehalfOf).execTransactionFromModuleReturnData(
            target,
            value,
            data,
            ISafe.Operation.Call
        );
        if (!ok) {
            if (ret.length > 0) {
                assembly ("memory-safe") {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
            revert ModuleCallFailed(step);
        }
    }

    /// @notice Module-mediated NonfungiblePositionManager.mint from the Safe; decodes the return
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
        uint128 liquidityMinted;
        (tokenId, liquidityMinted, amount0Out, amount1Out) = abi.decode(ret, (uint256, uint128, uint256, uint256));
        // Enforce the minted-liquidity floor. Dust-sized positions are the
        // class of LP that can hit the L-4 desync (partial close decrements
        // basis but `liquidityToRemove` truncates to zero); keeping mint above
        // a configured floor avoids that regime entirely.
        if (liquidityMinted < minPositionLiquidity) revert PositionLiquidityTooLow();
        amount0Used = amount0Out.toUint128();
        amount1Used = amount1Out.toUint128();
    }
}
