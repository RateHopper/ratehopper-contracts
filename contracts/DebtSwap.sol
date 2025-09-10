// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import "./dependencies/uniswapV3/CallbackValidation.sol";

import {IERC20} from "./dependencies/IERC20.sol";
import {GPv2SafeERC20} from "./dependencies/GPv2SafeERC20.sol";
import {PoolAddress} from "./dependencies/uniswapV3/PoolAddress.sol";
import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import {IProtocolHandler} from "./interfaces/IProtocolHandler.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./Types.sol";
import "./dependencies/TransferHelper.sol";

contract DebtSwap is Ownable, ReentrancyGuard {
    using GPv2SafeERC20 for IERC20;
    uint8 public protocolFee;
    address public feeBeneficiary;
    address public uniswapV3Factory;
    address public paraswapTokenTransferProxy;
    address public paraswapRouter;
    mapping(Protocol => address) public protocolHandlers;

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

    event FeeBeneficiarySet(address indexed oldBeneficiary, address indexed newBeneficiary);

    event ProtocolFeeSet(uint8 oldFee, uint8 newFee);

    event EmergencyWithdrawn(address indexed token, uint256 amount, address indexed to);

    constructor(address _uniswapV3Factory, Protocol[] memory protocols, address[] memory handlers) Ownable(msg.sender) {
        require(protocols.length == handlers.length, "Protocols and handlers length mismatch");
        uniswapV3Factory = _uniswapV3Factory;

        for (uint256 i = 0; i < protocols.length; i++) {
            require(handlers[i] != address(0), "Invalid handler address");
            protocolHandlers[protocols[i]] = handlers[i];
        }
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

    function setParaswapAddresses(address _paraswapTokenTransferProxy, address _paraswapRouter) external onlyOwner {
        require(_paraswapTokenTransferProxy != address(0), "paraswapTokenTransferProxy cannot be zero address");
        require(_paraswapRouter != address(0), "paraswapRouter cannot be zero address");
        paraswapTokenTransferProxy = _paraswapTokenTransferProxy;
        paraswapRouter = _paraswapRouter;
    }

    function executeDebtSwap(
        address _flashloanPool,
        Protocol _fromProtocol,
        Protocol _toProtocol,
        address _fromDebtAsset,
        address _toDebtAsset,
        uint256 _amount,
        CollateralAsset[] calldata _collateralAssets,
        bytes calldata _fromExtraData,
        bytes calldata _toExtraData,
        ParaswapParams calldata _paraswapParams
    ) public nonReentrant {
        require(_fromDebtAsset != address(0), "_fromDebtAsset cannot be zero address");
        require(_toDebtAsset != address(0), "_toDebtAsset cannot be zero address");
        require(_amount > 0, "_amount cannot be zero");

        IUniswapV3Pool pool = IUniswapV3Pool(_flashloanPool);
        address token0;
        try pool.token0() returns (address result) {
            token0 = result;
        } catch {
            revert("Invalid flashloan pool address");
        }

        uint256 debtAmount = _amount;
        if (_amount == type(uint256).max) {
            address handler = protocolHandlers[_fromProtocol];

            debtAmount = IProtocolHandler(handler).getDebtAmount(_fromDebtAsset, msg.sender, _fromExtraData);
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
                onBehalfOf: msg.sender,
                collateralAssets: _collateralAssets,
                fromExtraData: _fromExtraData,
                toExtraData: _toExtraData,
                paraswapParams: _paraswapParams
            })
        );

        pool.flash(address(this), amount0, amount1, data);
    }

    function uniswapV3FlashCallback(uint256 fee0, uint256 fee1, bytes calldata data) external {
        FlashCallbackData memory decoded = abi.decode(data, (FlashCallbackData));

        // verify callback
        IUniswapV3Pool pool = IUniswapV3Pool(msg.sender);
        PoolAddress.PoolKey memory poolKey = PoolAddress.getPoolKey(pool.token0(), pool.token1(), pool.fee());
        CallbackValidation.verifyCallback(uniswapV3Factory, poolKey);

        // suppose either of fee0 or fee1 is 0
        uint flashloanFeeOriginal = fee0 + fee1;

        // need this flashloanFee conversion to calculate amountTotal correctly when fromAsset and toAsset have different decimals
        uint8 fromAssetDecimals = IERC20(decoded.fromAsset).decimals();
        uint8 toAssetDecimals = IERC20(decoded.toAsset).decimals();
        int8 decimalDifference = int8(fromAssetDecimals) - int8(toAssetDecimals);
        uint flashloanFee;
        if (decimalDifference > 0) {
            flashloanFee = flashloanFeeOriginal / (10 ** uint8(decimalDifference));
        } else if (decimalDifference < 0) {
            flashloanFee = flashloanFeeOriginal * (10 ** uint8(-decimalDifference));
        } else {
            flashloanFee = flashloanFeeOriginal;
        }

        // Calculate protocol fee in toAsset decimals to ensure correct fee amount
        uint256 protocolFeeAmount = _calculateProtocolFee(
            decoded.fromAsset,
            decoded.toAsset,
            decoded.amount,
            decimalDifference
        );

        uint256 amountInMax = decoded.paraswapParams.srcAmount == 0 ? decoded.amount : decoded.paraswapParams.srcAmount;
        uint256 amountTotal = amountInMax + flashloanFee + protocolFeeAmount;

        address fromHandler = protocolHandlers[decoded.fromProtocol];
        require(fromHandler != address(0), "Invalid from protocol handler");

        address toHandler = protocolHandlers[decoded.toProtocol];
        require(toHandler != address(0), "Invalid to protocol handler");

        if (decoded.fromProtocol == decoded.toProtocol) {
            (bool success, ) = fromHandler.delegatecall(
                abi.encodeCall(
                    IProtocolHandler.switchIn,
                    (
                        decoded.fromAsset,
                        decoded.toAsset,
                        decoded.amount,
                        amountTotal,
                        decoded.onBehalfOf,
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
                    (
                        decoded.fromAsset,
                        decoded.amount,
                        decoded.onBehalfOf,
                        decoded.collateralAssets,
                        decoded.fromExtraData
                    )
                )
            );
            require(successFrom, "protocol switchFrom failed");

            (bool successTo, ) = toHandler.delegatecall(
                abi.encodeCall(
                    IProtocolHandler.switchTo,
                    (decoded.toAsset, amountTotal, decoded.onBehalfOf, decoded.collateralAssets, decoded.toExtraData)
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
        IERC20(decoded.fromAsset).safeTransfer(address(msg.sender), amountToRepay);

        if (protocolFee > 0 && feeBeneficiary != address(0)) {
            IERC20(decoded.toAsset).safeTransfer(feeBeneficiary, protocolFeeAmount);
        }

        // repay remaining amount
        uint256 remainingBalance = IERC20(decoded.toAsset).balanceOf(address(this));

        if (remainingBalance > 0) {
            (bool success, ) = toHandler.delegatecall(
                abi.encodeCall(
                    IProtocolHandler.repay,
                    (decoded.toAsset, remainingBalance, decoded.onBehalfOf, decoded.toExtraData)
                )
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
        TransferHelper.safeApprove(srcAsset, paraswapTokenTransferProxy, amount);
        (bool success, ) = paraswapRouter.call(_txParams);
        require(success, "Token swap by paraSwap failed");

        require(IERC20(dstAsset).balanceOf(address(this)) >= minAmountOut, "Insufficient token balance after swap");

        //remove approval
        TransferHelper.safeApprove(srcAsset, paraswapTokenTransferProxy, 0);
    }

    function emergencyWithdraw(address token, uint256 amount) external onlyOwner {
        require(token != address(0), "Invalid token address");
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(amount <= balance, "Insufficient balance");
        IERC20(token).safeTransfer(owner(), amount);
        emit EmergencyWithdrawn(token, amount, owner());
    }

    /**
     * @dev Calculate protocol fee in toAsset decimals to ensure correct fee amount
     * @param fromAsset The source asset address
     * @param toAsset The destination asset address
     * @param amount The amount to calculate fee for
     * @param decimalDifference The decimal difference between fromAsset and toAsset (fromAssetDecimals - toAssetDecimals)
     * @return protocolFeeAmount The calculated protocol fee amount in toAsset decimals
     */
    function _calculateProtocolFee(
        address fromAsset,
        address toAsset,
        uint256 amount,
        int8 decimalDifference
    ) private view returns (uint256 protocolFeeAmount) {
        if (fromAsset == toAsset) {
            protocolFeeAmount = (amount * protocolFee) / 10000;
        } else {
            // Convert amount to toAsset decimals first
            uint256 amountInToAssetDecimals = amount;
            if (decimalDifference > 0) {
                amountInToAssetDecimals = amount / (10 ** uint8(decimalDifference));
            } else if (decimalDifference < 0) {
                amountInToAssetDecimals = amount * (10 ** uint8(-decimalDifference));
            }
            protocolFeeAmount = (amountInToAssetDecimals * protocolFee) / 10000;
        }
    }
}
