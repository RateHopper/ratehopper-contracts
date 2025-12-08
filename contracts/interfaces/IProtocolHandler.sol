// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "../Types.sol";

interface IProtocolHandler {
    function getDebtAmount(address asset, address onBehalfOf, bytes calldata extraData) external view returns (uint256);

    function switchIn(
        address fromAsset,
        address toAsset,
        uint256 amount,
        uint256 amountTotal,
        address onBehalfOf,
        CollateralAsset[] memory collateralAssets,
        bytes calldata fromExtraData,
        bytes calldata toExtraData
    ) external;

    function switchFrom(
        address fromAsset,
        uint256 amount,
        address onBehalfOf,
        CollateralAsset[] memory collateralAssets,
        bytes calldata extraData
    ) external;

    function switchTo(
        address toAsset,
        uint256 amount,
        address onBehalfOf,
        CollateralAsset[] memory collateralAssets,
        bytes calldata extraData
    ) external;

    function supply(address asset, uint256 amount, address onBehalfOf, bytes calldata extraData) external;

    function borrow(address asset, uint256 amount, address onBehalfOf, bytes calldata extraData) external;

    function repay(address asset, uint256 amount, address onBehalfOf, bytes calldata extraData) external;

    function withdraw(address asset, uint256 amount, address onBehalfOf, bytes calldata extraData) external;
}
