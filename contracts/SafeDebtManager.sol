// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "./dependencies/uniswapV3/CallbackValidation.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {PoolAddress} from "./dependencies/uniswapV3/PoolAddress.sol";
import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "./Types.sol";
import "./interfaces/safe/ISafe.sol";
import {IProtocolHandler} from "./interfaces/IProtocolHandler.sol";
import "./ProtocolRegistry.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/// @title SafeDebtManager
/// @notice Manages debt position switching between DeFi lending protocols for Gnosis Safe wallets
/// @dev Uses Uniswap V3 flash loans to atomically switch debt positions between protocols
/// @dev Supports Aave V3, Compound V3, Morpho, Moonwell, and Fluid protocols
contract SafeDebtManager is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    uint8 public protocolFee;
    address public feeBeneficiary;
    address public pauser;
    ProtocolRegistry public immutable registry;
    mapping(Protocol => address) public protocolHandlers;
    mapping(Protocol => bool) public protocolEnabledForSwitchFrom;
    mapping(Protocol => bool) public protocolEnabledForSwitchTo;

    error InsufficientTokenBalanceAfterSwap(uint256 expected, uint256 actual);

    struct FlashCallbackData {
        Protocol fromProtocol;
        Protocol toProtocol;
        address fromAsset;
        address toAsset;
        uint256 amount;
        CollateralAsset[] collateralAssets;
        address onBehalfOf;
        bytes fromExtraData;
        bytes toExtraData;
        ParaswapParams paraswapParams;
    }

    event DebtSwapped(
        address indexed onBehalfOf,
        Protocol fromProtocol,
        Protocol toProtocol,
        address fromAsset,
        address toAsset,
        uint256 amount,
        CollateralAsset[] collateralAssets
    );

    event DebtPositionExited(
        address indexed onBehalfOf,
        Protocol protocol,
        address debtAsset,
        uint256 debtAmount,
        CollateralAsset[] collateralAssets
    );

    event FeeBeneficiarySet(address indexed oldBeneficiary, address indexed newBeneficiary);

    event ProtocolFeeSet(uint8 oldFee, uint8 newFee);

    event ProtocolStatusChanged(Protocol indexed protocol, string operationType, bool enabled);

    event EmergencyWithdrawn(address indexed token, uint256 amount, address indexed to);

    event EmergencyETHWithdrawn(uint256 amount, address indexed to);

    event ProtocolHandlerUpdated(Protocol indexed protocol, address indexed oldHandler, address indexed newHandler);

    modifier onlyOwnerOrOperator(address onBehalfOf) {
        require(onBehalfOf != address(0), "onBehalfOf cannot be zero address");

        // Check if caller is operator (from registry) or the onBehalfOf address itself
        require(msg.sender == registry.safeOperator() || msg.sender == onBehalfOf, "Caller is not authorized");
        _;
    }

    modifier onlyPauser() {
        require(msg.sender == pauser, "Caller is not authorized to pause");
        _;
    }

    modifier onlyCriticalRole() {
        require(registry.hasRole(CRITICAL_ROLE, msg.sender), "Caller does not have CRITICAL_ROLE");
        _;
    }

    constructor(
        address _registry,
        Protocol[] memory protocols,
        address[] memory handlers,
        address _pauser
    ) Ownable(msg.sender) {
        require(protocols.length == handlers.length, "Protocols and handlers length mismatch");
        require(_registry != address(0), "Registry cannot be zero address");

        for (uint256 i = 0; i < protocols.length; i++) {
            require(handlers[i] != address(0), "Invalid handler address");
            protocolHandlers[protocols[i]] = handlers[i];
            protocolEnabledForSwitchFrom[protocols[i]] = true; // Enable switchFrom by default
            protocolEnabledForSwitchTo[protocols[i]] = true; // Enable switchTo by default
        }

        pauser = _pauser;
        registry = ProtocolRegistry(_registry);
    }

    /// @notice Sets the protocol fee charged on debt swaps
    /// @param _fee The fee in basis points (100 = 1%, max 100)
    /// @dev Only callable by the contract owner
    function setProtocolFee(uint8 _fee) public onlyOwner {
        require(_fee <= 100, "_fee cannot be greater than 1%");
        uint8 oldFee = protocolFee;
        protocolFee = _fee;
        emit ProtocolFeeSet(oldFee, _fee);
    }

    /// @notice Sets the address that receives protocol fees
    /// @param _feeBeneficiary The address to receive collected fees
    /// @dev Only callable by the contract owner. Cannot be zero address.
    function setFeeBeneficiary(address _feeBeneficiary) public onlyOwner {
        require(_feeBeneficiary != address(0), "_feeBeneficiary cannot be zero address");
        address oldBeneficiary = feeBeneficiary;
        feeBeneficiary = _feeBeneficiary;
        emit FeeBeneficiarySet(oldBeneficiary, _feeBeneficiary);
    }

    /// @notice Enables or disables a protocol as a source for debt swaps
    /// @param _protocol The protocol to enable/disable
    /// @param _enabled True to enable, false to disable
    /// @dev Only callable by the pauser. Used for emergency protocol disabling.
    function setProtocolEnabledForSwitchFrom(Protocol _protocol, bool _enabled) external onlyPauser {
        require(protocolHandlers[_protocol] != address(0), "Protocol handler not set");
        protocolEnabledForSwitchFrom[_protocol] = _enabled;
        emit ProtocolStatusChanged(_protocol, "switchFrom", _enabled);
    }

    /// @notice Enables or disables a protocol as a destination for debt swaps
    /// @param _protocol The protocol to enable/disable
    /// @param _enabled True to enable, false to disable
    /// @dev Only callable by the pauser. Used for emergency protocol disabling.
    function setProtocolEnabledForSwitchTo(Protocol _protocol, bool _enabled) external onlyPauser {
        require(protocolHandlers[_protocol] != address(0), "Protocol handler not set");
        protocolEnabledForSwitchTo[_protocol] = _enabled;
        emit ProtocolStatusChanged(_protocol, "switchTo", _enabled);
    }

    /// @notice Updates the handler address for a specific protocol
    /// @param _protocol The protocol to update the handler for
    /// @param _handler The new handler address
    /// @dev Only callable by addresses with CRITICAL_ROLE in ProtocolRegistry. For production, should be behind a timelock.
    /// @dev Allows updating handlers if a bug is found or handler needs upgrade.
    function setProtocolHandler(Protocol _protocol, address _handler) external onlyCriticalRole {
        require(_handler != address(0), "Invalid handler address");
        address oldHandler = protocolHandlers[_protocol];
        protocolHandlers[_protocol] = _handler;
        emit ProtocolHandlerUpdated(_protocol, oldHandler, _handler);
    }

    /// @notice Executes a debt swap from one protocol to another using flash loans
    /// @param _flashloanPool The Uniswap V3 pool address to use for flash loan
    /// @param _fromProtocol The source lending protocol
    /// @param _toProtocol The destination lending protocol
    /// @param _fromDebtAsset The debt token address on the source protocol
    /// @param _toDebtAsset The debt token address on the destination protocol
    /// @param _amount The amount of debt to swap (use type(uint256).max for full debt)
    /// @param _collateralAssets Array of collateral assets to migrate
    /// @param _onBehalfOf The Safe wallet address that owns the position
    /// @param _extraData Protocol-specific data [fromProtocol, toProtocol]
    /// @param _paraswapParams Swap parameters for converting between debt assets if different
    /// @dev Uses Uniswap V3 flash loan to atomically repay source debt and borrow on destination
    function executeDebtSwap(
        address _flashloanPool,
        Protocol _fromProtocol,
        Protocol _toProtocol,
        address _fromDebtAsset,
        address _toDebtAsset,
        uint256 _amount,
        CollateralAsset[] calldata _collateralAssets,
        address _onBehalfOf,
        bytes[2] calldata _extraData,
        ParaswapParams calldata _paraswapParams
    ) public nonReentrant onlyOwnerOrOperator(_onBehalfOf) whenNotPaused {
        require(_fromDebtAsset != address(0), "Invalid from asset address");
        require(_toDebtAsset != address(0), "Invalid to asset address");
        require(_amount >= 10000, "Debt amount below minimum threshold");

        // Validate protocol handlers and check if protocols are enabled
        address fromHandler = protocolHandlers[_fromProtocol];
        require(fromHandler != address(0), "Invalid from protocol handler");

        address toHandler = protocolHandlers[_toProtocol];
        require(toHandler != address(0), "Invalid to protocol handler");

        // Check if protocols are enabled for their respective operations
        require(protocolEnabledForSwitchFrom[_fromProtocol], "SwitchFrom is disabled for from protocol");
        require(protocolEnabledForSwitchTo[_toProtocol], "SwitchTo is disabled for to protocol");

        IUniswapV3Pool pool = IUniswapV3Pool(_flashloanPool);
        uint256 debtAmount = _amount;

        address token0;
        try pool.token0() returns (address result) {
            token0 = result;
        } catch {
            revert("Invalid flashloan pool address");
        }

        if (_amount == type(uint256).max) {
            debtAmount = IProtocolHandler(fromHandler).getDebtAmount(_fromDebtAsset, _onBehalfOf, _extraData[0]);
        }

        uint256 amount0 = _fromDebtAsset == token0 ? debtAmount : 0;
        uint256 amount1 = _fromDebtAsset == token0 ? 0 : debtAmount;

        bytes memory data = abi.encode(
            FlashCallbackData({
                fromProtocol: _fromProtocol,
                toProtocol: _toProtocol,
                fromAsset: _fromDebtAsset,
                toAsset: _toDebtAsset,
                amount: debtAmount,
                onBehalfOf: _onBehalfOf,
                collateralAssets: _collateralAssets,
                fromExtraData: _extraData[0],
                toExtraData: _extraData[1],
                paraswapParams: _paraswapParams
            })
        );

        pool.flash(address(this), amount0, amount1, data);
    }

    /// @notice Callback function called by Uniswap V3 pool during flash loan
    /// @param fee0 The fee for borrowing token0
    /// @param fee1 The fee for borrowing token1
    /// @param data Encoded FlashCallbackData containing swap parameters
    /// @dev This function executes the core debt swap logic. Only callable by valid Uniswap V3 pools.
    function uniswapV3FlashCallback(uint256 fee0, uint256 fee1, bytes calldata data) external whenNotPaused {
        FlashCallbackData memory decoded = abi.decode(data, (FlashCallbackData));

        // verify callback
        IUniswapV3Pool pool = IUniswapV3Pool(msg.sender);
        PoolAddress.PoolKey memory poolKey = PoolAddress.getPoolKey(pool.token0(), pool.token1(), pool.fee());
        CallbackValidation.verifyCallback(registry.uniswapV3Factory(), poolKey);

        address safe = decoded.onBehalfOf;

        // suppose either of fee0 or fee1 is 0
        uint flashloanFeeOriginal = fee0 + fee1;

        // need this flashloanFee conversion to calculate amountTotal correctly when fromAsset and toAsset have different decimals
        uint8 fromAssetDecimals = IERC20Metadata(decoded.fromAsset).decimals();
        uint8 toAssetDecimals = IERC20Metadata(decoded.toAsset).decimals();
        int256 decimalDifference = int256(uint256(fromAssetDecimals)) - int256(uint256(toAssetDecimals));
        uint flashloanFee;
        if (decimalDifference > 0) {
            // Round up: (a + b - 1) / b
            uint divisor = 10 ** uint256(decimalDifference);
            flashloanFee = (flashloanFeeOriginal + divisor - 1) / divisor;
        } else if (decimalDifference < 0) {
            flashloanFee = flashloanFeeOriginal * (10 ** uint256(-decimalDifference));
        } else {
            flashloanFee = flashloanFeeOriginal;
        }

        // Calculate protocol fee in toAsset decimals to ensure correct fee amount
        uint256 protocolFeeAmount;
        if (decoded.fromAsset == decoded.toAsset) {
            protocolFeeAmount = (decoded.amount * protocolFee) / 10000;
        } else {
            // Convert amount to toAsset decimals first
            uint256 amountInToAssetDecimals = decoded.amount;
            if (decimalDifference > 0) {
                amountInToAssetDecimals = decoded.amount / (10 ** uint256(decimalDifference));
            } else if (decimalDifference < 0) {
                amountInToAssetDecimals = decoded.amount * (10 ** uint256(-decimalDifference));
            }
            protocolFeeAmount = (amountInToAssetDecimals * protocolFee) / 10000;
        }

        uint256 amountInMax = decoded.paraswapParams.srcAmount == 0 ? decoded.amount : decoded.paraswapParams.srcAmount;
        uint256 amountTotal = amountInMax + flashloanFee + protocolFeeAmount;

        address fromHandler = protocolHandlers[decoded.fromProtocol];
        address toHandler = protocolHandlers[decoded.toProtocol];

        if (decoded.fromProtocol == decoded.toProtocol) {
            (bool success, ) = fromHandler.delegatecall(
                abi.encodeCall(
                    IProtocolHandler.switchIn,
                    (
                        decoded.fromAsset,
                        decoded.toAsset,
                        decoded.amount,
                        amountTotal,
                        safe,
                        decoded.collateralAssets,
                        decoded.fromExtraData,
                        decoded.toExtraData
                    )
                )
            );
            require(success, "protocol switchIn failed");
        } else {
            (bool successFrom, ) = fromHandler.delegatecall(
                abi.encodeCall(
                    IProtocolHandler.switchFrom,
                    (decoded.fromAsset, decoded.amount, safe, decoded.collateralAssets, decoded.fromExtraData)
                )
            );
            require(successFrom, "protocol switchFrom failed");

            (bool successTo, ) = toHandler.delegatecall(
                abi.encodeCall(
                    IProtocolHandler.switchTo,
                    (decoded.toAsset, amountTotal, safe, decoded.collateralAssets, decoded.toExtraData)
                )
            );
            require(successTo, "protocol switchTo failed");
        }

        uint256 amountToRepay = decoded.amount + flashloanFeeOriginal;

        if (decoded.fromAsset != decoded.toAsset) {
            swapByParaswap(
                decoded.toAsset,
                decoded.fromAsset,
                amountTotal,
                amountToRepay,
                decoded.paraswapParams.swapData
            );
        }

        // repay flashloan
        IERC20(decoded.fromAsset).safeTransfer(msg.sender, amountToRepay);

        if (protocolFee > 0 && feeBeneficiary != address(0)) {
            IERC20(decoded.toAsset).safeTransfer(feeBeneficiary, protocolFeeAmount);
        }

        // repay remaining amount
        IERC20 toToken = IERC20(decoded.toAsset);
        uint256 remainingBalance = toToken.balanceOf(address(this));

        if (remainingBalance > 0) {
            (bool success, ) = toHandler.delegatecall(
                abi.encodeCall(IProtocolHandler.repay, (decoded.toAsset, remainingBalance, safe, decoded.toExtraData))
            );

            require(success, "Repay remainingBalance failed");
        }

        // send dust amount back to user if it exists
        uint256 fromTokenRemainingBalance = IERC20(decoded.fromAsset).balanceOf(address(this));
        if (fromTokenRemainingBalance > 0) {
            IERC20(decoded.fromAsset).safeTransfer(decoded.onBehalfOf, fromTokenRemainingBalance);
        }

        emit DebtSwapped(
            decoded.onBehalfOf,
            decoded.fromProtocol,
            decoded.toProtocol,
            decoded.fromAsset,
            decoded.toAsset,
            decoded.amount,
            decoded.collateralAssets
        );
    }

    function swapByParaswap(
        address srcAsset,
        address dstAsset,
        uint256 amount,
        uint256 minAmountOut,
        bytes memory _txParams
    ) internal {
        require(_txParams.length >= 4, "Invalid calldata");
        
        IERC20(srcAsset).forceApprove(registry.paraswapV6(), amount);
        (bool success, ) = registry.paraswapV6().call(_txParams);
        require(success, "Token swap by paraSwap failed");

        uint256 actualBalance = IERC20(dstAsset).balanceOf(address(this));
        if (actualBalance < minAmountOut) {
            revert InsufficientTokenBalanceAfterSwap(minAmountOut, actualBalance);
        }

        //remove approval
        IERC20(srcAsset).forceApprove(registry.paraswapV6(), 0);
    }


    /**
     * @notice Exits a position by repaying debt and optionally withdrawing collateral
     * @dev Repays the debt first, then optionally withdraws the collateral assets
     * @param _protocol The protocol to exit from
     * @param _debtAsset The address of the debt asset to repay
     * @param _debtAmount The amount of debt to repay (pass type(uint256).max to use all available debt tokens in this contract)
     * @param _collateralAssets Array of collateral assets and amounts to withdraw
     * @param _onBehalfOf The address of the Safe wallet
     * @param _extraData Additional data required by the protocol handler
     * @param _withdrawCollateral Whether to withdraw collateral assets after repaying debt
     */
    function exit(
        Protocol _protocol,
        address _debtAsset,
        uint256 _debtAmount,
        CollateralAsset[] calldata _collateralAssets,
        address _onBehalfOf,
        bytes calldata _extraData,
        bool _withdrawCollateral
    ) external nonReentrant onlyOwnerOrOperator(_onBehalfOf) whenNotPaused {
        require(_debtAsset != address(0), "Invalid debt asset address");
        require(_debtAmount >= 10000, "Debt amount below minimum threshold");
        if (_withdrawCollateral) {
            require(_collateralAssets.length > 0, "Must withdraw at least one collateral asset");
        }

        address handler = protocolHandlers[_protocol];
        require(handler != address(0), "Invalid protocol handler");

        // Determine repay amount - if max, get actual debt from handler
        uint256 repayAmount = _debtAmount;
        if (_debtAmount == type(uint256).max) {
            uint256 debtAmount = IProtocolHandler(handler).getDebtAmount(_debtAsset, _onBehalfOf, _extraData);
            uint256 safeBalance = IERC20(_debtAsset).balanceOf(_onBehalfOf);
            require(safeBalance >= debtAmount, "Insufficient balance");
            repayAmount = debtAmount;
        }

        // Transfer debt tokens from Safe to this contract
        bool transferSuccess = ISafe(_onBehalfOf).execTransactionFromModule(
            _debtAsset,
            0,
            abi.encodeCall(IERC20.transfer, (address(this), repayAmount)),
            ISafe.Operation.Call
        );
        require(transferSuccess, "Transfer debt tokens to contract failed");

        // Repay debt
        (bool repaySuccess, ) = handler.delegatecall(
            abi.encodeCall(
                IProtocolHandler.repay,
                (_debtAsset, repayAmount, _onBehalfOf, _extraData)
            )
        );
        require(repaySuccess, "Repay failed");

        if (_withdrawCollateral) {
            // Withdraw collateral assets
            for (uint256 i = 0; i < _collateralAssets.length; i++) {
                require(_collateralAssets[i].asset != address(0), "Invalid collateral asset address");
                require(_collateralAssets[i].amount > 0, "Collateral amount cannot be zero");

                (bool withdrawSuccess, ) = handler.delegatecall(
                    abi.encodeCall(
                        IProtocolHandler.withdraw,
                        (_collateralAssets[i].asset, _collateralAssets[i].amount, _onBehalfOf, _extraData)
                    )
                );
                require(withdrawSuccess, "Withdraw failed");
            }

            // Transfer withdrawn collateral tokens to onBehalfOf address
            for (uint256 i = 0; i < _collateralAssets.length; i++) {
                uint256 collateralBalance = IERC20(_collateralAssets[i].asset).balanceOf(address(this));
                if (collateralBalance > 0) {
                    IERC20(_collateralAssets[i].asset).safeTransfer(_onBehalfOf, collateralBalance);
                }
            }
        }

        emit DebtPositionExited(_onBehalfOf, _protocol, _debtAsset, _debtAmount, _collateralAssets);
    }

    /// @notice Emergency function to withdraw ERC20 tokens stuck in the contract
    /// @param token The address of the token to withdraw
    /// @param amount The amount of tokens to withdraw
    /// @dev Only callable by the contract owner. Used for recovering stuck funds.
    function emergencyWithdraw(address token, uint256 amount) external onlyOwner {
        require(token != address(0), "Invalid token address");
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(amount <= balance, "Insufficient balance");
        IERC20(token).safeTransfer(owner(), amount);
        emit EmergencyWithdrawn(token, amount, owner());
    }

    /// @notice Emergency function to withdraw ETH stuck in the contract
    /// @param amount The amount of ETH to withdraw in wei
    /// @dev Only callable by the contract owner. Used for recovering ETH from protocol interactions.
    function emergencyWithdrawETH(uint256 amount) external onlyOwner {
        require(amount <= address(this).balance, "Insufficient ETH balance");
        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, "ETH transfer failed");
        emit EmergencyETHWithdrawn(amount, msg.sender);
    }

    /**
     * @notice Pauses the contract
     * @dev Only callable by the pauser
     */
    function pause() external onlyPauser {
        _pause();
    }

    /**
     * @notice Unpauses the contract
     * @dev Only callable by the pauser
     */
    function unpause() external onlyPauser {
        _unpause();
    }

    /// @notice Allows contract to receive ETH from protocol interactions
    /// @dev Required for receiving ETH from protocols like Moonwell or Fluid during withdrawals
    receive() external payable {}
}
