// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISlipstreamNonfungiblePositionManager} from "../../interfaces/aerodrome/ISlipstreamNonfungiblePositionManager.sol";
import {ICLFactory} from "../../interfaces/aerodrome/ICLFactory.sol";
import {ICLPool} from "../../interfaces/aerodrome/ICLPool.sol";
import {ISlipstreamSwapRouter} from "../../interfaces/aerodrome/ISlipstreamSwapRouter.sol";
import {BaseYieldHandler} from "./BaseYieldHandler.sol";
import "../../common/Types.sol";

/// @title AerodromeYieldHandler
/// @notice Aerodrome Slipstream adapter for SafeYieldManager. Pool params
///         are `abi.encode(int24 tickSpacing)`. Stateless — executed via
///         delegatecall from the manager.
contract AerodromeYieldHandler is BaseYieldHandler {
    ICLFactory public immutable CL_FACTORY;

    constructor(
        address _positionManager,
        IERC20 _usdc,
        IERC20 _weth,
        address _swapRouter,
        ICLFactory _clFactory
    ) BaseYieldHandler(YIELD_PROTOCOL_AERODROME, _positionManager, _usdc, _weth, _swapRouter) {
        if (address(_clFactory) == address(0)) revert ZeroAddress();
        CL_FACTORY = _clFactory;
    }

    function _getPool(bytes memory poolParam) internal view override returns (address) {
        int24 tickSpacing = abi.decode(poolParam, (int24));
        return CL_FACTORY.getPool(address(WETH), address(USDC), tickSpacing);
    }

    function _poolSqrtPriceX96(address pool) internal view override returns (uint160 sqrtPriceX96) {
        (sqrtPriceX96, , , , , ) = ICLPool(pool).slot0();
    }

    function _buildSwapCalldata(
        address tokenIn,
        address tokenOut,
        bytes memory poolParam,
        address recipient,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 deadline
    ) internal pure override returns (bytes memory) {
        int24 tickSpacing = abi.decode(poolParam, (int24));
        return
            abi.encodeCall(
                ISlipstreamSwapRouter.exactInputSingle,
                (
                    ISlipstreamSwapRouter.ExactInputSingleParams({
                        tokenIn: tokenIn,
                        tokenOut: tokenOut,
                        tickSpacing: tickSpacing,
                        recipient: recipient,
                        deadline: deadline,
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
        int24 tickSpacing = abi.decode(lpPoolParam, (int24));
        return
            abi.encodeCall(
                ISlipstreamNonfungiblePositionManager.mint,
                (
                    ISlipstreamNonfungiblePositionManager.MintParams({
                        token0: address(WETH),
                        token1: address(USDC),
                        tickSpacing: tickSpacing,
                        tickLower: tickLower,
                        tickUpper: tickUpper,
                        amount0Desired: wethDesired,
                        amount1Desired: usdcDesired,
                        amount0Min: amount0Min,
                        amount1Min: amount1Min,
                        recipient: recipient,
                        deadline: deadline,
                        sqrtPriceX96: 0
                    })
                )
            );
    }

    function _position(
        uint256 tokenId
    ) internal view override returns (address token0, address token1, bytes memory lpPoolParam, uint128 liquidity) {
        int24 tickSpacing;
        (, , token0, token1, tickSpacing, , , liquidity, , , , ) = ISlipstreamNonfungiblePositionManager(
            POSITION_MANAGER
        ).positions(tokenId);
        lpPoolParam = abi.encode(tickSpacing);
    }
}
