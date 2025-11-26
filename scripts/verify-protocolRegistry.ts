import hre from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { WETH_ADDRESS } from "../test/constants";
import { UNISWAP_V3_FACTORY_ADDRESS, PARASWAP_V6_CONTRACT_ADDRESS } from "../contractAddresses";

/**
 * Script to verify ProtocolRegistry contract on block explorer
 *
 * Reads deployed addresses from ignition/deployments and verifies with correct constructor arguments.
 *
 * Environment Variables Required:
 * - ADMIN_ADDRESS: Initial admin address
 * - SAFE_OPERATOR_ADDRESS: Initial operator address
 *
 * Usage:
 * npx hardhat run scripts/verify-protocolRegistry.ts --network base
 */

async function main() {
    const ADMIN_ADDRESS = process.env.ADMIN_ADDRESS;
    const SAFE_OPERATOR_ADDRESS = process.env.SAFE_OPERATOR_ADDRESS;

    if (!ADMIN_ADDRESS) {
        throw new Error("Please set ADMIN_ADDRESS environment variable");
    }

    if (!SAFE_OPERATOR_ADDRESS) {
        throw new Error("Please set SAFE_OPERATOR_ADDRESS environment variable");
    }

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
    const timelockAddress = deployedAddresses["TimelockController#TimelockController"];

    if (!contractAddress) {
        throw new Error("ProtocolRegistry address not found in deployment file");
    }

    if (!timelockAddress) {
        throw new Error("TimelockController address not found in deployment file");
    }

    const constructorArguments = [
        WETH_ADDRESS, // _wethAddress
        UNISWAP_V3_FACTORY_ADDRESS, // _uniswapV3Factory
        ADMIN_ADDRESS, // _initialAdmin
        timelockAddress, // _timelock
        SAFE_OPERATOR_ADDRESS, // _initialOperator
        PARASWAP_V6_CONTRACT_ADDRESS, // _initialParaswapV6
    ];

    console.log("Verifying ProtocolRegistry contract at:", contractAddress);
    console.log("Constructor arguments:");
    console.log("  - WETH Address:", WETH_ADDRESS);
    console.log("  - Uniswap V3 Factory:", UNISWAP_V3_FACTORY_ADDRESS);
    console.log("  - Initial Admin:", ADMIN_ADDRESS);
    console.log("  - Timelock:", timelockAddress);
    console.log("  - Initial Operator:", SAFE_OPERATOR_ADDRESS);
    console.log("  - Initial Paraswap V6:", PARASWAP_V6_CONTRACT_ADDRESS);

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
