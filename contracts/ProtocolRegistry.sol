// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title ProtocolRegistry
 * @dev Contract to store mappings between tokens and their corresponding protocol-specific contracts
 * This registry allows protocol handlers to access mappings even when called via delegatecall
 */
contract ProtocolRegistry is Ownable {
    constructor(address _wethAddress) Ownable(msg.sender) {
        if (_wethAddress == address(0)) revert ZeroAddress();
        WETH_ADDRESS = _wethAddress;
    }

    // Mapping from underlying token address to corresponding Moonwell mToken contract address
    mapping(address => address) public tokenToMContract;

    // Mapping from underlying token address to corresponding Compound cToken contract address
    mapping(address => address) public tokenToCContract;

    // Mapping to track whitelisted tokens
    mapping(address => bool) public whitelistedTokens;

    // Fluid vault resolver address
    address public fluidVaultResolver;

    // WETH address on Base network
    address public immutable WETH_ADDRESS;

    /// @notice The operator address (SafeDebtManager) that can call functions via delegatecall
    address public operator;

    // Paraswap V6 address
    address public paraswapV6;

    error ZeroAddress();
    error ArrayLengthMismatch();

    /// @notice Event emitted when a token is added to the whitelist
    event TokenWhitelisted(address indexed token, address indexed owner);

    /// @notice Event emitted when a token is removed from the whitelist
    event TokenRemovedFromWhitelist(address indexed token, address indexed owner);

    /// @notice Event emitted when the Fluid vault resolver is updated
    event FluidVaultResolverUpdated(address indexed oldResolver, address indexed newResolver);

    /// @notice Event emitted when the operator is updated
    event OperatorUpdated(address indexed oldOperator, address indexed newOperator);

    /// @notice Event emitted when Paraswap V6 address is updated
    event ParaswapV6Updated(address indexed oldAddress, address indexed newAddress);

    function setTokenMContract(address token, address mContract) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        tokenToMContract[token] = mContract;
    }

    function getMContract(address token) external view returns (address) {
        return tokenToMContract[token];
    }

    function setTokenCContract(address token, address cContract) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        tokenToCContract[token] = cContract;
    }

    function getCContract(address token) external view returns (address) {
        return tokenToCContract[token];
    }

    function batchSetTokenMContracts(address[] calldata tokens, address[] calldata mContracts) external onlyOwner {
        if (tokens.length != mContracts.length) revert ArrayLengthMismatch();

        for (uint256 i = 0; i < tokens.length; i++) {
            if (tokens[i] == address(0)) revert ZeroAddress();
            if (mContracts[i] == address(0)) revert ZeroAddress();
            tokenToMContract[tokens[i]] = mContracts[i];
        }
    }

    function batchSetTokenCContracts(address[] calldata tokens, address[] calldata cContracts) external onlyOwner {
        if (tokens.length != cContracts.length) revert ArrayLengthMismatch();

        for (uint256 i = 0; i < tokens.length; i++) {
            if (tokens[i] == address(0)) revert ZeroAddress();
            if (cContracts[i] == address(0)) revert ZeroAddress();
            tokenToCContract[tokens[i]] = cContracts[i];
        }
    }

    /**
     * @dev Add a token to the whitelist
     * @param token The token address to whitelist
     */
    function addToWhitelist(address token) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        require(!whitelistedTokens[token], "Token already whitelisted");
        
        whitelistedTokens[token] = true;
        emit TokenWhitelisted(token, msg.sender);
    }

    /**
     * @dev Remove a token from the whitelist
     * @param token The token address to remove from whitelist
     */
    function removeFromWhitelist(address token) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        require(whitelistedTokens[token], "Token not whitelisted");
        
        whitelistedTokens[token] = false;
        emit TokenRemovedFromWhitelist(token, msg.sender);
    }

    /**
     * @dev Add multiple tokens to the whitelist in batch
     * @param tokens Array of token addresses to whitelist
     */
    function addToWhitelistBatch(address[] calldata tokens) external onlyOwner {
        require(tokens.length > 0, "Empty tokens array");
        require(tokens.length <= 100, "Too many tokens in batch");
        
        for (uint256 i = 0; i < tokens.length; i++) {
            address token = tokens[i];
            if (token == address(0)) revert ZeroAddress();
            
            if (!whitelistedTokens[token]) {
                whitelistedTokens[token] = true;
                emit TokenWhitelisted(token, msg.sender);
            }
        }
    }

    /**
     * @dev Check if a token is whitelisted
     * @param token The token address to check
     * @return bool True if token is whitelisted, false otherwise
     */
    function isWhitelisted(address token) external view returns (bool) {
        return whitelistedTokens[token];
    }

    /**
     * @dev Set the Fluid vault resolver address
     * @param _fluidVaultResolver The new Fluid vault resolver address
     */
    function setFluidVaultResolver(address _fluidVaultResolver) external onlyOwner {
        if (_fluidVaultResolver == address(0)) revert ZeroAddress();
        address oldResolver = fluidVaultResolver;
        fluidVaultResolver = _fluidVaultResolver;
        emit FluidVaultResolverUpdated(oldResolver, _fluidVaultResolver);
    }

    /**
     * @dev Set the Paraswap V6 address
     * @param _paraswapV6 The Paraswap V6 contract address
     */
    function setParaswapV6(address _paraswapV6) external onlyOwner {
        if (_paraswapV6 == address(0)) revert ZeroAddress();
        address oldAddress = paraswapV6;
        paraswapV6 = _paraswapV6;
        emit ParaswapV6Updated(oldAddress, _paraswapV6);
    }
}
