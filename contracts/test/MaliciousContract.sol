// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../interfaces/IProtocolHandler.sol";
import "../Types.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MaliciousContract is IProtocolHandler {
    address public maliciousAddress;
    
    constructor(address _maliciousAddress) {
        maliciousAddress = _maliciousAddress;
    }
    
    function getDebtAmount(address asset, address user, bytes calldata extraData) external pure returns (uint256) {
        return type(uint256).max; 
    }

    function supply(
        address asset,
        uint256 amount,
        address onBehalfOf,
        bytes calldata extraData
    ) external {
        // Try to transfer tokens to malicious address instead of supplying
        IERC20(asset).transfer(maliciousAddress, amount);
    }

    function borrow(
        address asset,
        uint256 amount,
        address onBehalfOf,
        bytes calldata extraData
    ) external {
        // Try to transfer any tokens the contract has to malicious address
        uint256 balance = IERC20(asset).balanceOf(address(this));
        if (balance > 0) {
            IERC20(asset).transfer(maliciousAddress, balance);
        }
    }

    function switchFrom(
        address asset,
        uint256 amount,
        address onBehalfOf,
        CollateralAsset[] calldata collateralAssets,
        bytes calldata extraData
    ) external {
        // Try to transfer tokens to malicious address
        IERC20(asset).transfer(maliciousAddress, amount);
    }

    function switchTo(
        address asset,
        uint256 amount,
        address onBehalfOf,
        CollateralAsset[] calldata collateralAssets,
        bytes calldata extraData
    ) external {
        // Try to transfer tokens to malicious address
        IERC20(asset).transfer(maliciousAddress, amount);
    }

    function switchIn(
        address fromAsset,
        address toAsset,
        uint256 amount,
        uint256 amountTotal,
        address onBehalfOf,
        CollateralAsset[] calldata collateralAssets,
        bytes calldata fromExtraData,
        bytes calldata toExtraData
    ) external {
        // Try to transfer both tokens to malicious address
        IERC20(fromAsset).transfer(maliciousAddress, amount);
        IERC20(toAsset).transfer(maliciousAddress, amountTotal);
    }

    function repay(
        address asset,
        uint256 amount,
        address onBehalfOf,
        bytes calldata extraData
    ) external {
        // Try to transfer tokens to malicious address
        IERC20(asset).transfer(maliciousAddress, amount);
    }

    function withdraw(
        address asset,
        uint256 amount,
        address onBehalfOf,
        bytes calldata extraData
    ) external {
        // Try to transfer tokens to malicious address
        uint256 balance = IERC20(asset).balanceOf(address(this));
        if (balance > 0) {
            IERC20(asset).transfer(maliciousAddress, balance);
        }
    }
} 