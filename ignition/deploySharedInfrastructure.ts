import hre from "hardhat";
import { ethers } from "hardhat";
import { UNISWAP_V3_FACTORY_ADRESS } from "./constants";
import { ProtocolRegistryModule, setupRegistry, getGasOptions } from "./deployRegistry";
import { AaveV3Module, CompoundModule, MorphoModule, FluidSafeModule, MoonwellModule } from "./deployHandlers";

/**
 * Deploys the shared infrastructure (registry + handlers) that can be used by multiple contracts
 * Returns the deployed addresses for reuse
 */
export async function deploySharedInfrastructure() {
    const gasOptions = await getGasOptions();
    console.log("Gas options:", gasOptions);

    // Deploy the registry
    console.log("Deploying ProtocolRegistry...");
    const { registry } = await hre.ignition.deploy(ProtocolRegistryModule);
    const registryAddress = await registry.getAddress();
    console.log(`ProtocolRegistry deployed to: ${registryAddress}`);

    // Set up registry configuration
    console.log("Setting up registry configuration...");
    await setupRegistry(registry);

    // Deploy all handlers directly using ethers
    const AAVE_V3_POOL_ADDRESS = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
    const AAVE_V3_DATA_PROVIDER_ADDRESS = "0xd82a47fdebB5bf5329b09441C3DaB4b5df2153Ad";
    const MORPHO_ADDRESS = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
    const COMPTROLLER_ADDRESS = "0xfbb21d0380bee3312b33c4353c8936a0f13ef26c";

    console.log("Deploying AaveV3Handler...");
    const AaveV3HandlerFactory = await ethers.getContractFactory("AaveV3Handler");
    const aaveV3Handler = await AaveV3HandlerFactory.deploy(
        AAVE_V3_POOL_ADDRESS,
        AAVE_V3_DATA_PROVIDER_ADDRESS,
        UNISWAP_V3_FACTORY_ADRESS,
        registryAddress,
        { ...gasOptions, gasLimit: 5000000 }
    );
    await aaveV3Handler.waitForDeployment();
    const aaveV3HandlerAddress = await aaveV3Handler.getAddress();
    console.log(`AaveV3Handler deployed to: ${aaveV3HandlerAddress}`);

    console.log("Deploying CompoundHandler...");
    const CompoundHandlerFactory = await ethers.getContractFactory("CompoundHandler");
    const compoundHandler = await CompoundHandlerFactory.deploy(
        registryAddress,
        UNISWAP_V3_FACTORY_ADRESS,
        { ...gasOptions, gasLimit: 5000000 }
    );
    await compoundHandler.waitForDeployment();
    const compoundHandlerAddress = await compoundHandler.getAddress();
    console.log(`CompoundHandler deployed to: ${compoundHandlerAddress}`);

    console.log("Deploying MorphoHandler...");
    const MorphoHandlerFactory = await ethers.getContractFactory("MorphoHandler");
    const morphoHandler = await MorphoHandlerFactory.deploy(
        MORPHO_ADDRESS,
        UNISWAP_V3_FACTORY_ADRESS,
        registryAddress,
        { ...gasOptions, gasLimit: 5000000 }
    );
    await morphoHandler.waitForDeployment();
    const morphoHandlerAddress = await morphoHandler.getAddress();
    console.log(`MorphoHandler deployed to: ${morphoHandlerAddress}`);

    console.log("Deploying FluidSafeHandler...");
    const FluidSafeHandlerFactory = await ethers.getContractFactory("FluidSafeHandler");
    const fluidSafeHandler = await FluidSafeHandlerFactory.deploy(
        UNISWAP_V3_FACTORY_ADRESS,
        registryAddress,
        { ...gasOptions, gasLimit: 5000000 }
    );
    await fluidSafeHandler.waitForDeployment();
    const fluidSafeHandlerAddress = await fluidSafeHandler.getAddress();
    console.log(`FluidSafeHandler deployed to: ${fluidSafeHandlerAddress}`);

    console.log("Deploying MoonwellHandler...");
    const MoonwellHandlerFactory = await ethers.getContractFactory("MoonwellHandler");
    const moonwellHandler = await MoonwellHandlerFactory.deploy(
        COMPTROLLER_ADDRESS,
        UNISWAP_V3_FACTORY_ADRESS,
        registryAddress,
        { ...gasOptions, gasLimit: 5000000 }
    );
    await moonwellHandler.waitForDeployment();
    const moonwellHandlerAddress = await moonwellHandler.getAddress();
    console.log(`MoonwellHandler deployed to: ${moonwellHandlerAddress}`);

    return {
        registryAddress,
        handlers: {
            aaveV3: aaveV3HandlerAddress,
            compound: compoundHandlerAddress,
            morpho: morphoHandlerAddress,
            fluidSafe: fluidSafeHandlerAddress,
            moonwell: moonwellHandlerAddress,
        },
        gasOptions,
    };
}

// Main function for standalone deployment
async function main() {
    try {
        const result = await deploySharedInfrastructure();
        console.log("\n=== Deployment Summary ===");
        console.log(`Registry: ${result.registryAddress}`);
        console.log(`Handlers:`, result.handlers);
        console.log("Shared infrastructure deployed successfully!");
    } catch (error) {
        console.error("Deployment error:", error);
        process.exit(1);
    }
}

// Only run main if this script is executed directly
if (require.main === module) {
    main().catch(console.error);
}