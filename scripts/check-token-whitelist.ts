import hre from "hardhat";

async function main() {
    const PROTOCOL_REGISTRY_ADDRESS = "0x_YOUR_PROTOCOL_REGISTRY_ADDRESS_HERE";

    // Token addresses to check - add your token addresses here
    const tokensToCheck = [
        "0x4200000000000000000000000000000000000006", // WETH on Base
        // Add more token addresses here
    ];

    console.log("Checking token whitelist status...");
    console.log("ProtocolRegistry:", PROTOCOL_REGISTRY_ADDRESS);
    console.log("=====================================\n");

    // Get the ProtocolRegistry contract instance
    const ProtocolRegistry = await hre.ethers.getContractAt(
        "ProtocolRegistry",
        PROTOCOL_REGISTRY_ADDRESS
    );

    // Check each token
    for (const tokenAddress of tokensToCheck) {
        try {
            const isWhitelisted = await ProtocolRegistry.isWhitelisted(tokenAddress);
            console.log(`Token: ${tokenAddress}`);
            console.log(`Whitelisted: ${isWhitelisted ? "✓ YES" : "✗ NO"}`);
            console.log("-------------------------------------");
        } catch (error: any) {
            console.error(`Error checking token ${tokenAddress}:`, error.message);
            console.log("-------------------------------------");
        }
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
