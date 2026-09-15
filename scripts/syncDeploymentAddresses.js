const fs = require("fs");
const path = require("path");

const chainId = process.env.CHAIN_ID || "8453";
const networkNames = { 8453: "base", 84532: "base-sepolia" };
const network = networkNames[chainId] || `chain-${chainId}`;
const root = path.resolve(__dirname, "..");
// Same override convention as scripts/lpSafeShared.ts's deployedManagerAddress(): a deploy under a
// non-default --deployment-id (e.g. a version bump kept separate from the chain-${chainId} default)
// must be synced from THAT id, or this silently writes the stale default generation's addresses
// back over the reviewable deployments/${network}.json manifest.
const deploymentId = process.env.IGNITION_DEPLOYMENT_ID || `chain-${chainId}`;
const source = path.join(root, "ignition", "deployments", deploymentId, "deployed_addresses.json");
const outputDir = path.join(root, "deployments");
const output = path.join(outputDir, `${network}.json`);

if (!fs.existsSync(source)) {
    throw new Error(`Ignition deployment addresses not found: ${source}`);
}

const contracts = JSON.parse(fs.readFileSync(source, "utf8"));
const manifest = { chainId: Number(chainId), network, contracts };
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Synced ${Object.keys(contracts).length} deployment addresses to ${output}`);
