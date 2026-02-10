import hre from "hardhat";
import { ethers } from "hardhat";

/**
 * Example script showing how to update Paraswap V6 address through TimelockController
 *
 * This demonstrates the two-step process:
 * 1. Schedule the operation (requires PROPOSER_ROLE)
 * 2. Wait 2 days
 * 3. Execute the operation (requires EXECUTOR_ROLE)
 *
 * Usage:
 * STEP 1 - Schedule:
 * TIMELOCK_ADDRESS=0x... PROTOCOL_REGISTRY_ADDRESS=0x... NEW_PARASWAP_ADDRESS=0x... \
 * npx hardhat run scripts/timelock-update-paraswap.ts --network base
 *
 * STEP 2 - Execute (run after 2 days):
 * EXECUTE=true TIMELOCK_ADDRESS=0x... PROTOCOL_REGISTRY_ADDRESS=0x... NEW_PARASWAP_ADDRESS=0x... \
 * npx hardhat run scripts/timelock-update-paraswap.ts --network base
 */

async function main() {
    const [signer] = await ethers.getSigners();

    // Configuration from environment
    const TIMELOCK_ADDRESS = process.env.TIMELOCK_ADDRESS || "";
    const PROTOCOL_REGISTRY_ADDRESS = process.env.PROTOCOL_REGISTRY_ADDRESS || "";
    const NEW_PARASWAP_ADDRESS = process.env.NEW_PARASWAP_ADDRESS || "";
    const EXECUTE = process.env.EXECUTE === "true";
    const OPERATION_ID = process.env.OPERATION_ID || "paraswap-update-" + Date.now();

    if (!TIMELOCK_ADDRESS || !PROTOCOL_REGISTRY_ADDRESS || !NEW_PARASWAP_ADDRESS) {
        throw new Error(
            "Please set TIMELOCK_ADDRESS, PROTOCOL_REGISTRY_ADDRESS, and NEW_PARASWAP_ADDRESS"
        );
    }

    console.log("Configuration:");
    console.log("- Timelock:", TIMELOCK_ADDRESS);
    console.log("- ProtocolRegistry:", PROTOCOL_REGISTRY_ADDRESS);
    console.log("- New Paraswap V6:", NEW_PARASWAP_ADDRESS);
    console.log("- Operation ID:", OPERATION_ID);
    console.log("- Mode:", EXECUTE ? "EXECUTE" : "SCHEDULE");
    console.log("- Signer:", signer.address);

    // Get contracts
    const timelock = await ethers.getContractAt("TimelockController", TIMELOCK_ADDRESS);
    const protocolRegistry = await ethers.getContractAt("ProtocolRegistry", PROTOCOL_REGISTRY_ADDRESS);

    // Prepare operation parameters
    const target = PROTOCOL_REGISTRY_ADDRESS;
    const value = 0;
    const data = protocolRegistry.interface.encodeFunctionData("setParaswapV6", [NEW_PARASWAP_ADDRESS]);
    const predecessor = ethers.ZeroHash; // No dependency on other operations
    const salt = ethers.id(OPERATION_ID); // Unique identifier
    const delay = await timelock.getMinDelay();

    // Calculate operation ID
    const operationId = await timelock.hashOperation(target, value, data, predecessor, salt);

    if (!EXECUTE) {
        // STEP 1: Schedule the operation
        console.log("\n=== SCHEDULING OPERATION ===\n");

        // Check if already scheduled
        const isScheduled = await timelock.isOperationPending(operationId);
        if (isScheduled) {
            console.log("⚠️  Operation already scheduled!");
            console.log("Operation ID:", operationId);

            const timestamp = await timelock.getTimestamp(operationId);
            const readyAt = new Date(Number(timestamp) * 1000);
            console.log("Ready for execution at:", readyAt.toISOString());
            return;
        }

        // Schedule the operation
        console.log("Scheduling operation...");
        const tx = await timelock.schedule(target, value, data, predecessor, salt, delay);
        const receipt = await tx.wait();

        console.log("✓ Operation scheduled successfully!");
        console.log("Transaction hash:", receipt?.hash);
        console.log("Operation ID:", operationId);

        const timestamp = await timelock.getTimestamp(operationId);
        const readyAt = new Date(Number(timestamp) * 1000);
        console.log("\nReady for execution at:", readyAt.toISOString());
        console.log(`(${delay} seconds from now)`);

        console.log("\n=== NEXT STEPS ===");
        console.log("1. Wait until:", readyAt.toISOString());
        console.log("2. Run this script again with EXECUTE=true:");
        console.log(`   EXECUTE=true TIMELOCK_ADDRESS=${TIMELOCK_ADDRESS} \\`);
        console.log(`   PROTOCOL_REGISTRY_ADDRESS=${PROTOCOL_REGISTRY_ADDRESS} \\`);
        console.log(`   NEW_PARASWAP_ADDRESS=${NEW_PARASWAP_ADDRESS} \\`);
        console.log(`   OPERATION_ID="${OPERATION_ID}" \\`);
        console.log("   npx hardhat run scripts/timelock-update-paraswap.ts --network base");

    } else {
        // STEP 2: Execute the operation
        console.log("\n=== EXECUTING OPERATION ===\n");

        // Check if operation is ready
        const isReady = await timelock.isOperationReady(operationId);
        if (!isReady) {
            const isPending = await timelock.isOperationPending(operationId);
            if (isPending) {
                const timestamp = await timelock.getTimestamp(operationId);
                const readyAt = new Date(Number(timestamp) * 1000);
                throw new Error(
                    `Operation is not ready yet. Please wait until ${readyAt.toISOString()}`
                );
            } else {
                throw new Error("Operation not found. Please schedule it first (run without EXECUTE=true)");
            }
        }

        // Execute the operation
        console.log("Executing operation...");
        const tx = await timelock.execute(target, value, data, predecessor, salt);
        const receipt = await tx.wait();

        console.log("✓ Operation executed successfully!");
        console.log("Transaction hash:", receipt?.hash);

        // Verify the update
        const currentParaswap = await protocolRegistry.paraswapV6();
        console.log("\n=== VERIFICATION ===");
        console.log("Current Paraswap V6 address:", currentParaswap);
        console.log("Expected address:", NEW_PARASWAP_ADDRESS);
        console.log("Update successful:", currentParaswap.toLowerCase() === NEW_PARASWAP_ADDRESS.toLowerCase());
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
