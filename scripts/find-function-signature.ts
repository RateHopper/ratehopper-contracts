import { ethers } from "hardhat";

async function main() {
    const targetSignature = "0x035fa74c";

    // List of all public/external functions and public state variables in ProtocolRegistry.sol
    const functions = [
        // Regular functions
        "setTokenMContract(address,address)",
        "getMContract(address)",
        "setTokenCContract(address,address)",
        "getCContract(address)",
        "batchSetTokenMContracts(address[],address[])",
        "batchSetTokenCContracts(address[],address[])",
        "addToWhitelist(address)",
        "removeFromWhitelist(address)",
        "addToWhitelistBatch(address[])",
        "isWhitelisted(address)",
        "setFluidVaultResolver(address)",
        // Public state variables (auto-generated getters)
        "tokenToMContract(address)",
        "tokenToCContract(address)",
        "whitelistedTokens(address)",
        "fluidVaultResolver()",
        "WETH_ADDRESS()",
    ];

    console.log(`Looking for function with signature: ${targetSignature}\n`);

    for (const funcSignature of functions) {
        const calculatedSignature = ethers.id(funcSignature).slice(0, 10);

        if (calculatedSignature === targetSignature) {
            console.log(`✓ MATCH FOUND!`);
            console.log(`Function: ${funcSignature}`);
            console.log(`Signature: ${calculatedSignature}`);
            return;
        }

        console.log(`${funcSignature} -> ${calculatedSignature}`);
    }

    console.log(`\n✗ No matching function found for signature ${targetSignature}`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
