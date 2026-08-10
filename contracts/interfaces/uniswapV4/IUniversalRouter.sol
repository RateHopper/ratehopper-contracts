// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal surface of the Uniswap UniversalRouter used for V4 swaps.
///         `msg.sender` of `execute` is the swap's payer/recipient identity
///         (MSG_SENDER mapping), so calls are executed BY the Safe via
///         `execTransactionFromModule` — never by the manager.
interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}
