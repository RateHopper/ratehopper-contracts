// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Action bytes decoded by the deployed V4 PositionManager and the
///         UniversalRouter's V4Router. Values copied verbatim from
///         v4-periphery `libraries/Actions.sol` at the deploy-era commit
///         (4d85e047, matching the live Base deployments) and cross-checked
///         against the fork test suite. uint8 so they concatenate with
///         `abi.encodePacked` into the actions byte string.
library V4Actions {
    uint8 internal constant DECREASE_LIQUIDITY = 0x01;
    uint8 internal constant MINT_POSITION = 0x02;
    uint8 internal constant BURN_POSITION = 0x03;
    uint8 internal constant SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 internal constant SETTLE_ALL = 0x0c;
    uint8 internal constant SETTLE_PAIR = 0x0d;
    uint8 internal constant TAKE_ALL = 0x0f;
    uint8 internal constant TAKE_PAIR = 0x11;
    uint8 internal constant SWEEP = 0x14;
}

/// @notice UniversalRouter command bytes (universal-router `libraries/Commands.sol`).
library V4Commands {
    uint8 internal constant V4_SWAP = 0x10;
}
