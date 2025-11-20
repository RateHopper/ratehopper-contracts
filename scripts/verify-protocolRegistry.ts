import hre from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { WETH_ADDRESS } from "../test/constants";
import { UNISWAP_V3_FACTORY_ADRESS } from "../contractAddresses";

async function main() {
    const chainId = (await hre.ethers.provider.getNetwork()).chainId;

    // Read deployed addresses from ignition
    const deploymentPath = path.join(
        __dirname,
        "..",
        "ignition",
        "deployments",
        `chain-${chainId}`,
        "deployed_addresses.json",
    );

    if (!fs.existsSync(deploymentPath)) {
        throw new Error(`Deployment file not found: ${deploymentPath}`);
    }

    const deployedAddresses = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));

    const contractAddress = deployedAddresses["ProtocolRegistry#ProtocolRegistry"];

    const constructorArguments = [
        WETH_ADDRESS, // WETH address on Base network
        UNISWAP_V3_FACTORY_ADRESS, // Uniswap V3 Factory address on Base network
    ];

    console.log("Verifying ProtocolRegistry contract at:", contractAddress);
    console.log("Constructor arguments:", JSON.stringify(constructorArguments, null, 2));

    try {
        await hre.run("verify:verify", {
            address: contractAddress,
            constructorArguments: constructorArguments,
        });
        console.log("Contract verified successfully!");
    } catch (error: any) {
        if (error.message.includes("Already Verified")) {
            console.log("Contract is already verified!");
        } else {
            console.error("Verification error:", error.message);
            throw error;
        }
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
