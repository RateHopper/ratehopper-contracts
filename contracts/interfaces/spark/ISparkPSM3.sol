// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal surface of Spark PSM3 (sparkdotfi/spark-psm, IPSM3.sol).
///         USDC and USDS convert 1:1; sUSDS is priced by `rateProvider()`
///         (the SSR oracle) at 27 decimals. `swapExactIn` rounds the output
///         down, pulls `amountIn` from the caller, pays USDC out of `pocket()`
///         and sUSDS out of the PSM itself, and reverts
///         "PSM3/amountOut-too-low" below `minAmountOut`. The referral code is
///         emitted on the `Swap` event only.
interface ISparkPSM3 {
    function swapExactIn(
        address assetIn,
        address assetOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address receiver,
        uint256 referralCode
    ) external returns (uint256 amountOut);

    function previewSwapExactIn(
        address assetIn,
        address assetOut,
        uint256 amountIn
    ) external view returns (uint256 amountOut);

    function usdc() external view returns (address);

    function susds() external view returns (address);

    function pocket() external view returns (address);

    function rateProvider() external view returns (address);
}
