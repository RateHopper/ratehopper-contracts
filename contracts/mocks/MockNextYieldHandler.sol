// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniswapV3Factory} from "../interfaces/uniswapV3/IUniswapV3Factory.sol";
import {V3StyleYieldHandler} from "../protocolsYield/V3StyleYieldHandler.sol";

/// @dev Test-only "future protocol" handler: V3-shaped mechanics with the
///      protocol id supplied at construction, proving SafeYieldManager
///      accepts ids beyond the canonical YIELD_PROTOCOL_* constants without
///      a redeploy.
contract MockNextYieldHandler is V3StyleYieldHandler {
    constructor(
        uint8 _protocolId,
        address _positionManager,
        IERC20 _usdc,
        IERC20 _weth,
        address _swapRouter,
        IUniswapV3Factory _factory
    ) V3StyleYieldHandler(_protocolId, _positionManager, _usdc, _weth, _swapRouter, _factory) {}
}
