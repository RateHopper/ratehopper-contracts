// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../interfaces/IProtocolHandler.sol";
import "../Types.sol";

/**
 * @title MaliciousUniswapV3Pool
 * @dev A malicious contract that mimics a Uniswap V3 pool interface
 * but is not deployed by the official Uniswap V3 factory.
 * This should be detected and rejected by CallbackValidation.verifyCallback()
 */
contract MaliciousUniswapV3Pool {
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    
    // Target handler to attack
    address public targetHandler;
    
    constructor(address _token0, address _token1, uint24 _fee, address _targetHandler) {
        token0 = _token0;
        token1 = _token1;
        fee = _fee;
        targetHandler = _targetHandler;
    }
    
    /**
     * @dev Attempt to call the handler directly, mimicking a legitimate Uniswap callback
     */
    function attemptMaliciousBorrow(
        address asset,
        uint256 amount,
        address onBehalfOf
    ) external {
        // This call should fail because this contract is not deployed by the Uniswap factory
        IProtocolHandler(targetHandler).borrow(asset, amount, onBehalfOf, "0x");
    }
    
    /**
     * @dev Attempt to drain funds by calling switchFrom without proper authorization
     */
    function attemptMaliciousSwitchFrom(
        address fromAsset,
        uint256 amount,
        address onBehalfOf,
        CollateralAsset[] memory collateralAssets
    ) external {
        IProtocolHandler(targetHandler).switchFrom(fromAsset, amount, onBehalfOf, collateralAssets, "0x");
    }
    
    /**
     * @dev Attempt to manipulate supply/borrow without proper validation
     */
    function attemptMaliciousSupply(
        address asset,
        uint256 amount,
        address onBehalfOf
    ) external {
        IProtocolHandler(targetHandler).supply(asset, amount, onBehalfOf, "0x");
    }
}