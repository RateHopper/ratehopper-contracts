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

// Yield (LP) protocols managed by SafeYieldManager. Append-only: new
// protocols (e.g. UNISWAP_V4) must be added at the end so existing
// handler registrations and stored basis keys keep their meaning.
enum YieldProtocol {
    UNISWAP_V3,
    AERODROME
}

struct CollateralAsset {
    address asset;
    uint256 amount;
}

struct ParaswapParams {
    uint256 srcAmount;
    bytes swapData;
}
