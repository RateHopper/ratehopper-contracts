// Post-deploy sync: rewrites PROTOCOL_REGISTRY_ADDRESS in contractAddresses.ts
// to the ProtocolRegistry address just deployed by 1_DeployCore.ts.
//
// Runs automatically as the last step of `yarn deploy:1_core` so the
// `yarn deploy:2_univ3_helper` fallback (which reads PROTOCOL_REGISTRY_ADDRESS)
// always points at the freshly deployed registry — a dev can't forget to bump
// it manually.
//
// Reads ignition/deployments/chain-<chainId>/deployed_addresses.json (Ignition
// keys futures as `<ModuleId>#<FutureId>`, so the registry is
// `DeployCore#ProtocolRegistry`).

const fs = require("fs");
const path = require("path");

const CHAIN_ID = process.env.CHAIN_ID || "8453";
const REGISTRY_KEY = "DeployCore#ProtocolRegistry";

const ADDRESSES_FILE = path.join(
    __dirname,
    "..",
    "ignition",
    "deployments",
    `chain-${CHAIN_ID}`,
    "deployed_addresses.json",
);
const CONTRACT_ADDRESSES_FILE = path.join(__dirname, "..", "contractAddresses.ts");
const CONSTANT_RE = /(export const PROTOCOL_REGISTRY_ADDRESS = ")(0x[a-fA-F0-9]{40})(";)/;

function main() {
    if (!fs.existsSync(ADDRESSES_FILE)) {
        throw new Error(`Deployment file not found at ${ADDRESSES_FILE}. Did 1_DeployCore run?`);
    }

    const deployed = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));
    const newAddress = deployed[REGISTRY_KEY];
    if (!newAddress) {
        const keys = Object.keys(deployed);
        const nearMatch = keys.find((k) => k.endsWith("#ProtocolRegistry"));
        const hint = nearMatch
            ? `\nDid the module/future ID change? Found "${nearMatch}" — update REGISTRY_KEY in scripts/syncRegistryAddress.js to match.`
            : "";
        throw new Error(
            `Registry key "${REGISTRY_KEY}" not found in ${ADDRESSES_FILE}.` +
                `\nAvailable keys: ${keys.join(", ")}` +
                hint,
        );
    }

    const source = fs.readFileSync(CONTRACT_ADDRESSES_FILE, "utf8");
    const match = source.match(CONSTANT_RE);
    if (!match) {
        throw new Error(`Could not find PROTOCOL_REGISTRY_ADDRESS declaration in ${CONTRACT_ADDRESSES_FILE}.`);
    }

    const oldAddress = match[2];
    if (oldAddress === newAddress) {
        console.log(`PROTOCOL_REGISTRY_ADDRESS already up to date (${newAddress}).`);
        return;
    }

    const updated = source.replace(CONSTANT_RE, `$1${newAddress}$3`);
    fs.writeFileSync(CONTRACT_ADDRESSES_FILE, updated);
    console.log(`Updated PROTOCOL_REGISTRY_ADDRESS: ${oldAddress} -> ${newAddress}`);
    console.log("Remember to commit the change to contractAddresses.ts.");
}

main();
