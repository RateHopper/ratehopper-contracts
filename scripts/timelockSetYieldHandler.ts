import { ethers } from "hardhat";
import { deployedManagerAddress } from "./lpSafeShared";

/**
 * Registers (or rolls) a yield handler on an existing SafeYieldManager through
 * the TimelockController.
 *
 * `setYieldHandler(uint8 protocol, address handler)` is timelock-only
 * (`onlyTimelockCriticalRole`), so it is a two-step operation:
 *   1. schedule (PROPOSER_ROLE on the timelock)
 *   2. wait `getMinDelay()` (48 h on Base)
 *   3. execute (EXECUTOR_ROLE)
 *
 * The manager only checks that the handler has code and that its `PROTOCOL()`
 * matches; it does NOT touch the protocol switches. A first registration under a
 * new id therefore starts with open and close disabled (the pauser enables
 * them), a replacement build under a live id keeps them as they are and existing
 * positions stay pinned to the old build until `switchPosition(id, id)`.
 *
 * Usage:
 *   STEP 1 - schedule:
 *   TIMELOCK_ADDRESS=0x... PROTOCOL_ID=3 HANDLER_ADDRESS=0x... [MANAGER_ADDRESS=0x...] \
 *   npx hardhat run scripts/timelockSetYieldHandler.ts --network base
 *
 *   STEP 2 - execute after the delay, reusing the SAME OPERATION_ID printed in step 1:
 *   EXECUTE=true OPERATION_ID="..." TIMELOCK_ADDRESS=0x... PROTOCOL_ID=3 HANDLER_ADDRESS=0x... \
 *   npx hardhat run scripts/timelockSetYieldHandler.ts --network base
 *
 * MANAGER_ADDRESS defaults to the Ignition journal selected by IGNITION_DEPLOYMENT_ID.
 */

async function main() {
    const [signer] = await ethers.getSigners();

    const TIMELOCK_ADDRESS = process.env.TIMELOCK_ADDRESS || "";
    const MANAGER_ADDRESS = process.env.MANAGER_ADDRESS || deployedManagerAddress();
    const HANDLER_ADDRESS = process.env.HANDLER_ADDRESS || "";
    const PROTOCOL_ID = Number(process.env.PROTOCOL_ID ?? NaN);
    const EXECUTE = process.env.EXECUTE === "true";
    const OPERATION_ID = process.env.OPERATION_ID || `set-yield-handler-${PROTOCOL_ID}-${Date.now()}`;

    if (!TIMELOCK_ADDRESS || !HANDLER_ADDRESS || !Number.isInteger(PROTOCOL_ID)) {
        throw new Error("Set TIMELOCK_ADDRESS, PROTOCOL_ID and HANDLER_ADDRESS");
    }
    if (!ethers.isAddress(HANDLER_ADDRESS)) throw new Error(`HANDLER_ADDRESS is not an address: ${HANDLER_ADDRESS}`);
    if (PROTOCOL_ID < 0 || PROTOCOL_ID > 255) throw new Error(`PROTOCOL_ID must be a uint8: ${PROTOCOL_ID}`);

    const timelock = await ethers.getContractAt("TimelockController", TIMELOCK_ADDRESS);
    const manager = await ethers.getContractAt("SafeYieldManager", MANAGER_ADDRESS);
    const handler = await ethers.getContractAt("IYieldHandler", HANDLER_ADDRESS);

    // The same preflight the manager runs, so a scheduled operation cannot be
    // one that reverts 48 hours later.
    if ((await ethers.provider.getCode(HANDLER_ADDRESS)) === "0x") throw new Error("HANDLER_ADDRESS has no code");
    const handlerProtocol = Number(await handler.PROTOCOL());
    if (handlerProtocol !== PROTOCOL_ID) {
        throw new Error(`Handler reports PROTOCOL() = ${handlerProtocol}, expected ${PROTOCOL_ID}`);
    }
    if ((await manager.timelock()).toLowerCase() !== TIMELOCK_ADDRESS.toLowerCase()) {
        throw new Error(
            `Manager ${MANAGER_ADDRESS} is governed by ${await manager.timelock()}, not ${TIMELOCK_ADDRESS}`,
        );
    }

    const currentHandler = await manager.yieldHandlers(PROTOCOL_ID);
    console.log("Configuration:");
    console.log("- Timelock:", TIMELOCK_ADDRESS);
    console.log("- SafeYieldManager:", MANAGER_ADDRESS);
    console.log("- Protocol id:", PROTOCOL_ID);
    console.log("- Current handler:", currentHandler);
    console.log("- New handler:", HANDLER_ADDRESS);
    console.log("- Operation ID:", OPERATION_ID);
    console.log("- Mode:", EXECUTE ? "EXECUTE" : "SCHEDULE");
    console.log("- Signer:", signer.address);

    const target = MANAGER_ADDRESS;
    const value = 0;
    const data = manager.interface.encodeFunctionData("setYieldHandler", [PROTOCOL_ID, HANDLER_ADDRESS]);
    const predecessor = ethers.ZeroHash;
    const salt = ethers.id(OPERATION_ID);
    const delay = await timelock.getMinDelay();
    const operationId = await timelock.hashOperation(target, value, data, predecessor, salt);

    if (!EXECUTE) {
        console.log("\n=== SCHEDULING OPERATION ===\n");
        if (await timelock.isOperationPending(operationId)) {
            const readyAt = new Date(Number(await timelock.getTimestamp(operationId)) * 1000);
            console.log("Operation already scheduled:", operationId);
            console.log("Ready for execution at:", readyAt.toISOString());
            return;
        }
        const tx = await timelock.schedule(target, value, data, predecessor, salt, delay);
        const receipt = await tx.wait();
        const readyAt = new Date(Number(await timelock.getTimestamp(operationId)) * 1000);
        console.log("Scheduled. Transaction:", receipt?.hash);
        console.log("Operation ID:", operationId);
        console.log("Ready for execution at:", readyAt.toISOString(), `(${delay} seconds)`);
        console.log("\n=== NEXT STEPS ===");
        console.log(`1. After ${readyAt.toISOString()}, run with EXECUTE=true and the same OPERATION_ID:`);
        console.log(
            `   EXECUTE=true OPERATION_ID="${OPERATION_ID}" TIMELOCK_ADDRESS=${TIMELOCK_ADDRESS} PROTOCOL_ID=${PROTOCOL_ID} \\`,
        );
        console.log(`   HANDLER_ADDRESS=${HANDLER_ADDRESS} MANAGER_ADDRESS=${MANAGER_ADDRESS} \\`);
        console.log("   npx hardhat run scripts/timelockSetYieldHandler.ts --network base");
        console.log("2. Pauser: setProtocolEnabledForClose then setProtocolEnabledForOpen (first registration only).");
        console.log(
            "3. Admin: scripts/setPoolParamAllowed.ts per pool param; scripts/configureSavingsHandler.ts if needed.",
        );
        console.log("4. Replacement build: switchPosition(id, id) per position moves it onto the new build.");
        return;
    }

    console.log("\n=== EXECUTING OPERATION ===\n");
    if (!(await timelock.isOperationReady(operationId))) {
        if (await timelock.isOperationPending(operationId)) {
            const readyAt = new Date(Number(await timelock.getTimestamp(operationId)) * 1000);
            throw new Error(`Operation is not ready yet. Wait until ${readyAt.toISOString()}`);
        }
        throw new Error("Operation not found. Schedule it first (run without EXECUTE=true)");
    }
    const tx = await timelock.execute(target, value, data, predecessor, salt);
    const receipt = await tx.wait();
    console.log("Executed. Transaction:", receipt?.hash);

    const registered = await manager.yieldHandlers(PROTOCOL_ID);
    console.log("\n=== VERIFICATION ===");
    console.log("Registered handler:", registered);
    console.log("Update successful:", registered.toLowerCase() === HANDLER_ADDRESS.toLowerCase());
    console.log(
        "Switches: open",
        await manager.protocolEnabledForOpen(PROTOCOL_ID),
        "close",
        await manager.protocolEnabledForClose(PROTOCOL_ID),
    );
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
