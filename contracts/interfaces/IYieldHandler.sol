// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/// @notice Parameters for opening an LP position. Protocol-specific pool
///         selection is carried in `lpPoolParam` / `swapPoolParam` as
///         ABI-encoded bytes so new protocols with richer pool identifiers
///         (e.g. Uniswap V4 `PoolKey`) fit without changing this interface:
///           - Uniswap V3:  abi.encode(uint24 feeTier)
///           - Aerodrome:   abi.encode(int24 tickSpacing)
struct OpenLpParams {
    address onBehalfOf;
    uint256 usdcAmount;
    int24 tickLower;
    int24 tickUpper;
    uint256 mintAmount0Min;
    uint256 mintAmount1Min;
    uint256 swapAmountOutMin;
    uint256 expectedSwapOut;
    uint16 slippageBps;
    uint256 deadline;
    bytes lpPoolParam;
    bytes swapPoolParam;
}

/// @notice Parameters for closing (partially or fully) an LP position.
struct CloseLpParams {
    address onBehalfOf;
    uint256 tokenId;
    uint16 exitBps;
    uint256 swapAmountOutMin;
    uint256 expectedSwapOut;
    uint16 slippageBps;
    uint256 decreaseAmount0Min;
    uint256 decreaseAmount1Min;
    uint256 deadline;
    uint256 minUsdcOut;
    bytes swapPoolParam;
}

/// @notice Parameters for harvesting accrued LP fees without exiting.
struct CollectLpParams {
    address onBehalfOf;
    uint256 tokenId;
    bool swapWethToUsdc;
    uint256 swapAmountOutMin;
    uint256 expectedSwapOut;
    uint16 slippageBps;
    uint256 deadline;
    bytes swapPoolParam;
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

    /// @return tokenId   Newly minted LP NFT id (owned by the Safe).
    /// @return basisUsd6 USDC-equivalent value of the freshly minted LP.
    /// @return usedWeth  WETH consumed by the mint.
    /// @return usedUsdc  USDC consumed by the mint.
    function openLp(
        OpenLpParams calldata params
    ) external returns (uint256 tokenId, uint128 basisUsd6, uint128 usedWeth, uint128 usedUsdc);

    /// @param basisForExit The manager-computed (exitBps-prorated) basis for
    ///                     this close; used only for the zero-liquidity
    ///                     rounding guard, never trusted from the caller.
    /// @return currentValueUsd6 Gross realized USDC credited to the Safe.
    function closeLp(CloseLpParams calldata params, uint128 basisForExit) external returns (uint128 currentValueUsd6);

    function collectLp(CollectLpParams calldata params) external;
}
