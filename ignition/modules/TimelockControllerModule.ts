import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * Shared TimelockController deployment.
 *
 * Both `DeployCore` and `DeployUniV3Helper` import this via
 * `m.useModule(TimelockControllerModule)`. Because Ignition derives futures'
 * IDs from `<moduleName>#<contractName>`, the timelock here always has the
 * stable ID `TimelockControllerModule#TimelockController` — regardless of
 * which top-level module called it. The journal at
 * `ignition/deployments/chain-<chainId>/` deduplicates by ID across deploy
 * runs, so calling `yarn deploy:1_core` first and `yarn deploy:2_univ3_helper` later reuses
 * the same timelock address.
 *
 * IMPORTANT: parameters are baked in by the FIRST deploy run that executes
 * the sub-module. Subsequent runs reuse the existing address regardless of
 * what env vars they pass. Keep `TIMELOCK_ADMIN` / `TIMELOCK_DELAY` aligned
 * across all parent modules to avoid surprise.
 *
 * Environment variables:
 *  - TIMELOCK_ADMIN: EOA / multisig granted BOTH proposer and executor
 *                    roles. Falls back to ADMIN_ADDRESS. REQUIRED.
 *  - TIMELOCK_DELAY: Minimum delay (seconds) before queued ops can execute.
 *                    Defaults to 172800 (2 days). Lower on testnets only.
 */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const TWO_DAYS = 2 * 24 * 60 * 60;

export default buildModule("TimelockControllerModule", (m) => {
    const admin = m.getParameter<string>(
        "admin",
        process.env.TIMELOCK_ADMIN ?? process.env.ADMIN_ADDRESS ?? "",
    );
    const delay = m.getParameter<number>(
        "delay",
        Number(process.env.TIMELOCK_DELAY ?? TWO_DAYS),
    );

    const timelock = m.contract("TimelockController", [
        delay,
        [admin], // proposers
        [admin], // executors
        ZERO_ADDRESS, // no separate admin — timelock holds DEFAULT_ADMIN_ROLE on itself
    ]);

    return { timelock };
});
