// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal surface of Permit2's AllowanceTransfer. Both the V4
///         PositionManager and the UniversalRouter pull ERC20 input through
///         Permit2, so the Safe's approvals are two-step: ERC20 -> Permit2,
///         then this sub-allowance Permit2 -> spender. The ERC20 allowance to
///         Permit2 is shared across ALL Permit2 spenders, which is why every
///         flow grants exactly what it needs and resets both hops to zero.
interface IAllowanceTransfer {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;

    function allowance(
        address user,
        address token,
        address spender
    ) external view returns (uint160 amount, uint48 expiration, uint48 nonce);
}
