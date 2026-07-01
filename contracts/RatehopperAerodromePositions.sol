// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ISlipstreamNonfungiblePositionManager} from "./interfaces/aerodrome/ISlipstreamNonfungiblePositionManager.sol";
import {ICLFactory} from "./interfaces/aerodrome/ICLFactory.sol";
import {ICLPool} from "./interfaces/aerodrome/ICLPool.sol";
import {ISafe} from "./interfaces/safe/ISafe.sol";

import {IProtocolRegistry} from "./interfaces/IProtocolRegistry.sol";

/// @title RatehopperAerodromePositions
/// @notice Atomic Aerodrome Slipstream (CL) WETH/USDC LP lifecycle helper for
///         Gnosis Safes — a sibling of `RatehopperUniV3Positions` for Aerodrome's
///         concentrated-liquidity pools:
///           - `openLp()` splits the Safe's USDC, swaps half to WETH on the
///             pinned Slipstream SwapRouter, then mints a WETH/USDC LP NFT on
///             the Safe.
///           - `closeLp()` pulls the LP NFT, decreaseLiquidity + collect +
///             burn, swaps the WETH leg back to USDC, and forwards realized
///             USDC to the Safe.
///           - `collectLp()` harvests accrued LP fees without exiting; a
///             `feeCollectBps` cut is sent to `treasury`, remainder to Safe.
///         All swap calldata is built on-chain to prevent caller injection;
///         the caller supplies `swapAmountOutMin` for slippage protection.
///         Positions are run UNSTAKED — the NFT always stays with the Safe and
///         is never staked in a CLGauge, so this helper earns swap fees exactly
///         like the Uniswap helper (gauge staking & AERO emissions are out of
///         scope by design).
///
///         Slipstream is a Uniswap V3 fork, so this contract is a near-clone of
///         `RatehopperUniV3Positions`. The load-bearing differences are:
///           1. Pools are keyed by `int24 tickSpacing`, not `uint24 fee`
///              (`allowedTickSpacing` / `ICLFactory.getPool(t0,t1,tickSpacing)`).
///           2. `MintParams` carries `tickSpacing` + a trailing `sqrtPriceX96`;
///              `positions()` returns `tickSpacing`; `slot0` has no `feeProtocol`.
///           3. The SwapRouter `exactInputSingle` struct carries `tickSpacing`
///              and a `deadline`, so its selector is recomputed (`0xa026383e`).
///
///         WETH/USDC-ONLY by design — every NonfungiblePositionManager mint and
///         runtime token-pair check is hardcoded to the constructor-pinned
///         `WETH` and `USDC` immutables. The constructor only enforces
///         `_weth < _usdc` ordering (required by the token0/token1 convention);
///         picking the right pair is a deploy-process responsibility.
///         The raw module-mediated `IERC20.approve` in `_safeApprove` relies
///         on the deployed pair accepting non-zero→non-zero approvals — which
///         is true for canonical WETH and USDC, but NOT for USDT-style
///         two-step tokens. Deploying with such a token will surface as a
///         revert at the first `_safeApprove` call. Adding support for any
///         non-WETH/USDC token requires switching `_safeApprove` to
///         `SafeERC20.forceApprove` via the Safe module.
///
///         FEE-HARVEST CAVEAT: LP NFTs are minted to the Safe
///         (`recipient = _onBehalfOf`), NOT held by this contract. The
///         protocol's `feeCollectBps` is only applied when fees are harvested
///         through `collectLp()` / `closeLp()` (which route `tokensOwed`
///         through this contract before forwarding the remainder to the Safe).
///         A Safe owner CAN call the Slipstream `NonfungiblePositionManager.collect()`
///         directly and receive accrued fees without paying `feeCollectBps`.
///         This is by design — user funds are never at risk and no third party
///         can steal fees — but protocol fee accrual depends on harvests going
///         through `collectLp()` / `closeLp()` rather than direct NPM calls.
contract RatehopperAerodromePositions is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    /// @notice Timelocked role for fund-impacting setters. Granted to
    ///         a `TimelockController` at construction; mutations require a
    ///         scheduled call through the timelock, giving users time to
    ///         react to malicious changes. Matches the `ProtocolRegistry`
    ///         CRITICAL_ROLE convention.
    bytes32 public constant CRITICAL_ROLE = keccak256("CRITICAL_ROLE");

    /// @dev Mirror of the Slipstream SwapRouter's `ExactInputSingleParams`.
    ///      Inlined so we can build the swap calldata on-chain without trusting
    ///      any caller-supplied bytes blob. Note `tickSpacing` (not `fee`) and
    ///      the `deadline` field — the deltas vs Uniswap that change the selector.
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

    /// @notice Allow-list of acceptable Slipstream tick spacings for both the LP
    ///         pool (mint side) and the swap pool. Constrains caller / operator
    ///         routing away from thin pools where `slot0` manipulation is
    ///         cheap and slippage extraction is large. Defaults at deploy:
    ///         {100, 200} = enabled (the liquid Base WETH/USDC CL pools);
    ///         everything else = disabled. Mutable via `setTickSpacingAllowed`.
    ///         This replaces the Uniswap helper's `allowedFeeTier[uint24]` — in
    ///         Slipstream the pool is keyed by tickSpacing, and the swap fee is
    ///         decoupled / dynamic per-pool.
    mapping(int24 tickSpacing => bool) public allowedTickSpacing;

    /// @notice Per-tokenId cost basis remaining to be drawn down by future
    ///         `closeLp` calls. Set at `openLp` to the freshly-minted LP's
    ///         USDC-equivalent value (immutable to the caller); decremented
    ///         by `basis * exitBps / 10_000` on each `closeLp`, deleted on a
    ///         full close. A value of 0 means "no active position recorded
    ///         under this tokenId" (never opened via this contract OR already
    ///         fully closed). Neither a Safe owner nor a compromised operator
    ///         can lie about the perf-fee basis.
    mapping(uint256 tokenId => uint128 residualBasisUsd6) public residualBasisUsd6Of;

    /// @notice Minimum `pool.liquidity()` required for any pool this contract
    ///         reads spot price from (LP pool in `_collectLp` for fee valuation;
    ///         LP + swap pools in `openLp`/`closeLp` pre-flight). Defense in
    ///         depth on top of the
    ///         tick-spacing allow-list — protects against allow-listed pools that
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

    // Slipstream SwapRouter `exactInputSingle` selector. RECOMPUTED vs Uniswap
    // because the struct carries `int24 tickSpacing` (not `uint24 fee`) and a
    // `deadline`. Verify with:
    //   cast sig "exactInputSingle((address,address,int24,address,uint256,uint256,uint256,uint160))"
    //   = 0xa026383e
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
        // Base WETH < Base USDC as addresses; the contract pins WETH=token0
        // / USDC=token1 in `_safeMintLp` and assumes token0=WETH in
        // `_collectLp`. Assert at deploy so a wrong-chain deployment fails
        // loud rather than silently inverting valuations later.
        if (address(_weth) >= address(_usdc)) revert WrongTokenOrder();
        if (_swapRouter == address(0)) revert ZeroAddress();
        if (address(_clFactory) == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert InvalidTreasury();
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

        // Default allow-list: the liquid Base WETH/USDC CL tick spacings. The
        // deepest WETH/USDC venue is CL100; CL200 is the docs' "volatile"
        // default. Owner can flip individual spacings later via
        // `setTickSpacingAllowed`.
        allowedTickSpacing[100] = true;
        allowedTickSpacing[200] = true;

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
        emit TickSpacingAllowedUpdated(100, false, true);
        emit TickSpacingAllowedUpdated(200, false, true);
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
    ///              Slipstream SwapRouter. The swap calldata is built on-chain
    ///              so the caller cannot inject a `multicall` / `sweepToken` /
    ///              alternative recipient.
    ///           2. Mint a Slipstream WETH/USDC LP position on the Safe
    ///              with the swap-output WETH + retained USDC.
    /// @dev    PRECONDITIONS:
    ///           (a) The Safe MUST have enabled this contract as a Safe
    ///               module. Every sub-step is executed via
    ///               `Safe.execTransactionFromModule`. If this helper is not a
    ///               module, the first sub-step reverts with
    ///               `ModuleCallFailed`.
    ///           (b) The Safe MUST hold at least `usdcAmount` of USDC.
    ///           (c) The Safe MUST implement `IERC721Receiver`.
    /// @return tokenId  The newly-minted LP NFT id (owned by the Safe).
    /// @param  expectedSwapOut Off-chain (quoter-derived) expected WETH output
    ///                         for the USDC→WETH swap of `halfUsdc`. Binds
    ///                         `slippageBps` to actual swap protection:
    ///                         `swapAmountOutMin >= expectedSwapOut * (10_000 - slippageBps) / 10_000`.
    ///                         Must be > 0.
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
        _validateSwapParams(
            swapPoolTickSpacing,
            swapAmountOutMin,
            expectedSwapOut,
            slippageBps,
            lpPoolTickSpacing,
            true
        );
        _validatePool(CL_FACTORY.getPool(address(USDC), address(WETH), swapPoolTickSpacing));
        _validatePool(CL_FACTORY.getPool(address(WETH), address(USDC), lpPoolTickSpacing));

        uint256 halfUsdc = usdcAmount / 2;
        uint256 retainedUsdc = usdcAmount - halfUsdc;

        // Snapshot Safe's WETH balance so we only consume what the swap
        // produces (don't drain any pre-existing WETH the Safe held).
        uint256 wethBefore = WETH.balanceOf(_onBehalfOf);

        // 1. Swap half the USDC to WETH on the pinned Slipstream SwapRouter.
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
    /// @dev    Debt repayment happens outside this function. PRECONDITION: the
    ///         Safe MUST have enabled this contract as a Safe module. Callable
    ///         by the Safe itself or the backend operator (`registry.safeOperator()`).
    /// @param  _onBehalfOf  The Safe whose position is being closed.
    /// @param  tokenId      Slipstream LP NFT id (owned by `_onBehalfOf`).
    /// @param  swapPoolTickSpacing  Slipstream pool tick spacing used to swap the
    ///                      WETH leg back to USDC.
    /// @param  slippageBps  Slippage tolerance in bps applied to the swap's
    ///                      spot-price quote.
    /// @param  exitBps      Fraction of remaining liquidity to remove, in bps.
    ///                      `10_000` = full close (NFT is burned, residual
    ///                      basis deleted); any value in `(0, 10_000)` is a
    ///                      partial close. Must satisfy `0 < exitBps <= 10_000`.
    /// @param  minUsdcOut   Caller's final-value guard. Reverts `MinUsdcOutNotMet`
    ///                      if gross realized USDC < this. Set to 0 to disable.
    /// @param  expectedSwapOut Off-chain (quoter-derived) expected USDC output
    ///                         of the WETH→USDC unwind swap. Binds
    ///                         `slippageBps` to actual swap protection. Must be > 0.
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
        _validateSwapParams(swapPoolTickSpacing, swapAmountOutMin, expectedSwapOut, slippageBps, 0, false);
        _validatePool(CL_FACTORY.getPool(address(WETH), address(USDC), swapPoolTickSpacing));

        // Read stored basis FIRST so unknown tokenIds revert with the precise
        // `UnknownPosition` error instead of NPM's "Invalid token ID" string.
        // Zero means either never opened via this contract or already fully
        // closed. The token-pair check is therefore defense-in-depth here but
        // the ownership half still adds real value if the Safe transferred the
        // NFT out after opening.
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
        //    principal). Done on every close — partial or full.
        _collectLp(_onBehalfOf, tokenId);

        // 2. Decrease liquidity (partial or full), module-mediated. Principal
        //    moves into `tokensOwed0`/`tokensOwed1`, ready to be collected.
        //    On full close, remove exactly `liquidity` so `burn` succeeds.
        (, , , , , , , uint128 liquidity, , , , ) = POSITION_MANAGER.positions(tokenId);
        uint128 liquidityToRemove = exitBps == 10_000
            ? liquidity
            : Math.mulDiv(uint256(liquidity), uint256(exitBps), 10_000).toUint128();

        // Refuse to advance the basis decrement without removing any liquidity.
        // `Math.mulDiv` rounds down independently for the basis and liquidity
        // legs, so for dust / pathologically small `exitBps` the basis can
        // shrink while `liquidityToRemove` truncates to zero — letting a later
        // close measure profit against an artificially low basis and over-charge
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
                abi.encodeCall(ISlipstreamNonfungiblePositionManager.burn, (tokenId)),
                9
            );
        }

        // 5. Swap the WETH delta on the Safe → USDC.
        uint128 wethToSwap = (WETH.balanceOf(_onBehalfOf) - wethBefore).toUint128();
        if (wethToSwap > 0) {
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
        // caller's final-value guard on gross realized USDC.
        if (uint256(currentValueUsd6) < minUsdcOut) revert MinUsdcOutNotMet();

        // 6. Performance fee: charge `performanceFeeBps` on NET PROFIT only —
        //    realized USDC above the stored basis (already prorated by exitBps
        //    at the top of the function). No fee on break-even or losses.
        uint128 feeUsd6 = 0;
        if (currentValueUsd6 > basisForExit) {
            uint256 profit = uint256(currentValueUsd6) - uint256(basisForExit);
            feeUsd6 = ((profit * performanceFeeBps) / 10_000).toUint128();
            if (feeUsd6 > 0) {
                // non-fatal fee transfer. If the treasury address is ever
                // blacklisted (e.g. Circle USDC blacklist), users must still be
                // able to exit. Emit on failure for off-chain monitoring; zero
                // out feeUsd6 so the event reflects what actually moved.
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

    /// @notice Harvest the accrued Slipstream fees of an open LP position
    ///         WITHOUT exiting it (no decreaseLiquidity, no burn). Charges
    ///         `feeCollectBps` in-kind on each collected token to the treasury,
    ///         and forwards the remainder to the Safe.
    /// @dev    PRECONDITION: the Safe MUST have enabled this contract as a
    ///         Safe module. Callable by the Safe itself or the backend
    ///         operator (`registry.safeOperator()`).
    /// @param  _onBehalfOf     The Safe that owns the LP position.
    /// @param  tokenId  Slipstream LP NFT id (owned by `_onBehalfOf`).
    /// @param  swapWethToUsdc When true, the WETH remainder forwarded to the
    ///                      Safe by the harvest is swapped to USDC on the pinned
    ///                      Slipstream SwapRouter; the remaining swap params are
    ///                      validated and used. When false, the WETH stays on
    ///                      the Safe and the swap params are IGNORED.
    /// @param  swapPoolTickSpacing Swap pool tick spacing (only used when `swapWethToUsdc`).
    /// @param  swapAmountOutMin Min USDC out of the WETH→USDC swap (only used
    ///                      when `swapWethToUsdc`).
    /// @param  expectedSwapOut Quoter-derived expected swap output binding
    ///                      `slippageBps` (only used when `swapWethToUsdc`).
    /// @param  slippageBps  Slippage tolerance in bps (only used when `swapWethToUsdc`).
    /// @param  deadline     Staleness guard (only used when `swapWethToUsdc`).
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
        // Reject tokenIds the protocol does not manage: only positions opened
        // via `openLp` ever populate `residualBasisUsd6Of`. Without this gate
        // the Safe or `safeOperator` could route any Safe-owned WETH/USDC NPM
        // NFT through this contract and pay `feeCollectBps` on its fees.
        if (residualBasisUsd6Of[tokenId] == 0) revert UnknownPosition();
        // Defense in depth: any tokenId with a stored basis was minted by this
        // contract (so the pair is already WETH/USDC), but the Safe could have
        // transferred the NFT away afterwards — still verify ownership.
        _requireWethUsdcPositionOwnedBy(_onBehalfOf, tokenId);

        if (swapWethToUsdc) {
            // Validate swap params only on the swap path. On the no-swap path
            // these params are meaningless and intentionally left unvalidated.
            if (block.timestamp > deadline) revert DeadlineExpired();
            _validateSwapParams(swapPoolTickSpacing, swapAmountOutMin, expectedSwapOut, slippageBps, 0, false);
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

    /// @dev Internal collect-and-charge-fee helper. Routes the position's
    ///      `tokensOwed` through this contract so `feeCollectBps` can be
    ///      skimmed before forwarding the remainder to the Safe. Used by
    ///      `collectLp` (mid-position fee harvest) and by `closeLp` (close-
    ///      time fee harvest, BEFORE decreaseLiquidity so principal isn't
    ///      taxed). `tokensOwed` is expected to contain ONLY accrued fees.
    function _collectLp(address _onBehalfOf, uint256 tokenId) internal {
        (, , address token0, address token1, int24 lpTickSpacing, , , , , , , ) = POSITION_MANAGER.positions(tokenId);

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
            address pool = CL_FACTORY.getPool(token0, token1, lpTickSpacing);
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

    /// @dev Module-mediated `tokenIn → tokenOut` exact-input swap of `amountIn`
    ///      on the pinned Slipstream SwapRouter, sending the output to
    ///      `_onBehalfOf`. Swap calldata is built on-chain (selector / tokens /
    ///      recipient fixed) so the caller cannot inject an alternative route.
    ///      `approveStep` / `execStep` / `resetStep` are the `ModuleCallFailed`
    ///      codes for the three sub-calls. Shared by `openLp`, `closeLp` and
    ///      `collectLp`. Note the `deadline` field in the params struct — it is
    ///      part of the Slipstream router ABI (unlike SwapRouter02).
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

    /// @dev Shared swap-param validation for `openLp` / `closeLp` / `collectLp`.
    ///      `deadline` and each function's own guards stay inline at the call
    ///      site. Ties `slippageBps` to the swap min: forcing the caller-supplied
    ///      `swapAmountOutMin` to honor the quoter-derived floor means a tight
    ///      `slippageBps` cannot coexist with a weak `swapAmountOutMin`.
    function _validateSwapParams(
        int24 swapPoolTickSpacing,
        uint256 swapAmountOutMin,
        uint256 expectedSwapOut,
        uint16 slippageBps,
        int24 lpPoolTickSpacing,
        bool checkLpPoolTickSpacing
    ) internal view {
        if (slippageBps == 0) revert SlippageTooLow();
        if (slippageBps > maxSlippageBps) revert SlippageAboveMax();
        // openLp's LP-pool spacing, kept in its original slot (before the swap
        // spacing) so the revert order matches the inline checks.
        if (checkLpPoolTickSpacing && !allowedTickSpacing[lpPoolTickSpacing]) revert TickSpacingNotAllowed();
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

    /// @notice Update the ceiling on caller-supplied `slippageBps` for
    ///         `openLp` / `closeLp`. Hard-capped at `MAX_SETTABLE_SLIPPAGE_BPS`
    ///         (1000 = 10%) so even a compromised owner cannot disable
    ///         slippage protection.
    function setMaxSlippageBps(uint16 newMaxSlippageBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newMaxSlippageBps > MAX_SETTABLE_SLIPPAGE_BPS) revert SlippageAboveMax();
        emit MaxSlippageBpsUpdated(maxSlippageBps, newMaxSlippageBps);
        maxSlippageBps = newMaxSlippageBps;
    }

    /// @notice Enable or disable a Slipstream tick spacing for use as either the
    ///         LP pool or the swap pool in `openLp` / `closeLp`. Constrains
    ///         routing away from thin pools that are cheap to manipulate.
    function setTickSpacingAllowed(int24 tickSpacing, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        bool previousAllowed = allowedTickSpacing[tickSpacing];
        emit TickSpacingAllowedUpdated(tickSpacing, previousAllowed, allowed);
        allowedTickSpacing[tickSpacing] = allowed;
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
    ///         contract's own balance. Every rescue emits `TokenRescued`.
    function rescueToken(address token, address recipient, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        if (recipient == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(recipient, amount);
        emit TokenRescued(token, recipient, amount);
    }

    /// @notice Recover an ERC721 token accidentally sent to or stranded in
    ///         this contract (e.g. an LP NFT misdirected here instead of to
    ///         a Safe). DOES NOT touch NFTs held by a Safe — only this
    ///         contract's own ownership.
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
    ///      to fail fast before any module-mediated NPM call.
    function _requireWethUsdcPositionOwnedBy(address _onBehalfOf, uint256 tokenId) internal view {
        (, , address token0, address token1, , , , , , , , ) = POSITION_MANAGER.positions(tokenId);
        if (token0 != address(WETH) || token1 != address(USDC)) revert WrongTokenPair();
        if (POSITION_MANAGER.ownerOf(tokenId) != _onBehalfOf) revert LpNotOnSafe();
    }

    /// @notice Validate a Slipstream pool address: must exist, hold the
    ///         constructor-pinned WETH/USDC pair, be initialized, and (if
    ///         `minPoolLiquidity > 0`) hold at least that much in-range
    ///         liquidity. Returns the pool's `sqrtPriceX96` so the caller
    ///         doesn't need a second SLOAD. Note `slot0` has no `feeProtocol`
    ///         field (the Slipstream delta vs Uniswap).
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

    /// @notice Skim `feeCollectBps` of `amount` of `token` to the treasury and
    ///         forward the remainder to `_onBehalfOf`. Returns the fee actually
    ///         charged.
    /// @dev    The treasury leg is non-fatal — same shape as the perf-fee path
    ///         in `closeLp`. If the treasury hop reverts (e.g. USDC blacklist
    ///         on the configured treasury), the full `amount` is forwarded to
    ///         the Safe instead and `fee` is returned as 0 so the
    ///         `FeesCollected` event accurately reports what moved. The
    ///         `CollectFeeTransferFailed` event surfaces the failure.
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
    ///         debug surfaces the NPM/SwapRouter reason instead of an opaque
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

    /// @notice Module-mediated NPM.mint from the Safe; decodes the return data
    ///         to surface the new tokenId + amounts consumed.
    /// @dev    `amount0Min`/`amount1Min` are caller-supplied (derive off-chain
    ///         from a quote with a tolerance buffer; pass 0 to opt out — e.g.
    ///         for one-sided ranges). `sqrtPriceX96` is pinned to 0 (the LP pool
    ///         already exists — non-zero would create+init it, which is not a
    ///         supported flow here).
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
        // Enforce the minted-liquidity floor. Dust-sized positions are the
        // class of LP that can hit the partial-close desync (basis decrements
        // but `liquidityToRemove` truncates to zero).
        if (liquidityMinted < minPositionLiquidity) revert PositionLiquidityTooLow();
        amount0Used = amount0Out.toUint128();
        amount1Used = amount1Out.toUint128();
    }
}
