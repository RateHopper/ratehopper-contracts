// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/// @notice One USDC<->pool-token swap leg. `poolParam` selects the pool the
///         swap routes through (same ABI-encoded shape as LP pool params, so
///         it also pins the pair being traded). A leg whose pool token IS
///         USDC needs no swap and is ignored entirely — leave its fields
///         zero/empty.
struct SwapLeg {
    uint256 amountOutMin;
    uint256 expectedOut;
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

    function collectLp(CollectLpParams calldata params) external;
}
