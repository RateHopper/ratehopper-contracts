// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// This file imports external contracts that are used in tests but not directly in our contracts.
// In Hardhat 3, contracts must be inherited/instantiated to generate artifacts.

import "@openzeppelin/contracts/governance/TimelockController.sol";

// Wrapper contract to generate artifacts for TimelockController in Hardhat 3
// This contract is only used for testing purposes
contract TimelockControllerForTest is TimelockController {
    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address admin
    ) TimelockController(minDelay, proposers, executors, admin) {}
}
