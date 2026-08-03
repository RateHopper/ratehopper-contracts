// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

// Minimal vendored interface for Aerodrome Slipstream's Nonfungible Position
// Manager. Only the surface AerodromeYieldHandler calls is declared.
//
// Load-bearing differences from Uniswap V3's INonfungiblePositionManager:
//   - `MintParams` carries `int24 tickSpacing` instead of `uint24 fee`, plus a
//     trailing `uint160 sqrtPriceX96` (0 when the pool already exists; non-zero
//     to create + initialize atomically).
//   - `positions(tokenId)` returns `int24 tickSpacing` where Uniswap returns
//     `uint24 fee`.
//   - `increaseLiquidity` / `decreaseLiquidity` / `collect` / `burn` are
//     identical (keyed by tokenId).
//
// Canonical implementation:
//   https://github.com/aerodrome-finance/slipstream/blob/main/contracts/periphery/NonfungiblePositionManager.sol
interface ISlipstreamNonfungiblePositionManager {
    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    struct MintParams {
        address token0;
        address token1;
        int24 tickSpacing;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
        uint160 sqrtPriceX96;
    }

    function mint(
        MintParams calldata params
    ) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);

    function positions(
        uint256 tokenId
    )
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            int24 tickSpacing,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        );

    function decreaseLiquidity(
        DecreaseLiquidityParams calldata params
    ) external payable returns (uint256 amount0, uint256 amount1);

    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);

    function burn(uint256 tokenId) external payable;

    function ownerOf(uint256 tokenId) external view returns (address);

    function safeTransferFrom(address from, address to, uint256 tokenId) external;

    function transferFrom(address from, address to, uint256 tokenId) external;
}
