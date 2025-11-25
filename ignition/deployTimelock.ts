import hre from "hardhat";
import { ethers } from "hardhat";

/**
 * Script to deploy a TimelockController for use with ProtocolRegistry
 *
 * This implements a hybrid timelock approach:
 * - Critical operations (setParaswapV6, setOperator) require 2-day timelock
 * - Routine operations (whitelist, token mappings) can be done immediately by admin
 *
 * Usage:
 * npx hardhat run scripts/setup-timelock.ts --network base
 *
 * After deployment, use the timelock address when deploying ProtocolRegistry:
 * TIMELOCK_ADDRESS=0x... npx hardhat run scripts/deploy-registry.ts --network base
 *
 * NOTE: When ProtocolRegistry is deployed with a timelock address in its constructor,
 * it automatically grants CRITICAL_ROLE to that timelock.
 */

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deploying TimelockController with account:", deployer.address);

    // Configuration
    const MIN_DELAY = 2 * 24 * 60 * 60; // 2 days in seconds

    console.log("\nConfiguration:");
    console.log("- Min Delay: 2 days (172800 seconds)");
    console.log("- Deployer (will be proposer and executor):", deployer.address);

    // Deploy TimelockController
    console.log("\n=== Deploying TimelockController ===");

    const TimelockController = await ethers.getContractFactory("TimelockController");
    const timelock = await TimelockController.deploy(
        MIN_DELAY,
        [deployer.address], // proposers (can schedule operations)
        [deployer.address], // executors (can execute operations)
        ethers.ZeroAddress, // admin (can grant/revoke roles)
    );

    await timelock.waitForDeployment();
    const timelockAddress = await timelock.getAddress();
    console.log("✓ TimelockController deployed to:", timelockAddress);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
