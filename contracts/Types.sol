// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

// Role required for critical operations like updating protocol handlers
bytes32 constant CRITICAL_ROLE = keccak256("CRITICAL_ROLE");

enum Protocol {
    AAVE_V3,
    COMPOUND,
    MORPHO,
    FLUID,
    MOONWELL
}

struct CollateralAsset {
    address asset;
    uint256 amount;
}

struct ParaswapParams {
    uint256 srcAmount;
    bytes swapData;
}