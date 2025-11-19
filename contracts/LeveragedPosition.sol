// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./dependencies/uniswapV3/CallbackValidation.sol";
import {PoolAddress} from "./dependencies/uniswapV3/PoolAddress.sol";
import {IERC20} from "./dependencies/IERC20.sol";
import {GPv2SafeERC20} from "./dependencies/GPv2SafeERC20.sol";
import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import {IProtocolHandler} from "./interfaces/IProtocolHandler.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./Types.sol";
import "./interfaces/safe/ISafe.sol";
import "./dependencies/TransferHelper.sol";
import "./ProtocolRegistry.sol";

contract LeveragedPosition is Ownable, ReentrancyGuard, Pausable {
    using GPv2SafeERC20 for IERC20;
    uint8 public protocolFee;
    address public feeBeneficiary;
    ProtocolRegistry public immutable registry;
    mapping(Protocol => address) public protocolHandlers;
    address public safeOperator;
    address public pauser;

    error InsufficientTokenBalanceAfterSwap(uint256 expected, uint256 actual);

    enum OperationType { Create, Close }

    modifier onlyOwnerOrOperator(address onBehalfOf) {
        require(onBehalfOf != address(0), "onBehalfOf cannot be zero address");

        // Check if caller is safeOperator or the onBehalfOf address itself
        require(msg.sender == safeOperator || msg.sender == onBehalfOf || ISafe(onBehalfOf).isOwner(msg.sender), "Caller is not authorized");
        _;
    }

    modifier onlyPauser() {
        require(msg.sender == pauser, "Caller is not authorized to pause");
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

    constructor(address _registry, Protocol[] memory protocols, address[] memory handlers, address _pauser) Ownable(msg.sender) {
        require(protocols.length == handlers.length, "Protocols and handlers length mismatch");
        require(_registry != address(0), "Registry cannot be zero address");
        require(_pauser != address(0), "Pauser cannot be zero address");
        registry = ProtocolRegistry(_registry);

        for (uint256 i = 0; i < protocols.length; i++) {
            require(handlers[i] != address(0), "Invalid handler address");
            protocolHandlers[protocols[i]] = handlers[i];
        }

        safeOperator = msg.sender;
        pauser = _pauser;
    }

    function setProtocolFee(uint8 _fee) public onlyOwner {
        require(_fee <= 100, "_fee cannot be greater than 1%");
        uint8 oldFee = protocolFee;
        protocolFee = _fee;
        emit ProtocolFeeSet(oldFee, _fee);
    }

    function setFeeBeneficiary(address _feeBeneficiary) public onlyOwner {
        require(_feeBeneficiary != address(0), "_feeBeneficiary cannot be zero address");
        address oldBeneficiary = feeBeneficiary;
        feeBeneficiary = _feeBeneficiary;
        emit FeeBeneficiarySet(oldBeneficiary, _feeBeneficiary);
    }

    function setOperator(address _safeOperator) public onlyOwner {
        require(_safeOperator != address(0), "_safeOperator cannot be zero address");
        safeOperator = _safeOperator;
    }

    function createLeveragedPosition(
        address _flashloanPool,
        Protocol _protocol,
        address _collateralAsset,
        uint256 _principleCollateralAmount,
        uint256 _targetCollateralAmount,
        address _debtAsset,
        bytes calldata _extraData,
        ParaswapParams calldata _paraswapParams
    ) public nonReentrant whenNotPaused {
        require(_collateralAsset != address(0), "Invalid collateral asset address");
        require(_debtAsset != address(0), "Invalid debt asset address");

        IERC20(_collateralAsset).transferFrom(msg.sender, address(this), _principleCollateralAmount);

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
                onBehalfOf: msg.sender,
                extraData: _extraData,
                paraswapParams: _paraswapParams
            })
        );

        pool.flash(address(this), amount0, amount1, data);
    }

    function closeLeveragedPosition(
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
        require(_debtAmount > 0, "Invalid debt amount");

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

    function uniswapV3FlashCallback(uint256 fee0, uint256 fee1, bytes calldata data) external {
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

        // send protocol fee if applicable
        if (protocolFee > 0 && feeBeneficiary != address(0)) {
            IERC20(decoded.debtAsset).safeTransfer(feeBeneficiary, protocolFeeAmount);
        }

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
        TransferHelper.safeApprove(srcAsset, registry.paraswapV6(), (type(uint256).max));
        (bool success, ) = registry.paraswapV6().call(_txParams);
        require(success, "Token swap by paraSwap failed");

        uint256 actualBalance = IERC20(dstAsset).balanceOf(address(this));
        if (actualBalance < minAmountOut) {
            revert InsufficientTokenBalanceAfterSwap(minAmountOut, actualBalance);
        }

        //remove approval
        TransferHelper.safeApprove(srcAsset, registry.paraswapV6(), 0);
    }

    function emergencyWithdraw(address token, uint256 amount) external onlyOwner {
        require(token != address(0), "Invalid token address");
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(amount <= balance, "Insufficient balance");
        IERC20(token).safeTransfer(owner(), amount);
        emit EmergencyWithdrawn(token, amount, owner());
    }

    function pause() external onlyPauser {
        _pause();
    }

    function unpause() external onlyPauser {
        _unpause();
    }

    // Allow contract to receive ETH (e.g., from protocols like Moonwell or Fluid)
    receive() external payable {}
}
