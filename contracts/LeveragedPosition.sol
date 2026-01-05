// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "./dependencies/uniswapV3/CallbackValidation.sol";
import {PoolAddress} from "./dependencies/uniswapV3/PoolAddress.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import {IProtocolHandler} from "./interfaces/IProtocolHandler.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./Types.sol";
import "./interfaces/safe/ISafe.sol";
import "./ProtocolRegistry.sol";

/// @title LeveragedPosition
/// @notice Creates and manages leveraged positions on DeFi lending protocols
/// @dev Uses Uniswap V3 flash loans to atomically create/close leveraged positions
/// @dev Supports Aave V3, Compound V3, Morpho, Moonwell, and Fluid protocols
contract LeveragedPosition is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    uint8 public protocolFee;
    address public feeBeneficiary;
    ProtocolRegistry public immutable registry;
    mapping(Protocol => address) public protocolHandlers;
    address public pauser;

    error InsufficientTokenBalanceAfterSwap(uint256 expected, uint256 actual);
    error InvalidOperationType(uint8 operationType);

    enum OperationType { Create, Close }

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

    struct CreateCallbackData {
        address flashloanPool;
        Protocol protocol;
        address collateralAsset;
        address debtAsset;
        uint256 principleCollateralAmount;
        uint256 targetCollateralAmount;
        address onBehalfOf;
        bytes extraData;
        ParaswapParams paraswapParams;
    }

    struct CloseCallbackData {
        address flashloanPool;
        Protocol protocol;
        address collateralAsset;
        address debtAsset;
        uint256 debtAmount;
        uint256 collateralAmount;
        address onBehalfOf;
        bytes extraData;
        ParaswapParams paraswapParams;
    }

    event LeveragedPositionCreated(
        address indexed onBehalfOf,
        Protocol protocol,
        address collateralAsset,
        uint256 principleCollateralAmount,
        uint256 targetCollateralAmount,
        address debtAsset
    );

    event LeveragedPositionClosed(
        address indexed onBehalfOf,
        Protocol protocol,
        address collateralAsset,
        uint256 collateralAmount,
        address debtAsset,
        uint256 debtAmount,
        uint256 collateralReturned
    );

    event FeeBeneficiarySet(address indexed oldBeneficiary, address indexed newBeneficiary);

    event ProtocolFeeSet(uint8 oldFee, uint8 newFee);

    event EmergencyWithdrawn(address indexed token, uint256 amount, address indexed to);

    event EmergencyETHWithdrawn(uint256 amount, address indexed to);

    event ProtocolHandlerUpdated(Protocol indexed protocol, address indexed oldHandler, address indexed newHandler);

    constructor(address _registry, Protocol[] memory protocols, address[] memory handlers, address _pauser) Ownable(msg.sender) {
        require(protocols.length == handlers.length, "Protocols and handlers length mismatch");
        require(_registry != address(0), "Registry cannot be zero address");
        require(_pauser != address(0), "Pauser cannot be zero address");
        registry = ProtocolRegistry(_registry);

        for (uint256 i = 0; i < protocols.length; i++) {
            require(handlers[i] != address(0), "Invalid handler address");
            protocolHandlers[protocols[i]] = handlers[i];
        }

        pauser = _pauser;
    }

    /// @notice Sets the protocol fee charged on leveraged positions
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

    /// @notice Creates a leveraged position using flash loans
    /// @param _flashloanPool The Uniswap V3 pool address to use for flash loan
    /// @param _protocol The lending protocol to use (Aave, Compound, Morpho, etc.)
    /// @param _collateralAsset The collateral token address
    /// @param _principleCollateralAmount User's initial collateral amount
    /// @param _targetCollateralAmount Target total collateral (principle + borrowed)
    /// @param _debtAsset The debt token address to borrow
    /// @param _onBehalfOf The address that will own the position
    /// @param _extraData Protocol-specific data (e.g., market params for Morpho)
    /// @param _paraswapParams Swap parameters for converting debt to collateral
    /// @dev Flash loans collateral difference, supplies to protocol, borrows debt, swaps back to repay flash loan
    function createLeveragedPosition(
        address _flashloanPool,
        Protocol _protocol,
        address _collateralAsset,
        uint256 _principleCollateralAmount,
        uint256 _targetCollateralAmount,
        address _debtAsset,
        address _onBehalfOf,
        bytes calldata _extraData,
        ParaswapParams calldata _paraswapParams
    ) public nonReentrant whenNotPaused onlyOwnerOrOperator(_onBehalfOf) {
        require(_collateralAsset != address(0), "Invalid collateral asset address");
        require(_debtAsset != address(0), "Invalid debt asset address");

        IERC20(_collateralAsset).transferFrom(_onBehalfOf, address(this), _principleCollateralAmount);

        IUniswapV3Pool pool = IUniswapV3Pool(_flashloanPool);

        uint256 flashloanBorrowAmount = _targetCollateralAmount - _principleCollateralAmount;

        address token0;
        try pool.token0() returns (address result) {
            token0 = result;
        } catch {
            revert("Invalid flashloan pool address");
        }

        uint256 amount0 = _collateralAsset == token0 ? flashloanBorrowAmount : 0;
        uint256 amount1 = _collateralAsset == token0 ? 0 : flashloanBorrowAmount;

        bytes memory data = abi.encode(
            OperationType.Create,
            CreateCallbackData({
                flashloanPool: _flashloanPool,
                protocol: _protocol,
                collateralAsset: _collateralAsset,
                debtAsset: _debtAsset,
                principleCollateralAmount: _principleCollateralAmount,
                targetCollateralAmount: _targetCollateralAmount,
                onBehalfOf: _onBehalfOf,
                extraData: _extraData,
                paraswapParams: _paraswapParams
            })
        );

        pool.flash(address(this), amount0, amount1, data);
    }

    /// @notice Closes or reduces a leveraged position using flash loans
    /// @param _flashloanPool The Uniswap V3 pool address to use for flash loan
    /// @param _protocol The lending protocol where the position exists
    /// @param _collateralAsset The collateral token address
    /// @param _collateralAmount The amount of collateral to withdraw
    /// @param _debtAsset The debt token address
    /// @param _debtAmount The amount of debt to repay
    /// @param _onBehalfOf The address that owns the position
    /// @param _extraData Protocol-specific data (e.g., market params for Morpho)
    /// @param _paraswapParams Swap parameters for converting collateral to debt
    /// @dev Flash loans debt amount, repays debt, withdraws collateral, swaps to repay flash loan
    function deleveragePosition(
        address _flashloanPool,
        Protocol _protocol,
        address _collateralAsset,
        uint256 _collateralAmount,
        address _debtAsset,
        uint256 _debtAmount,
        address _onBehalfOf,
        bytes calldata _extraData,
        ParaswapParams calldata _paraswapParams
    ) public nonReentrant whenNotPaused onlyOwnerOrOperator(_onBehalfOf) {
        require(_collateralAsset != address(0), "Invalid collateral asset address");
        require(_debtAsset != address(0), "Invalid debt asset address");
        require(_collateralAmount > 0, "Invalid collateral amount");
        require(_debtAmount >= 10000, "Debt amount below minimum threshold");

        address handler = protocolHandlers[_protocol];
        require(handler != address(0), "Invalid protocol handler");

        IUniswapV3Pool pool = IUniswapV3Pool(_flashloanPool);

        address token0;
        try pool.token0() returns (address result) {
            token0 = result;
        } catch {
            revert("Invalid flashloan pool address");
        }

        // Flash loan the debt amount to repay the debt
        uint256 amount0 = _debtAsset == token0 ? _debtAmount : 0;
        uint256 amount1 = _debtAsset == token0 ? 0 : _debtAmount;

        bytes memory data = abi.encode(
            OperationType.Close,
            CloseCallbackData({
                flashloanPool: _flashloanPool,
                protocol: _protocol,
                collateralAsset: _collateralAsset,
                debtAsset: _debtAsset,
                debtAmount: _debtAmount,
                collateralAmount: _collateralAmount,
                onBehalfOf: _onBehalfOf,
                extraData: _extraData,
                paraswapParams: _paraswapParams
            })
        );

        pool.flash(address(this), amount0, amount1, data);
    }

    /// @notice Callback function called by Uniswap V3 pool during flash loan
    /// @param fee0 The fee for borrowing token0
    /// @param fee1 The fee for borrowing token1
    /// @param data Encoded callback data containing operation type and parameters
    /// @dev Routes to create or close handlers based on operation type. Only callable by valid Uniswap V3 pools.
    function uniswapV3FlashCallback(uint256 fee0, uint256 fee1, bytes calldata data) external whenNotPaused {
        // Decode operation type first
        (OperationType operationType) = abi.decode(data, (OperationType));

        // Verify callback
        IUniswapV3Pool pool = IUniswapV3Pool(msg.sender);
        PoolAddress.PoolKey memory poolKey = PoolAddress.getPoolKey(pool.token0(), pool.token1(), pool.fee());
        CallbackValidation.verifyCallback(registry.uniswapV3Factory(), poolKey);

        // Suppose either of fee0 or fee1 is 0
        uint totalFee = fee0 + fee1;

        if (operationType == OperationType.Create) {
            (, CreateCallbackData memory decoded) = abi.decode(data, (OperationType, CreateCallbackData));
            _handleCreateCallback(decoded, totalFee);
        } else if (operationType == OperationType.Close) {
            (, CloseCallbackData memory decoded) = abi.decode(data, (OperationType, CloseCallbackData));
            _handleCloseCallback(decoded, totalFee);
        } else {
            revert InvalidOperationType(uint8(operationType));
        }
    }

    function _handleCreateCallback(CreateCallbackData memory decoded, uint256 totalFee) internal {
        uint256 flashloanBorrowAmount = decoded.targetCollateralAmount - decoded.principleCollateralAmount;

        // Calculate protocol fee based on borrowed amount
        uint256 borrowAmount = decoded.paraswapParams.srcAmount + 1;
        
        uint256 protocolFeeAmount = (borrowAmount * protocolFee) / 10000;

        uint256 amountInMax = borrowAmount + protocolFeeAmount;

        address handler = protocolHandlers[decoded.protocol];
        require(handler != address(0), "Invalid protocol handler");

        (bool successSupply, ) = handler.delegatecall(
            abi.encodeCall(
                IProtocolHandler.supply,
                (decoded.collateralAsset, decoded.targetCollateralAmount, decoded.onBehalfOf, decoded.extraData)
            )
        );
        require(successSupply, "Supply failed");

        (bool successBorrow, ) = handler.delegatecall(
            abi.encodeCall(
                IProtocolHandler.borrow,
                (decoded.debtAsset, amountInMax, decoded.onBehalfOf, decoded.extraData)
            )
        );
        require(successBorrow, "Borrow failed");

        // send protocol fee to fee beneficiary
        if (protocolFee > 0 && feeBeneficiary != address(0)) {
            IERC20(decoded.debtAsset).safeTransfer(feeBeneficiary, protocolFeeAmount);
        }

        uint256 amountToRepay = flashloanBorrowAmount + totalFee;

        swapByParaswap(
                decoded.debtAsset,
                decoded.collateralAsset,
                amountInMax,
                amountToRepay,
                decoded.paraswapParams.swapData
        );

        // repay flashloan
        IERC20 collateralToken = IERC20(decoded.collateralAsset);
        collateralToken.safeTransfer(msg.sender, amountToRepay);

        // transfer dust amount back to user
        uint256 remainingCollateralBalance = IERC20(decoded.collateralAsset).balanceOf(address(this));
        collateralToken.safeTransfer(decoded.onBehalfOf, remainingCollateralBalance);

        // repay remaining debt amount
        uint256 remainingBalance = IERC20(decoded.debtAsset).balanceOf(address(this));
        if (remainingBalance > 0) {
            (bool successRepay, ) = handler.delegatecall(
                abi.encodeCall(
                    IProtocolHandler.repay,
                    (decoded.debtAsset, remainingBalance, decoded.onBehalfOf, decoded.extraData)
                )
            );
            require(successRepay, "Repay remaining amount failed");
        }

        emit LeveragedPositionCreated(
            decoded.onBehalfOf,
            decoded.protocol,
            decoded.collateralAsset,
            decoded.principleCollateralAmount,
            decoded.targetCollateralAmount,
            decoded.debtAsset
        );
    }

    function _handleCloseCallback(CloseCallbackData memory decoded, uint256 totalFee) internal {
        address handler = protocolHandlers[decoded.protocol];
        require(handler != address(0), "Invalid protocol handler");

        // Flash loan borrowed the full debt amount - repay the debt
        (bool successRepay, ) = handler.delegatecall(
            abi.encodeCall(
                IProtocolHandler.repay,
                (decoded.debtAsset, decoded.debtAmount, decoded.onBehalfOf, decoded.extraData)
            )
        );
        require(successRepay, "Repay failed");

        (bool successWithdraw, ) = handler.delegatecall(
            abi.encodeCall(
                IProtocolHandler.withdraw,
                (decoded.collateralAsset, decoded.collateralAmount, decoded.onBehalfOf, decoded.extraData)
            )
        );
        require(successWithdraw, "Withdraw failed");
        
        uint256 flashloanRepayAmount = decoded.debtAmount + totalFee;

        // Swap collateral to debt asset to repay flash loan
        swapByParaswap(
            decoded.collateralAsset,
            decoded.debtAsset,
            decoded.paraswapParams.srcAmount, // Amount of collateral to swap
            flashloanRepayAmount,
            decoded.paraswapParams.swapData
        );

        // Repay flash loan
        IERC20 debtToken = IERC20(decoded.debtAsset);
        debtToken.safeTransfer(msg.sender, flashloanRepayAmount);

        // Transfer remaining collateral back to user
        uint256 remainingCollateral = IERC20(decoded.collateralAsset).balanceOf(address(this));
        if (remainingCollateral > 0) {
            IERC20(decoded.collateralAsset).safeTransfer(decoded.onBehalfOf, remainingCollateral);
        }

        // Transfer remaining debt asset(dust amount if exists) back to user
        uint256 remainingDebtAsset = IERC20(decoded.debtAsset).balanceOf(address(this));
        if (remainingDebtAsset > 0) {
            IERC20(decoded.debtAsset).safeTransfer(decoded.onBehalfOf, remainingDebtAsset);
        }

        emit LeveragedPositionClosed(
            decoded.onBehalfOf,
            decoded.protocol,
            decoded.collateralAsset,
            decoded.collateralAmount,
            decoded.debtAsset,
            decoded.debtAmount,
            remainingCollateral
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
        
        // amount + 1 to avoid rounding errors
        IERC20(srcAsset).forceApprove(registry.paraswapV6(), amount + 1);

        (bool success, ) = registry.paraswapV6().call(_txParams);
        require(success, "Token swap by paraSwap failed");

        uint256 actualBalance = IERC20(dstAsset).balanceOf(address(this));
        if (actualBalance < minAmountOut) {
            revert InsufficientTokenBalanceAfterSwap(minAmountOut, actualBalance);
        }

        //remove approval
        IERC20(srcAsset).forceApprove(registry.paraswapV6(), 0);
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

    /// @notice Pauses the contract, preventing position creation and closure
    /// @dev Only callable by the pauser address
    function pause() external onlyPauser {
        _pause();
    }

    /// @notice Unpauses the contract, allowing normal operations
    /// @dev Only callable by the pauser address
    function unpause() external onlyPauser {
        _unpause();
    }

    /// @notice Allows contract to receive ETH from protocol interactions
    /// @dev Required for receiving ETH from protocols like Moonwell or Fluid during withdrawals
    receive() external payable {}
}
