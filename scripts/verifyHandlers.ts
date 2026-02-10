import hre from "hardhat";
import * as fs from "fs";
import * as path from "path";
import {
    UNISWAP_V3_FACTORY_ADDRESS,
    AAVE_V3_POOL_ADDRESS,
    AAVE_V3_DATA_PROVIDER_ADDRESS,
    MORPHO_ADDRESS,
    COMPTROLLER_ADDRESS,
} from "../contractAddresses";

interface HandlerConfig {
    name: string;
    deploymentKey: string;
    contractName: string;
    getConstructorArgs: (registryAddress: string) => any[];
}

const HANDLER_CONFIGS: HandlerConfig[] = [
    {
        name: "AaveV3Handler",
        deploymentKey: "SharedInfrastructure#AaveV3Handler",
        contractName: "contracts/protocols/aaveV3Handler.sol:AaveV3Handler",
        getConstructorArgs: (registryAddress: string) => [
            AAVE_V3_POOL_ADDRESS,
            AAVE_V3_DATA_PROVIDER_ADDRESS,
            UNISWAP_V3_FACTORY_ADDRESS,
            registryAddress,
        ],
    },
    {
        name: "CompoundHandler",
        deploymentKey: "SharedInfrastructure#CompoundHandler",
        contractName: "contracts/protocols/compoundHandler.sol:CompoundHandler",
        getConstructorArgs: (registryAddress: string) => [
            registryAddress,
            UNISWAP_V3_FACTORY_ADDRESS,
        ],
    },
    {
        name: "MorphoHandler",
        deploymentKey: "SharedInfrastructure#MorphoHandler",
        contractName: "contracts/protocols/morphoHandler.sol:MorphoHandler",
        getConstructorArgs: (registryAddress: string) => [
            MORPHO_ADDRESS,
            UNISWAP_V3_FACTORY_ADDRESS,
            registryAddress,
        ],
    },
    {
        name: "FluidSafeHandler",
        deploymentKey: "SharedInfrastructure#FluidSafeHandler",
        contractName: "contracts/protocolsSafe/FluidSafeHandler.sol:FluidSafeHandler",
        getConstructorArgs: (registryAddress: string) => [
            UNISWAP_V3_FACTORY_ADDRESS,
            registryAddress,
        ],
    },
    {
        name: "MoonwellHandler",
        deploymentKey: "SharedInfrastructure#MoonwellHandler",
        contractName: "contracts/protocolsSafe/MoonwellHandler.sol:MoonwellHandler",
        getConstructorArgs: (registryAddress: string) => [
            COMPTROLLER_ADDRESS,
            UNISWAP_V3_FACTORY_ADDRESS,
            registryAddress,
        ],
    },
];

async function main() {
    const network = hre.network.name;
    const chainId = (await hre.ethers.provider.getNetwork()).chainId;

    console.log(`Verifying all handlers on ${network} (chainId: ${chainId})...`);

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

    // Get registry address
    const registryAddress = deployedAddresses["ProtocolRegistry#ProtocolRegistry"];
    if (!registryAddress) {
        throw new Error("ProtocolRegistry address not found in deployments");
    }

    console.log(`\nProtocolRegistry address: ${registryAddress}`);
    console.log("\n" + "=".repeat(60));

    let successCount = 0;
    let failCount = 0;

    for (const config of HANDLER_CONFIGS) {
        console.log(`\nVerifying ${config.name}...`);

        const handlerAddress = deployedAddresses[config.deploymentKey];
        if (!handlerAddress) {
            console.log(`  ⚠️  ${config.name} address not found in deployments (key: ${config.deploymentKey})`);
            failCount++;
            continue;
        }

        console.log(`  Address: ${handlerAddress}`);

        const constructorArgs = config.getConstructorArgs(registryAddress);
        console.log(`  Constructor args: ${JSON.stringify(constructorArgs)}`);

        try {
            await hre.run("verify:verify", {
                address: handlerAddress,
                constructorArguments: constructorArgs,
                contract: config.contractName,
            });
            console.log(`  ✅ ${config.name} verified successfully!`);
            successCount++;
        } catch (error: any) {
            if (error.message.includes("Already Verified")) {
                console.log(`  ✅ ${config.name} is already verified!`);
                successCount++;
            } else {
                console.error(`  ❌ ${config.name} verification failed:`);
                console.error(`     ${error.message}`);
                failCount++;
            }
        }
    }

    console.log("\n" + "=".repeat(60));
    console.log(`\nVerification Summary:`);
    console.log(`  ✅ Successful: ${successCount}`);
    console.log(`  ❌ Failed: ${failCount}`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
