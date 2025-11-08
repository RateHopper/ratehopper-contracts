// SPDX-License-Identifier: MIT
pragma solidity =0.8.28;

import "./interfaces/safe/ISafe.sol";

/**
 * @title SafeExecTransactionWrapper
 * @notice Wrapper contract for Safe wallet's execTransaction that reverts on failure
 * @dev This contract wraps the execTransaction call and ensures the entire transaction
 *      reverts if execTransaction returns false
 */
contract SafeExecTransactionWrapper {
    error TransactionExecutionFailed();

    event RateHopperSuccess(
        bytes metadata
    );

    event RateHopperFailure(
        bytes metadata
    );

    /**
     * @notice Executes a transaction on a Safe wallet and reverts if it fails
     * @dev Calls execTransaction on the specified Safe and reverts if the return value is false
     * @param safe The address of the Safe wallet
     * @param to Destination address of the transaction
     * @param value Ether value of the transaction
     * @param data Data payload of the transaction
     * @param operation Operation type of the transaction (Call or DelegateCall)
     * @param safeTxGas Gas that should be used for the Safe transaction
     * @param baseGas Gas costs that are independent of the transaction execution
     * @param gasPrice Gas price that should be used for the payment calculation
     * @param gasToken Token address (or 0 if ETH) that is used for the payment
     * @param refundReceiver Address of receiver of gas payment (or 0 if tx.origin)
     * @param signatures Packed signature data ({bytes32 r}{bytes32 s}{uint8 v})
     * @param metadata Additional metadata to be included in the emitted events
     */
    function execTransaction(
        address safe,
        address to,
        uint256 value,
        bytes calldata data,
        ISafe.Operation operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures,
        bytes calldata metadata
    ) external payable {
        bool success = ISafe(safe).execTransaction{value: msg.value}(
            to,
            value,
            data,
            operation,
            safeTxGas,
            baseGas,
            gasPrice,
            gasToken,
            refundReceiver,
            signatures
        );

        if (!success) {
            emit RateHopperFailure(metadata);
            revert TransactionExecutionFailed();
        }

        emit RateHopperSuccess(metadata);
    }
}
