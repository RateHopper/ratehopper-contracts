const fs = require("fs");
const path = require("path");

// Writes the reviewable public manifest deployments/<network>.json from an Ignition journal.
//
// The default journal (chain-<chainId>) holds every module ever deployed to the chain, so it
// replaces the manifest. A non-default --deployment-id (IGNITION_DEPLOYMENT_ID, the same override
// as scripts/lpSafeShared.ts) usually holds only the modules deployed under it, so its entries are
// MERGED over the existing manifest instead: replacing would silently drop every contract deployed
// under the default id (the debt stack, the registry) from the file downstream repos read.
//
// A merge that would list one contract name under two keys (e.g. DeployYieldManager#SafeYieldManager
// and DeployYieldManagerV2#SafeYieldManager) is refused: the manifest is keyed for consumers by
// contract name, and scripts/checkDeployedBytecode.ts rejects duplicates.

function contractName(key) {
    return key.split("#").pop();
}

function buildManifest({ chainId, network, contracts, existing, merge }) {
    if (!merge) return { chainId, network, contracts };
    if (!existing) throw new Error("Cannot merge: no existing manifest to merge into");
    if (Number(existing.chainId) !== Number(chainId))
        throw new Error(`Cannot merge: existing manifest is chain ${existing.chainId}, not ${chainId}`);
    const merged = { ...existing.contracts, ...contracts };
    const keyByName = new Map();
    for (const key of Object.keys(merged)) {
        const name = contractName(key);
        if (keyByName.has(name))
            throw new Error(
                `Cannot merge: ${name} would be listed as both ${keyByName.get(name)} and ${key}; ` +
                    "edit the manifest by hand and review it",
            );
        keyByName.set(name, key);
    }
    return { chainId, network, contracts: merged };
}

function main() {
    const chainId = process.env.CHAIN_ID || "8453";
    const networkNames = { 8453: "base", 84532: "base-sepolia" };
    const network = networkNames[chainId] || `chain-${chainId}`;
    const root = path.resolve(__dirname, "..");
    const defaultId = `chain-${chainId}`;
    const deploymentId = process.env.IGNITION_DEPLOYMENT_ID || defaultId;
    const source = path.join(root, "ignition", "deployments", deploymentId, "deployed_addresses.json");
    const outputDir = path.join(root, "deployments");
    const output = path.join(outputDir, `${network}.json`);

    if (!fs.existsSync(source)) {
        throw new Error(`Ignition deployment addresses not found: ${source}`);
    }

    const contracts = JSON.parse(fs.readFileSync(source, "utf8"));
    const merge = deploymentId !== defaultId;
    const existing = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, "utf8")) : undefined;
    const manifest = buildManifest({ chainId: Number(chainId), network, contracts, existing, merge });
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(
        `${merge ? "Merged" : "Synced"} ${Object.keys(contracts).length} deployment addresses from ${deploymentId} ` +
            `into ${output} (${Object.keys(manifest.contracts).length} total)`,
    );
}

module.exports = { buildManifest };

if (require.main === module) main();
