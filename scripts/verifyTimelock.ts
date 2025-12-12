import hre from "hardhat";

/**
 * Script to verify TimelockController contract on block explorer
 *
 * This script verifies the TimelockController contract that was deployed
 * as part of the SharedInfrastructure module.
 *
 * Environment Variables Required:
 * - TIMELOCK_ADDRESS: Address of the deployed TimelockController
 * - ADMIN_ADDRESS: Address used as proposer and executor
 *
 * Usage:
 * TIMELOCK_ADDRESS=0x... npx hardhat run scripts/verify-timelock.ts --network base
 */

async function main() {
    const TIMELOCK_ADDRESS = process.env.TIMELOCK_ADDRESS;
    const ADMIN_ADDRESS = process.env.ADMIN_ADDRESS;

    if (!TIMELOCK_ADDRESS) {
        throw new Error("Please set TIMELOCK_ADDRESS environment variable");
    }

    if (!ADMIN_ADDRESS) {
        throw new Error("Please set ADMIN_ADDRESS environment variable");
    }

    console.log("Verifying TimelockController...");
    console.log("- Address:", TIMELOCK_ADDRESS);
    console.log("- Admin (proposer/executor):", ADMIN_ADDRESS);

    // Constructor arguments
    const MIN_DELAY = 2 * 24 * 60 * 60; // 2 days in seconds
    const constructorArguments = [
        MIN_DELAY,
        [ADMIN_ADDRESS], // proposers
        [ADMIN_ADDRESS], // executors
        "0x0000000000000000000000000000000000000000", // admin (zero address)
    ];

    try {
        await hre.run("verify:verify", {
            address: TIMELOCK_ADDRESS,
            constructorArguments: constructorArguments,
        });

        console.log("✓ TimelockController verified successfully!");
    } catch (error: any) {
        if (error.message.includes("Already Verified")) {
            console.log("✓ Contract is already verified!");
        } else {
            console.error("Verification failed:", error.message);
            throw error;
        }
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
