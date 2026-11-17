// Clears the yield stack's futures from a local Ignition journal so
// `yarn deploy:2_yield_manager` can deploy a new generation into the SAME
// deployment id. Ignition refuses to reuse a completed future whose bytecode
// changed ("Artifact bytecodes have been changed"), refuses to wipe a future
// that has no state, and refuses to wipe a future that others depend on, so
// the futures present are wiped manager first.
//
// The timelock (TimelockControllerModule#TimelockController) is never wiped:
// the new manager reuses it. Nothing on chain changes; only the local journal.
//
// The journal directory is gitignored and is the only record of constructor
// arguments for `yarn verify`, so it is copied to
// ignition/deployments/<id>.backup-<timestamp> before anything is wiped.
//
// Usage:
//   node scripts/wipeYieldStack.js                 # list what would be wiped
//   CONFIRM=true node scripts/wipeYieldStack.js    # back up, then wipe
// Env: IGNITION_DEPLOYMENT_ID (default chain-8453).

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

// Dependents before dependencies: the manager takes every handler, the savings
// handler takes the rate provider.
const WIPE_ORDER = [
    "DeployYieldManager#SafeYieldManager",
    "DeployYieldManager#SkySavingsYieldHandler",
    "DeployYieldManager#ChainlinkSsrRateProvider",
    "DeployYieldManager#UniV3YieldHandler",
    "DeployYieldManager#AerodromeYieldHandler",
    "DeployYieldManager#UniV4YieldHandler",
];

/** Futures from WIPE_ORDER that the journal holds state for, in wipe order. */
function plannedWipes(journalText) {
    const present = new Set();
    for (const line of journalText.split("\n")) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line);
        if (entry.type === "DEPLOYMENT_EXECUTION_STATE_INITIALIZE") present.add(entry.futureId);
        if (entry.type === "WIPE_APPLY") present.delete(entry.futureId);
    }
    const unknown = [...present].filter((id) => id.startsWith("DeployYieldManager#") && !WIPE_ORDER.includes(id));
    if (unknown.length > 0)
        throw new Error(`Journal holds yield futures this script does not order: ${unknown.join(", ")}`);
    return WIPE_ORDER.filter((id) => present.has(id));
}

function main() {
    const root = path.resolve(__dirname, "..");
    const deploymentId = process.env.IGNITION_DEPLOYMENT_ID || "chain-8453";
    const dir = path.join(root, "ignition", "deployments", deploymentId);
    const journal = path.join(dir, "journal.jsonl");
    if (!fs.existsSync(journal)) throw new Error(`No Ignition journal at ${journal}`);

    const wipes = plannedWipes(fs.readFileSync(journal, "utf8"));
    if (wipes.length === 0) {
        console.log(`Nothing to wipe in ${deploymentId}: no yield futures recorded`);
        return;
    }
    console.log(`Yield futures recorded in ${deploymentId}, in wipe order:`);
    for (const id of wipes) console.log(`  ${id}`);
    if (process.env.CONFIRM !== "true") {
        console.log("\nDry run. Re-run with CONFIRM=true to back up the journal directory and wipe these.");
        return;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = `${dir}.backup-${stamp}`;
    fs.cpSync(dir, backup, { recursive: true });
    console.log(`\nBacked up ${dir} to ${backup}`);

    for (const id of wipes) {
        const result = spawnSync("npx", ["hardhat", "ignition", "wipe", deploymentId, id], {
            cwd: root,
            stdio: "inherit",
        });
        if (result.status !== 0) throw new Error(`ignition wipe failed for ${id}; backup is at ${backup}`);
    }
    console.log(`\nWiped ${wipes.length} futures. Deploy with: yarn deploy:2_yield_manager`);
}

module.exports = { WIPE_ORDER, plannedWipes };

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
