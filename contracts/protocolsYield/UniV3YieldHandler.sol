// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {INonfungiblePositionManager} from "../interfaces/uniswapV3/INonfungiblePositionManager.sol";
import {IUniswapV3Factory} from "../interfaces/uniswapV3/IUniswapV3Factory.sol";
import {IUniswapV3Pool} from "../interfaces/uniswapV3/IUniswapV3Pool.sol";
import {IV3SwapRouter} from "../interfaces/uniswapV3/IV3SwapRouter.sol";
import {BaseYieldHandler} from "./BaseYieldHandler.sol";
import "../Types.sol";

/// @title UniV3YieldHandler
/// @notice Uniswap V3 adapter for SafeYieldManager. Pool params are
///         `abi.encode(uint24 feeTier)`. Stateless — executed via
///         delegatecall from the manager.
contract UniV3YieldHandler is BaseYieldHandler {
    IUniswapV3Factory public immutable UNISWAP_V3_FACTORY;

    constructor(
        address _positionManager,
        IERC20 _usdc,
        IERC20 _weth,
        address _swapRouter,
        IUniswapV3Factory _uniswapV3Factory
    ) BaseYieldHandler(YieldProtocol.UNISWAP_V3, _positionManager, _usdc, _weth, _swapRouter) {
        if (address(_uniswapV3Factory) == address(0)) revert ZeroAddress();
        UNISWAP_V3_FACTORY = _uniswapV3Factory;
    }

    function _getPool(bytes memory poolParam) internal view override returns (address) {
        uint24 feeTier = abi.decode(poolParam, (uint24));
        return UNISWAP_V3_FACTORY.getPool(address(WETH), address(USDC), feeTier);
    }

    function _poolSqrtPriceX96(address pool) internal view override returns (uint160 sqrtPriceX96) {
        (sqrtPriceX96, , , , , , ) = IUniswapV3Pool(pool).slot0();
    }

    function _buildSwapCalldata(
        address tokenIn,
        address tokenOut,
        bytes memory poolParam,
        address recipient,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 /* deadline — SwapRouter02 has no deadline field */
    ) internal pure override returns (bytes memory) {
        uint24 feeTier = abi.decode(poolParam, (uint24));
        return
            abi.encodeCall(
                IV3SwapRouter.exactInputSingle,
                (
                    IV3SwapRouter.ExactInputSingleParams({
                        tokenIn: tokenIn,
                        tokenOut: tokenOut,
                        fee: feeTier,
                        recipient: recipient,
                        amountIn: amountIn,
                        amountOutMinimum: amountOutMin,
                        sqrtPriceLimitX96: 0
                    })
                )
            );
    }

    function _buildMintCalldata(
        bytes memory lpPoolParam,
        int24 tickLower,
        int24 tickUpper,
        uint256 wethDesired,
        uint256 usdcDesired,
        uint256 amount0Min,
        uint256 amount1Min,
        address recipient,
        uint256 deadline
    ) internal view override returns (bytes memory) {
        uint24 feeTier = abi.decode(lpPoolParam, (uint24));
        return
            abi.encodeCall(
                INonfungiblePositionManager.mint,
                (
                    INonfungiblePositionManager.MintParams({
                        token0: address(WETH),
                        token1: address(USDC),
                        fee: feeTier,
                        tickLower: tickLower,
                        tickUpper: tickUpper,
                        amount0Desired: wethDesired,
                        amount1Desired: usdcDesired,
                        amount0Min: amount0Min,
                        amount1Min: amount1Min,
                        recipient: recipient,
                        deadline: deadline
                    })
                )
            );
    }

    function _position(
        uint256 tokenId
    ) internal view override returns (address token0, address token1, bytes memory lpPoolParam, uint128 liquidity) {
        uint24 feeTier;
        (, , token0, token1, feeTier, , , liquidity, , , , ) = INonfungiblePositionManager(POSITION_MANAGER).positions(
            tokenId
        );
        lpPoolParam = abi.encode(feeTier);
    }
}
