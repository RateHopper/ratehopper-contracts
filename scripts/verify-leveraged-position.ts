import hre from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { UNISWAP_V3_FACTORY_ADRESS, Protocol } from "../contractAddresses";

async function main() {
    const network = hre.network.name;
    const chainId = (await hre.ethers.provider.getNetwork()).chainId;

    console.log(`Verifying LeveragedPosition on ${network} (chainId: ${chainId})...`);

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

    // Get contract addresses
    const leveragedPositionAddress = deployedAddresses["LeveragedPositionDeploy#LeveragedPosition"];
    const registryAddress = deployedAddresses["ProtocolRegistry#ProtocolRegistry"];
    const aaveV3HandlerAddress = deployedAddresses["SharedInfrastructure#AaveV3Handler"];
    const compoundHandlerAddress = deployedAddresses["SharedInfrastructure#CompoundHandler"];
    const morphoHandlerAddress = deployedAddresses["SharedInfrastructure#MorphoHandler"];
    const fluidSafeHandlerAddress = deployedAddresses["SharedInfrastructure#FluidSafeHandler"];
    const moonwellHandlerAddress = deployedAddresses["SharedInfrastructure#MoonwellHandler"];

    if (!leveragedPositionAddress) {
        throw new Error("LeveragedPosition address not found in deployments");
    }

    if (!registryAddress) {
        throw new Error("ProtocolRegistry address not found in deployments");
    }

    console.log(`LeveragedPosition address: ${leveragedPositionAddress}`);
    console.log(`ProtocolRegistry address: ${registryAddress}`);
    console.log("\nHandler addresses:");
    console.log(`  AaveV3Handler: ${aaveV3HandlerAddress}`);
    console.log(`  CompoundHandler: ${compoundHandlerAddress}`);
    console.log(`  MorphoHandler: ${morphoHandlerAddress}`);
    console.log(`  FluidSafeHandler: ${fluidSafeHandlerAddress}`);
    console.log(`  MoonwellHandler: ${moonwellHandlerAddress}`);

    // Prepare constructor arguments
    const protocols = [Protocol.AAVE_V3, Protocol.COMPOUND, Protocol.MORPHO, Protocol.FLUID, Protocol.MOONWELL];
    const handlers = [
        aaveV3HandlerAddress,
        compoundHandlerAddress,
        morphoHandlerAddress,
        fluidSafeHandlerAddress,
        moonwellHandlerAddress,
    ];

    // Get pauser address from environment variable (same as used in deployment)
    const pauserAddress = process.env.PAUSER_ADDRESS;
    if (!pauserAddress) {
        throw new Error("PAUSER_ADDRESS environment variable is required");
    }

    const constructorArgs = [UNISWAP_V3_FACTORY_ADRESS, registryAddress, protocols, handlers, pauserAddress];

    console.log("\nConstructor arguments:");
    console.log(`  Uniswap V3 Factory: ${UNISWAP_V3_FACTORY_ADRESS}`);
    console.log(`  Protocol Registry: ${registryAddress}`);
    console.log(`  Protocols: [${protocols.join(", ")}]`);
    console.log(`  Handlers: [${handlers.join(", ")}]`);
    console.log(`  Pauser: ${pauserAddress}`);

    // Verify contract
    console.log("\nVerifying contract on Basescan...");
    try {
        await hre.run("verify:verify", {
            address: leveragedPositionAddress,
            constructorArguments: constructorArgs,
        });
        console.log("✅ LeveragedPosition verified successfully!");
    } catch (error: any) {
        if (error.message.includes("Already Verified")) {
            console.log("✅ LeveragedPosition is already verified!");
        } else {
            console.error("❌ Verification failed:");
            console.error(error);
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
