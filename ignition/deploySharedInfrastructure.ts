import hre from "hardhat";
import { ProtocolRegistryModule, setupRegistry } from "./modules/deployRegistry";
import { AllHandlersModule } from "./modules/deployHandlers";

/**
 * Deploys the shared infrastructure (registry + handlers) that can be used by multiple contracts
 * Returns the deployed addresses for reuse
 */
export async function deploySharedInfrastructure() {
    // Deploy the registry
    console.log("Deploying ProtocolRegistry...");
    const { registry } = await hre.ignition.deploy(ProtocolRegistryModule);
    const registryAddress = await registry.getAddress();
    console.log(`ProtocolRegistry deployed to: ${registryAddress}`);

    // Set up registry configuration
    console.log("Setting up registry configuration...");
    await setupRegistry(registry);

    // Deploy all handlers using Ignition
    console.log("Deploying all handlers...");
    const handlers = await hre.ignition.deploy(AllHandlersModule, {
        parameters: {
            AllHandlers: {
                registryAddress: registryAddress,
            },
        },
    });

    const aaveV3HandlerAddress = await handlers.aaveV3Handler.getAddress();
    const compoundHandlerAddress = await handlers.compoundHandler.getAddress();
    const morphoHandlerAddress = await handlers.morphoHandler.getAddress();
    const fluidSafeHandlerAddress = await handlers.fluidSafeHandler.getAddress();
    const moonwellHandlerAddress = await handlers.moonwellHandler.getAddress();

    console.log(`AaveV3Handler deployed to: ${aaveV3HandlerAddress}`);
    console.log(`CompoundHandler deployed to: ${compoundHandlerAddress}`);
    console.log(`MorphoHandler deployed to: ${morphoHandlerAddress}`);
    console.log(`FluidSafeHandler deployed to: ${fluidSafeHandlerAddress}`);
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