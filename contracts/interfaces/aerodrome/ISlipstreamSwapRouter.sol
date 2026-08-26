// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

/**
 * @dev Minimal vendored interface for Aerodrome Slipstream's `SwapRouter`
 *      (the CL swap router — NOT the Aerodrome V2 AMM `IRouter`).
 *
 *      Load-bearing differences from Uniswap V3's SwapRouter02
 *      `exactInputSingle`:
 *        - `ExactInputSingleParams` carries `int24 tickSpacing` instead of
 *          `uint24 fee`.
 *        - `deadline` is present (SwapRouter02 had dropped it).
 *      Both change the function selector, which must be recomputed:
 *        bytes4(keccak256(
 *          "exactInputSingle((address,address,int24,address,uint256,uint256,uint256,uint160))"))
 *          = 0xa026383e
 *
 *      AerodromeYieldHandler builds the swap calldata on-chain from this
 *      interface via `abi.encodeCall`, so the selector is compiler-derived.
 *
 *      Canonical implementation:
 *        https://github.com/aerodrome-finance/slipstream/blob/main/contracts/periphery/SwapRouter.sol
 */
interface ISlipstreamSwapRouter {
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

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}
