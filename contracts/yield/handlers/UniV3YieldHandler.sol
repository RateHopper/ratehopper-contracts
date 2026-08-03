// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniswapV3Factory} from "../../interfaces/uniswapV3/IUniswapV3Factory.sol";
import {V3StyleYieldHandler} from "./V3StyleYieldHandler.sol";
import "../../common/Types.sol";

/// @title UniV3YieldHandler
/// @notice Uniswap V3 adapter for SafeYieldManager. Pool params are
///         `abi.encode(uint24 feeTier)`. Stateless — executed via
///         delegatecall from the manager. All hook mechanics live in
///         V3StyleYieldHandler; this contract only pins the canonical id.
contract UniV3YieldHandler is V3StyleYieldHandler {
    constructor(
        address _positionManager,
        IERC20 _usdc,
        IERC20 _weth,
        address _swapRouter,
        IUniswapV3Factory _uniswapV3Factory
    ) V3StyleYieldHandler(YIELD_PROTOCOL_UNISWAP_V3, _positionManager, _usdc, _weth, _swapRouter, _uniswapV3Factory) {}
}
