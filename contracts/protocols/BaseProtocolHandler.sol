// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "../interfaces/IProtocolHandler.sol";
import {PoolAddress} from "../dependencies/uniswapV3/PoolAddress.sol";
import "../dependencies/uniswapV3/CallbackValidation.sol";
import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "../ProtocolRegistry.sol";

/**
 * @title BaseProtocolHandler
 * @dev Base abstract contract for protocol handlers with Uniswap V3 pool validation
 * @notice This contract provides common functionality and security modifiers for all protocol handlers
 */
abstract contract BaseProtocolHandler is IProtocolHandler {

    /// @notice The Uniswap V3 factory address used for pool validation
    address public immutable uniswapV3Factory;

    /// @notice The protocol registry for accessing operator address and token mappings
    ProtocolRegistry public immutable registry;

    /**
     * @dev Modifier to ensure only authorized callers can execute protected functions
     * @param onBehalfOf The address on whose behalf the operation is being performed
     * @notice Validates that the caller is either:
     *         1. The operator from the registry (authorized to perform operations on any Safe)
     *         2. The onBehalfOf address itself (Safe calling to manage its own position)
     *         3. A Uniswap V3 pool deployed by the official factory (for flashloan callbacks)
     */
    modifier onlyAuthorizedCaller(address onBehalfOf) {
        // Get operator address from the registry
        address operatorAddress = registry.safeOperator();

        // Check if being called via delegatecall from operator or from the Safe itself
        // Case 1: Operator calls SafeDebtManager/LeveragedPosition -> delegatecall to handler
        //         msg.sender will be the operator
        // Case 2: Safe owner calls SafeDebtManager via Safe -> delegatecall to handler
        //         msg.sender will be the Safe address (onBehalfOf)
        if (msg.sender == operatorAddress || msg.sender == onBehalfOf) {
            _;
            return;
        }

        // Otherwise, verify msg.sender is a legitimate Uniswap V3 pool (for flash loan callbacks)
        IUniswapV3Pool pool = IUniswapV3Pool(msg.sender);
        PoolAddress.PoolKey memory poolKey = PoolAddress.getPoolKey(pool.token0(), pool.token1(), pool.fee());
        // require statement is defined in verifyCallback()
        CallbackValidation.verifyCallback(uniswapV3Factory, poolKey);
        _;
    }

    /**
     * @dev Constructor for base protocol handler
     * @param _uniswapV3Factory The address of the Uniswap V3 factory
     * @param _registry The address of the protocol registry
     */
    constructor(address _uniswapV3Factory, address _registry) {
        require(_uniswapV3Factory != address(0), "Invalid Uniswap V3 factory address");
        require(_registry != address(0), "Invalid registry address");
        uniswapV3Factory = _uniswapV3Factory;
        registry = ProtocolRegistry(_registry);
    }
    
    /**
     * @dev Internal function to validate collateral assets array
     * @param collateralAssets Array of collateral assets to validate
     */
    function _validateCollateralAssets(CollateralAsset[] memory collateralAssets) internal pure {
        require(collateralAssets.length > 0, "No collateral assets provided");
        require(collateralAssets.length <= 20, "Too many collateral assets");
        
        for (uint256 i = 0; i < collateralAssets.length; i++) {
            require(collateralAssets[i].asset != address(0), "Invalid collateral asset address");
            require(collateralAssets[i].amount > 0, "Invalid collateral amount");
        }
    }
} 