// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title ProtocolRegistry
 * @dev Contract to store mappings between tokens and their corresponding protocol-specific contracts
 * This registry allows protocol handlers to access mappings even when called via delegatecall
 *
 * Access Control:
 * - DEFAULT_ADMIN_ROLE: Can manage roles and perform routine operations (whitelist, token mappings)
 * - CRITICAL_ROLE: Can perform critical operations that should be timelocked (Paraswap, operator changes)
 */
contract ProtocolRegistry is AccessControl {
    bytes32 public constant CRITICAL_ROLE = keccak256("CRITICAL_ROLE");

    /// @notice The TimelockController address that is the only allowed caller for critical functions
    address public immutable timelock;

    /// @notice Error thrown when a critical function is called by an address other than the timelock
    error OnlyTimelock();

    constructor(
        address _wethAddress,
        address _uniswapV3Factory,
        address _initialAdmin,
        address _timelock,
        address _initialOperator,
        address _initialParaswapV6
    ) {
        if (_wethAddress == address(0)) revert ZeroAddress();
        if (_uniswapV3Factory == address(0)) revert ZeroAddress();
        if (_initialAdmin == address(0)) revert ZeroAddress();
        if (_timelock == address(0)) revert ZeroAddress();
        if (_initialOperator == address(0)) revert ZeroAddress();
        if (_initialParaswapV6 == address(0)) revert ZeroAddress();

        WETH_ADDRESS = _wethAddress;
        uniswapV3Factory = _uniswapV3Factory;
        timelock = _timelock;
        safeOperator = _initialOperator;
        paraswapV6 = _initialParaswapV6;

        // Grant roles to initial admin
        _grantRole(DEFAULT_ADMIN_ROLE, _initialAdmin);

        // Grant CRITICAL_ROLE to timelock only
        _grantRole(CRITICAL_ROLE, _timelock);
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

    // Uniswap V3 Factory address
    address public immutable uniswapV3Factory;

    /// @notice The operator address (SafeDebtManager) that can call functions via delegatecall
    address public safeOperator;

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

    function setTokenMContract(address token, address mContract) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        tokenToMContract[token] = mContract;
    }

    function getMContract(address token) external view returns (address) {
        return tokenToMContract[token];
    }

    function setTokenCContract(address token, address cContract) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        tokenToCContract[token] = cContract;
    }

    function getCContract(address token) external view returns (address) {
        return tokenToCContract[token];
    }

    function batchSetTokenMContracts(address[] calldata tokens, address[] calldata mContracts) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (tokens.length != mContracts.length) revert ArrayLengthMismatch();

        for (uint256 i = 0; i < tokens.length; i++) {
            if (tokens[i] == address(0)) revert ZeroAddress();
            if (mContracts[i] == address(0)) revert ZeroAddress();
            tokenToMContract[tokens[i]] = mContracts[i];
        }
    }

    function batchSetTokenCContracts(address[] calldata tokens, address[] calldata cContracts) external onlyRole(DEFAULT_ADMIN_ROLE) {
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
    function addToWhitelist(address token) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        require(!whitelistedTokens[token], "Token already whitelisted");

        whitelistedTokens[token] = true;
        emit TokenWhitelisted(token, msg.sender);
    }

    /**
     * @dev Remove a token from the whitelist
     * @param token The token address to remove from whitelist
     */
    function removeFromWhitelist(address token) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        require(whitelistedTokens[token], "Token not whitelisted");

        whitelistedTokens[token] = false;
        emit TokenRemovedFromWhitelist(token, msg.sender);
    }

    /**
     * @dev Add multiple tokens to the whitelist in batch
     * @param tokens Array of token addresses to whitelist
     */
    function addToWhitelistBatch(address[] calldata tokens) external onlyRole(DEFAULT_ADMIN_ROLE) {
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
    function setFluidVaultResolver(address _fluidVaultResolver) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_fluidVaultResolver == address(0)) revert ZeroAddress();
        address oldResolver = fluidVaultResolver;
        fluidVaultResolver = _fluidVaultResolver;
        emit FluidVaultResolverUpdated(oldResolver, _fluidVaultResolver);
    }

    /**
     * @dev Set the Paraswap V6 address (CRITICAL - MUST be called through TimelockController)
     * @param _paraswapV6 The new Paraswap V6 contract address
     * @notice This function can ONLY be called by the TimelockController address
     */
    function setParaswapV6(address _paraswapV6) external onlyRole(CRITICAL_ROLE) {
        if (msg.sender != timelock) revert OnlyTimelock();
        if (_paraswapV6 == address(0)) revert ZeroAddress();
        require(_paraswapV6.code.length > 0, "Not a contract");
        address oldAddress = paraswapV6;
        paraswapV6 = _paraswapV6;
        emit ParaswapV6Updated(oldAddress, _paraswapV6);
    }

    /**
     * @dev Set the operator address (CRITICAL - MUST be called through TimelockController)
     * @param _operator The new operator address
     * @notice This function can ONLY be called by the TimelockController address
     */
    function setOperator(address _operator) external onlyRole(CRITICAL_ROLE) {
        if (msg.sender != timelock) revert OnlyTimelock();
        if (_operator == address(0)) revert ZeroAddress();
        address oldOperator = safeOperator;
        safeOperator = _operator;
        emit OperatorUpdated(oldOperator, _operator);
    }
}
