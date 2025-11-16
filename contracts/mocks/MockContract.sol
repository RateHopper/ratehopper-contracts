// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title MockContract
 * @dev Simple mock contract for testing purposes
 */
contract MockContract {
    event FunctionCalled(address indexed caller, bytes data);
    event ValueReceived(address indexed sender, uint256 value);

    uint256 public counter;
    address public lastCaller;
    bytes public lastCallData;

    /**
     * @dev Simple function that increments a counter
     */
    function incrementCounter() external returns (uint256) {
        counter++;
        lastCaller = msg.sender;
        emit FunctionCalled(msg.sender, msg.data);
        return counter;
    }

    /**
     * @dev Function that accepts ETH
     */
    function receiveEther() external payable {
        emit ValueReceived(msg.sender, msg.value);
    }

    /**
     * @dev Generic function that stores call data
     */
    function genericFunction(bytes calldata data) external returns (bool) {
        lastCallData = data;
        lastCaller = msg.sender;
        emit FunctionCalled(msg.sender, msg.data);
        return true;
    }

    /**
     * @dev Function that returns a value
     */
    function getValue() external view returns (uint256) {
        return counter;
    }

    /**
     * @dev Function that reverts
     */
    function revertingFunction() external pure {
        revert("This function always reverts");
    }

    /**
     * @dev Allow contract to receive ETH
     */
    receive() external payable {
        emit ValueReceived(msg.sender, msg.value);
    }

    fallback() external payable {
        emit FunctionCalled(msg.sender, msg.data);
    }
}
