import { ethers } from "hardhat";

/**
 * Register new yield handlers on the EXISTING SafeYieldManager through the
 * TimelockController, as one batch of `setYieldHandler(protocol, handler)`
 * calls (CRITICAL_ROLE, timelock-only).
 *
 * The timelock proposer is a multisig in production, so the default mode only
 * PRINTS the `scheduleBatch` / `executeBatch` calldata for the multisig to
 * submit. SCHEDULE=true / EXECUTE=true send the transactions from the signer
 * instead (for a fork or an EOA proposer).
 *
 * Every handler is checked first: it must have code, report the protocol id it
 * is registered under, and (unless SKIP_GUARD_CHECK=true) expose a non-zero
 * MAX_MINT_DEVIATION_TICKS — i.e. be a build with the mint-time price guard.
 *
 * Usage:
 *   TIMELOCK_ADDRESS=0x... SAFE_YIELD_MANAGER_ADDRESS=0x... \
 *   UNIV3_HANDLER=0x... AERODROME_HANDLER=0x... UNIV4_HANDLER=0x... \
 *   OPERATION_ID="sym-handlers-mint-guard" \
 *   npx hardhat run scripts/timelockSetYieldHandlers.ts --network base
 *
 * Any of the three handler variables may be omitted to leave that protocol
 * unchanged. Reuse the SAME OPERATION_ID for the execute step.
 */

const PROTOCOLS: { id: number; env: string; label: string }[] = [
    { id: 0, env: "UNIV3_HANDLER", label: "Uniswap V3" },
    { id: 1, env: "AERODROME_HANDLER", label: "Aerodrome" },
    { id: 2, env: "UNIV4_HANDLER", label: "Uniswap V4" },
];

async function main() {
    const TIMELOCK_ADDRESS = process.env.TIMELOCK_ADDRESS || "";
    const SAFE_YIELD_MANAGER_ADDRESS = process.env.SAFE_YIELD_MANAGER_ADDRESS || "";
    const OPERATION_ID = process.env.OPERATION_ID || "";
    const SCHEDULE = process.env.SCHEDULE === "true";
    const EXECUTE = process.env.EXECUTE === "true";
    const SKIP_GUARD_CHECK = process.env.SKIP_GUARD_CHECK === "true";

    if (!ethers.isAddress(TIMELOCK_ADDRESS) || !ethers.isAddress(SAFE_YIELD_MANAGER_ADDRESS)) {
        throw new Error("Set TIMELOCK_ADDRESS and SAFE_YIELD_MANAGER_ADDRESS");
    }
    if (!OPERATION_ID) throw new Error("Set OPERATION_ID (reuse the same value to execute)");
    if (SCHEDULE && EXECUTE) throw new Error("Set at most one of SCHEDULE and EXECUTE");

    const manager = await ethers.getContractAt("SafeYieldManager", SAFE_YIELD_MANAGER_ADDRESS);
    const timelock = await ethers.getContractAt("TimelockController", TIMELOCK_ADDRESS);
    if ((await manager.timelock()).toLowerCase() !== TIMELOCK_ADDRESS.toLowerCase()) {
        throw new Error(`TIMELOCK_ADDRESS is not the manager's timelock (${await manager.timelock()})`);
    }

    const targets: string[] = [];
    const values: bigint[] = [];
    const payloads: string[] = [];
    for (const { id, env, label } of PROTOCOLS) {
        const handler = process.env[env];
        if (!handler) continue;
        if (!ethers.isAddress(handler)) throw new Error(`${env} is not an address: ${handler}`);
        if ((await ethers.provider.getCode(handler)) === "0x") throw new Error(`${env} has no code`);

        const probe = new ethers.Contract(
            handler,
            ["function PROTOCOL() view returns (uint8)", "function MAX_MINT_DEVIATION_TICKS() view returns (uint24)"],
            ethers.provider,
        );
        const protocol = Number(await probe.PROTOCOL());
        if (protocol !== id) throw new Error(`${env} reports protocol ${protocol}, expected ${id}`);
        if (!SKIP_GUARD_CHECK) {
            const deviation = await probe.MAX_MINT_DEVIATION_TICKS();
            if (deviation === 0n) throw new Error(`${env} has MAX_MINT_DEVIATION_TICKS = 0`);
            console.log(
                `- ${label}: ${await manager.yieldHandlers(id)} -> ${handler} (max deviation ${deviation} ticks)`,
            );
        } else {
            console.log(`- ${label}: ${await manager.yieldHandlers(id)} -> ${handler}`);
        }

        targets.push(SAFE_YIELD_MANAGER_ADDRESS);
        values.push(0n);
        payloads.push(manager.interface.encodeFunctionData("setYieldHandler", [id, handler]));
    }
    if (targets.length === 0) throw new Error("Set at least one of UNIV3_HANDLER, AERODROME_HANDLER, UNIV4_HANDLER");

    const predecessor = ethers.ZeroHash;
    const salt = ethers.id(OPERATION_ID);
    const delay = await timelock.getMinDelay();
    const operationId = await timelock.hashOperationBatch(targets, values, payloads, predecessor, salt);
    console.log("- Operation id:", operationId);
    console.log("- Timelock delay:", delay.toString(), "seconds");

    if (EXECUTE) {
        if (!(await timelock.isOperationReady(operationId))) throw new Error("Operation is not ready to execute");
        const receipt = await (await timelock.executeBatch(targets, values, payloads, predecessor, salt)).wait();
        console.log("Executed:", receipt?.hash);
        for (const { id, env } of PROTOCOLS) {
            if (process.env[env]) console.log(`  yieldHandlers(${id}) =`, await manager.yieldHandlers(id));
        }
        return;
    }
    if (SCHEDULE) {
        const receipt = await (
            await timelock.scheduleBatch(targets, values, payloads, predecessor, salt, delay)
        ).wait();
        const readyAt = new Date(Number(await timelock.getTimestamp(operationId)) * 1000);
        console.log("Scheduled:", receipt?.hash, "ready at", readyAt.toISOString());
        return;
    }

    console.log("\nSubmit from the proposer multisig to", TIMELOCK_ADDRESS, ":");
    console.log(
        "scheduleBatch calldata:",
        timelock.interface.encodeFunctionData("scheduleBatch", [targets, values, payloads, predecessor, salt, delay]),
    );
    console.log("\nAfter the delay, from an executor:");
    console.log(
        "executeBatch calldata:",
        timelock.interface.encodeFunctionData("executeBatch", [targets, values, payloads, predecessor, salt]),
    );
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
