// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/// @notice Minimal interface exposing the ProtocolRegistry surface that
///         RateHopperPositions needs — only the `safeOperator` getter used to
///         authorize callers of closeLp().
interface IProtocolRegistry {
    function safeOperator() external view returns (address);
}
