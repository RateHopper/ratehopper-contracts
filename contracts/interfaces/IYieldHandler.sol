// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/// @notice One USDC<->pool-token swap leg. `poolParam` selects the pool the
///         swap routes through (same ABI-encoded shape as LP pool params, so
///         it also pins the pair being traded). A leg whose pool token IS
///         USDC needs no swap and is ignored entirely — leave its fields
///         zero/empty.
/// @dev There is deliberately no caller-supplied "expected output" here. A
///      floor that a caller certifies against its own expectation is not a
///      floor: passing 1 and 1 satisfies any ratio between them. `amountOutMin`
///      is checked against a reference TWAP the contract reads itself — see
///      TwapOracle — so this struct carries only what the contract cannot know.
struct SwapLeg {
    uint256 amountOutMin;
    bytes poolParam;
}

/// @notice Parameters for opening an LP position. Pool selection is carried
///         in `lpPoolParam` / `SwapLeg.poolParam` as ABI-encoded bytes so new
///         protocols with richer pool identifiers (e.g. Uniswap V4 `PoolKey`)
///         fit without changing this interface. The pair is part of the pool
///         identity:
///           - Uniswap V3:  abi.encode(address token0, address token1, uint24 feeTier)
///           - Aerodrome:   abi.encode(address token0, address token1, int24 tickSpacing)
///         Funding is always USDC: `usdcAmount` is split in half per side and
///         each non-USDC side is swapped through its leg's pool.
/// @dev    `stake` is an opt-in: when true the freshly-minted NFT is
///         staked into the protocol's stakePool (Aerodrome only — handlers without
///         a stakePool revert `StakingNotSupported`). closeLp auto-unstakes.
struct OpenLpParams {
    address onBehalfOf;
    uint256 usdcAmount;
    int24 tickLower;
    int24 tickUpper;
    uint256 mintAmount0Min;
    uint256 mintAmount1Min;
    /// @dev USDC -> token0 leg (ignored when token0 == USDC).
    SwapLeg swap0;
    /// @dev USDC -> token1 leg (ignored when token1 == USDC).
    SwapLeg swap1;
    uint16 slippageBps;
    uint256 deadline;
    bytes lpPoolParam;
    bool stake;
}

/// @notice Parameters for closing (partially or fully) an LP position.
///         Withdrawn non-USDC legs are swapped back to USDC.
struct CloseLpParams {
    address onBehalfOf;
    uint256 tokenId;
    uint16 exitBps;
    /// @dev token0 -> USDC leg (ignored when token0 == USDC).
    SwapLeg swap0;
    /// @dev token1 -> USDC leg (ignored when token1 == USDC).
    SwapLeg swap1;
    uint16 slippageBps;
    uint256 decreaseAmount0Min;
    uint256 decreaseAmount1Min;
    uint256 deadline;
    uint256 minUsdcOut;
}

/// @notice Parameters for the withdraw leg of an in-kind switch: a full
///         decrease + collect + burn with NO swaps — the pool tokens land on
///         the Safe as-is. A handler whose pool side is native ETH wraps that
///         side to its ERC20, so callers always receive ERC20 addresses and
///         amounts.
struct WithdrawLpParams {
    address onBehalfOf;
    uint256 tokenId;
    uint256 decreaseAmount0Min;
    uint256 decreaseAmount1Min;
    uint256 deadline;
}

/// @notice Parameters for the open leg of an in-kind switch: mint straight
///         from the token amounts the withdraw leg delivered, with NO swaps.
///         `token0/token1` are the ERC20s as withdrawn; a handler whose pool
///         side is native ETH unwraps its side itself. The handler reverts
///         `WrongTokenPair` when the provided tokens do not match the
///         destination pool's pair.
struct OpenLpInKindParams {
    address onBehalfOf;
    address token0;
    address token1;
    uint256 amount0;
    uint256 amount1;
    int24 tickLower;
    int24 tickUpper;
    uint256 mintAmount0Min;
    uint256 mintAmount1Min;
    bytes lpPoolParam;
    uint256 deadline;
}

/// @notice Parameters for harvesting accrued LP fees without exiting.
struct CollectLpParams {
    address onBehalfOf;
    uint256 tokenId;
    /// @dev Swap harvested non-USDC fees to USDC through the legs below.
    bool swapFeesToUsdc;
    SwapLeg swap0;
    SwapLeg swap1;
    /// @dev Swap the stakePool reward claimed for a STAKED position (e.g. AERO)
    ///      to USDC through `rewardSwap`. Ignored when the position is unstaked.
    bool swapRewardToUsdc;
    SwapLeg rewardSwap;
    uint16 slippageBps;
    uint256 deadline;
}

/// @title IYieldHandler
/// @notice Coarse-grained adapter interface between SafeYieldManager and a
///         yield protocol. Handlers are STATELESS logic contracts executed
///         via delegatecall from the manager: they own the full
///         open/close/collect flow for one protocol and read shared mutable
///         config exclusively from the ERC-7201 `YieldStorage` namespace.
///         Position basis bookkeeping and the performance fee stay in the
///         manager, so handlers only report values back.
interface IYieldHandler {
    /// @notice Protocol id implemented by this handler (canonical ids are
    ///         the YIELD_PROTOCOL_* constants in Types.sol).
    ///         SafeYieldManager checks this metadata before accepting a
    ///         handler registration.
    function PROTOCOL() external view returns (uint8);

    /// @notice Decode the pair carried by an LP pool param. Used by
    ///         SafeYieldManager (via staticcall, not delegatecall) to gate
    ///         openLp on the registry token whitelist. For Uniswap V4
    ///         `token0` may be address(0) — the native-ETH currency sentinel.
    function poolTokens(bytes calldata lpPoolParam) external pure returns (address token0, address token1);

    /// @return tokenId   Newly minted LP NFT id (owned by the Safe).
    /// @return basisUsd6 USDC-equivalent value of the freshly minted LP.
    /// @return used0     token0 consumed by the mint.
    /// @return used1     token1 consumed by the mint.
    function openLp(
        OpenLpParams calldata params
    ) external returns (uint256 tokenId, uint128 basisUsd6, uint128 used0, uint128 used1);

    /// @param basisForExit The manager-computed (exitBps-prorated) basis for
    ///                     this close; used only for the zero-liquidity
    ///                     rounding guard, never trusted from the caller.
    /// @return currentValueUsd6 Gross realized USDC credited to the Safe.
    function closeLp(CloseLpParams calldata params, uint128 basisForExit) external returns (uint128 currentValueUsd6);

    /// @notice In-kind close leg of a switch: full decrease + collect + burn,
    ///         NO swaps — both pool tokens land on the Safe (native ETH
    ///         wrapped to its ERC20).
    /// @return token0  ERC20 address of the withdrawn token0 side.
    /// @return token1  ERC20 address of the withdrawn token1 side.
    /// @return amount0 token0 delivered to the Safe by this withdrawal.
    /// @return amount1 token1 delivered to the Safe by this withdrawal.
    function withdrawLp(
        WithdrawLpParams calldata params
    ) external returns (address token0, address token1, uint256 amount0, uint256 amount1);

    /// @notice In-kind open leg of a switch: mint from the provided token
    ///         amounts, NO swaps. Amounts the mint cannot consume stay on the
    ///         Safe.
    /// @return tokenId Newly minted LP NFT id (owned by the Safe).
    /// @return used0   token0 consumed by the mint.
    /// @return used1   token1 consumed by the mint.
    function openLpInKind(
        OpenLpInKindParams calldata params
    ) external returns (uint256 tokenId, uint128 used0, uint128 used1);

    function collectLp(CollectLpParams calldata params) external;
}
