// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

// Role required for critical operations like updating protocol handlers
bytes32 constant CRITICAL_ROLE = keccak256("CRITICAL_ROLE");

enum DebtProtocol {
    AAVE_V3,
    COMPOUND,
    MORPHO,
    FLUID,
    MOONWELL
}

// Canonical yield (LP) protocol ids. SafeYieldManager and the yield
// handlers key everything by plain uint8 so NEW protocols can be
// registered on the deployed manager via `setYieldHandler` without a
// redeploy. Append-only: new ids (e.g. UNISWAP_V4 = 2) must never reuse
// an existing value, so handler registrations and stored basis keys
// keep their meaning. Mirrored by the YieldProtocol enum in
// contractAddresses.ts for off-chain consumers.
uint8 constant YIELD_PROTOCOL_UNISWAP_V3 = 0;
uint8 constant YIELD_PROTOCOL_AERODROME = 1;

struct CollateralAsset {
    address asset;
    uint256 amount;
}

struct ParaswapParams {
    uint256 srcAmount;
    bytes swapData;
}
