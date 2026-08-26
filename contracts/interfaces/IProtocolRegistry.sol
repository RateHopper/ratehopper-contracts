// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/// @notice Minimal interface exposing the ProtocolRegistry surface the yield
///         stack needs: the `safeOperator` getter used to authorize callers
///         and the token whitelist gating openLp pool tokens.
interface IProtocolRegistry {
    function safeOperator() external view returns (address);

    function whitelistedTokens(address token) external view returns (bool);
}
