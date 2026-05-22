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

import {ISafeDebtManager} from "./interfaces/ISafeDebtManager.sol";
import {IProtocolRegistry} from "./interfaces/IProtocolRegistry.sol";

/// @title RateHopperPositions
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
contract RateHopperPositions is Ownable, ReentrancyGuard {
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
    ISafeDebtManager public immutable DEBT_MANAGER;
    IERC20 public immutable USDC;
    IERC20 public immutable WETH;
    address public immutable SWAP_ROUTER;
    IUniswapV3Factory public immutable UNISWAP_V3_FACTORY;
    uint16 public immutable MAX_FEE_BPS;

    address public treasury;
    uint16 public feeCollectBps;

    bytes4 private constant EXACT_INPUT_SINGLE_SELECTOR = 0x04e45aaf;

    event PositionOpened(
        address indexed onBehalfOf,
        uint256 indexed tokenId,
        uint256 usdcInput,
        uint128 wethToLp,
        uint128 usdcToLp
    );
    event PositionClosed(
        address indexed onBehalfOf,
        uint256 indexed tokenId,
        uint128 currentValueUsd6
    );
    event FeesCollected(
        address indexed onBehalfOf,
        uint256 indexed tokenId,
        address token0,
        uint256 collected0,
        uint256 fee0,
        address token1,
        uint256 collected1,
        uint256 fee1
    );
    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);
    event FeeCollectBpsUpdated(uint16 previousFeeCollectBps, uint16 newFeeCollectBps);

    error InvalidTreasury();
    error FeeAboveMax();
    error SwapFailed();
    error ZeroAddress();
    error InvalidUsdcAmount();
    error ModuleCallFailed(uint8 step);
    error LpNotOnSafe();
    error NotAuthorized();

    /// @notice Restricts a call to either the backend operator (the registry's
    ///         `safeOperator`) or the Safe itself. The operator drives closes
    ///         on the Safe's behalf; the Safe can always self-serve.
    /// @dev    `exit()` is invoked module-mediated (msg.sender == _onBehalfOf), so the
    ///         registry's `safeOperator` slot is free to be the backend EOA —
    ///         it is NOT this contract.
    modifier onlyOperatorOrSafe(address _onBehalfOf) {
        if (_onBehalfOf == address(0)) revert ZeroAddress();
        if (msg.sender != DEBT_MANAGER.registry().safeOperator() && msg.sender != _onBehalfOf) {
            revert NotAuthorized();
        }
        _;
    }

    constructor(
        INonfungiblePositionManager _positionManager,
        ISafeDebtManager _debtManager,
        IERC20 _usdc,
        IERC20 _weth,
        address _swapRouter,
        IUniswapV3Factory _uniswapV3Factory,
        address _treasury,
        uint16 _feeCollectBps,
        uint16 _maxFeeBps,
        address _initialOwner
    ) Ownable(_initialOwner) {
        if (address(_positionManager) == address(0)) revert ZeroAddress();
        if (address(_debtManager) == address(0)) revert ZeroAddress();
        if (address(_usdc) == address(0)) revert ZeroAddress();
        if (address(_weth) == address(0)) revert ZeroAddress();
        if (_swapRouter == address(0)) revert ZeroAddress();
        if (address(_uniswapV3Factory) == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert InvalidTreasury();
        if (_feeCollectBps > _maxFeeBps) revert FeeAboveMax();

        POSITION_MANAGER = _positionManager;
        DEBT_MANAGER = _debtManager;
        USDC = _usdc;
        WETH = _weth;
        SWAP_ROUTER = _swapRouter;
        UNISWAP_V3_FACTORY = _uniswapV3Factory;
        MAX_FEE_BPS = _maxFeeBps;
        treasury = _treasury;
        feeCollectBps = _feeCollectBps;
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
        uint24 lpPoolFee,
        uint24 swapFee,
        uint16 slippageBps
    )
        external
        nonReentrant
        onlyOperatorOrSafe(_onBehalfOf)
        returns (uint256 tokenId)
    {
        if (usdcAmount == 0) revert InvalidUsdcAmount();

        uint256 halfUsdc = usdcAmount / 2;
        uint256 retainedUsdc = usdcAmount - halfUsdc;

        // Snapshot Safe's WETH balance so we only consume what the swap
        // produces (don't drain any pre-existing WETH the Safe held).
        uint256 wethBefore = WETH.balanceOf(_onBehalfOf);

        // 1. Build the swap calldata in-contract — caller controls only the
        //    fee tier, not the selector / tokens / recipient. amountOutMinimum
        //    is computed from the pool's spot price with the caller-supplied
        //    slippageBps tolerance.
        uint256 swapAmountOutMin =
            _quoteSwapAmountOutMin(address(USDC), address(WETH), halfUsdc, swapFee, slippageBps);
        bytes memory swapData = abi.encodeWithSelector(
            EXACT_INPUT_SINGLE_SELECTOR,
            ExactInputSingleParams({
                tokenIn: address(USDC),
                tokenOut: address(WETH),
                fee: swapFee,
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
        //    amount1Min are hardcoded to 0 (no mint slippage protection;
        //    also permits one-sided tick ranges).
        _safeApprove(_onBehalfOf, address(WETH), address(POSITION_MANAGER), uint256(wethReceived));
        _safeApprove(_onBehalfOf, address(USDC), address(POSITION_MANAGER), retainedUsdc);

        uint128 usedWeth;
        uint128 usedUsdc;
        (tokenId, usedWeth, usedUsdc) = _safeMintLp(
            _onBehalfOf,
            lpPoolFee,
            tickLower,
            tickUpper,
            uint256(wethReceived),
            retainedUsdc
        );

        _safeApprove(_onBehalfOf, address(WETH), address(POSITION_MANAGER), 0);
        _safeApprove(_onBehalfOf, address(USDC), address(POSITION_MANAGER), 0);

        // 4. Final sanity: NFT must be on the Safe.
        if (POSITION_MANAGER.ownerOf(tokenId) != _onBehalfOf) revert LpNotOnSafe();

        emit PositionOpened(_onBehalfOf, tokenId, usdcAmount, usedWeth, usedUsdc);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  closeLp
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Atomic LP unwind: harvest fees → decreaseLiquidity → collect
    ///         principal → burn → swap WETH leg to USDC. The NFT stays on the
    ///         Safe throughout; every sub-step is module-mediated.
    /// @dev    Debt repayment happens outside this function (the user runs
    ///         Fluid `exit()` via a separate Safe transaction once the USDC
    ///         lands on the Safe). PRECONDITION: the Safe MUST have enabled
    ///         this contract as a Safe module. Callable by the Safe itself
    ///         or the backend operator (`registry.safeOperator()`).
    /// @param  _onBehalfOf  The Safe whose position is being closed.
    /// @param  tokenId      Uniswap V3 LP NFT id (owned by `_onBehalfOf`).
    /// @param  swapFee      Uniswap V3 pool fee tier used to swap the WETH
    ///                      leg back to USDC.
    /// @param  slippageBps  Slippage tolerance in bps applied to the swap's
    ///                      spot-price quote.
    function closeLp(
        address _onBehalfOf,
        uint256 tokenId,
        uint24 swapFee,
        uint16 slippageBps
    ) external nonReentrant onlyOperatorOrSafe(_onBehalfOf) {

        // Snapshot Safe balances so we measure only what this closeLp adds.
        uint256 wethBefore = WETH.balanceOf(_onBehalfOf);
        uint256 usdcBefore = USDC.balanceOf(_onBehalfOf);

        // 1. Harvest accrued LP fees first. Before `decreaseLiquidity`, the
        //    position's `tokensOwed` contains ONLY the accrued fees, so
        //    `_collectLp` charges `feeCollectBps` on the fees alone (not on
        //    principal).
        _collectLp(_onBehalfOf, tokenId);

        // 2. Decrease all liquidity, module-mediated. Principal moves into
        //    `tokensOwed0`/`tokensOwed1`, ready to be collected.
        (, , , , , , , uint128 liquidity, , , , ) = POSITION_MANAGER.positions(tokenId);
        if (liquidity > 0) {
            _safeExec(
                _onBehalfOf,
                address(POSITION_MANAGER),
                0,
                abi.encodeCall(
                    INonfungiblePositionManager.decreaseLiquidity,
                    (INonfungiblePositionManager.DecreaseLiquidityParams({
                        tokenId: tokenId,
                        liquidity: liquidity,
                        amount0Min: 0,
                        amount1Min: 0,
                        deadline: block.timestamp
                    }))
                ),
                7
            );
        }

        // 3. Collect the principal directly to the Safe (no fee — capital).
        //    Also needed for `burn` to succeed (NPM requires tokensOwed == 0).
        _collectToRecipient(_onBehalfOf, tokenId, _onBehalfOf, 8);

        // 4. Burn the now-empty NFT, module-mediated.
        _safeExec(
            _onBehalfOf,
            address(POSITION_MANAGER),
            0,
            abi.encodeCall(INonfungiblePositionManager.burn, (tokenId)),
            9
        );

        // 5. Swap the WETH delta on the Safe → USDC, mirroring openLp's
        //    structure (module-mediated, on-chain calldata, spot-price slippage).
        uint128 wethToSwap = uint128(WETH.balanceOf(_onBehalfOf) - wethBefore);
        if (wethToSwap > 0) {
            uint256 swapAmountOutMin =
                _quoteSwapAmountOutMin(address(WETH), address(USDC), wethToSwap, swapFee, slippageBps);
            bytes memory swapData = abi.encodeWithSelector(
                EXACT_INPUT_SINGLE_SELECTOR,
                ExactInputSingleParams({
                    tokenIn: address(WETH),
                    tokenOut: address(USDC),
                    fee: swapFee,
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
        emit PositionClosed(_onBehalfOf, tokenId, currentValueUsd6);
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
        (, , address token0, address token1, , , , , , , , ) = POSITION_MANAGER.positions(tokenId);

        uint256 bal0Before = IERC20(token0).balanceOf(address(this));
        uint256 bal1Before = IERC20(token1).balanceOf(address(this));

        _collectToRecipient(_onBehalfOf, tokenId, address(this), 6);

        uint256 collected0 = IERC20(token0).balanceOf(address(this)) - bal0Before;
        uint256 collected1 = IERC20(token1).balanceOf(address(this)) - bal1Before;

        uint256 fee0 = _chargeCollectFee(token0, collected0, _onBehalfOf);
        uint256 fee1 = _chargeCollectFee(token1, collected1, _onBehalfOf);

        emit FeesCollected(_onBehalfOf, tokenId, token0, collected0, fee0, token1, collected1, fee1);
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

    function setFeeCollectBps(uint16 newFeeCollectBps) external onlyOwner {
        if (newFeeCollectBps > MAX_FEE_BPS) revert FeeAboveMax();
        emit FeeCollectBpsUpdated(feeCollectBps, newFeeCollectBps);
        feeCollectBps = newFeeCollectBps;
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
        uint24 swapFee,
        uint16 slippageBps
    ) internal view returns (uint256) {
        address pool = UNISWAP_V3_FACTORY.getPool(tokenIn, tokenOut, swapFee);
        (uint160 sqrtPriceX96, , , , , , ) = IUniswapV3Pool(pool).slot0();
        uint256 amountInAfterFee = Math.mulDiv(amountIn, 1_000_000 - uint256(swapFee), 1_000_000);
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
    /// @dev    `amount0Min`/`amount1Min` are hardcoded to 0 (no slippage
    ///         protection on the mint, also permits one-sided tick ranges)
    ///         and `deadline` to `block.timestamp` (no staleness protection).
    function _safeMintLp(
        address _onBehalfOf,
        uint24 lpPoolFee,
        int24 tickLower,
        int24 tickUpper,
        uint256 wethDesired,
        uint256 usdcDesired
    ) internal returns (uint256 tokenId, uint128 amount0Used, uint128 amount1Used) {
        INonfungiblePositionManager.MintParams memory params = INonfungiblePositionManager.MintParams({
            token0: address(WETH),
            token1: address(USDC),
            fee: lpPoolFee,
            tickLower: tickLower,
            tickUpper: tickUpper,
            amount0Desired: wethDesired,
            amount1Desired: usdcDesired,
            amount0Min: 0,
            amount1Min: 0,
            recipient: _onBehalfOf,
            deadline: block.timestamp
        });

        bytes memory mintCall = abi.encodeCall(INonfungiblePositionManager.mint, params);
        (bool ok, bytes memory ret) = ISafe(_onBehalfOf).execTransactionFromModuleReturnData(
            address(POSITION_MANAGER),
            0,
            mintCall,
            ISafe.Operation.Call
        );
        if (!ok) revert ModuleCallFailed(4);

        uint128 liquidityOut;
        uint256 amount0Out;
        uint256 amount1Out;
        (tokenId, liquidityOut, amount0Out, amount1Out) =
            abi.decode(ret, (uint256, uint128, uint256, uint256));
        amount0Used = uint128(amount0Out);
        amount1Used = uint128(amount1Out);
    }
}
