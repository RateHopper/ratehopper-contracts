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
uint8 constant YIELD_PROTOCOL_UNISWAP_V4 = 2;

struct CollateralAsset {
    address asset;
    uint256 amount;
}

struct ParaswapParams {
    uint256 srcAmount;
    bytes swapData;
}

/// @notice Reference price source for valuing one token against USDC.
/// @dev    Deliberately decoupled from the pool a swap EXECUTES in: the
///         reference is chosen for depth and observation history, while
///         execution may route through a thinner pool or another protocol
///         entirely (Aerodrome, Uniswap V4). One trusted price per token,
///         regardless of venue. Packs into a single slot.
struct TwapConfig {
    /// @dev Uniswap V3 pool trading {token, USDC}. Zero means unconfigured,
    ///      which is a hard failure rather than a fallback to spot.
    address pool;
    /// @dev Averaging window in seconds.
    uint32 window;
    /// @dev Required `observationCardinality`. A pool below this cannot
    ///      retain `window` of history; see TwapOracle for why a bare
    ///      `observe()` call is not enough to detect that.
    uint16 minCardinality;
}

/// @notice One constructor-seeded price reference. Pairing the key with its
///         config in a single struct keeps them from ever being supplied at
///         different lengths, and keeps the manager's constructor one argument
///         under the stack limit that coverage instrumentation imposes (viaIR,
///         see .solcover.js — the same reason `MintArgs` and `SwapSteps` exist).
struct TwapSeed {
    address token;
    TwapConfig config;
}
