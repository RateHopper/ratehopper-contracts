import hre from "hardhat";
import { ethers } from "hardhat";
import { PARASWAP_V6_CONTRACT_ADDRESS, UNISWAP_V3_FACTORY_ADRESS } from "./modules/constants";
import { ProtocolRegistryModule, setupRegistry, getGasOptions } from "./modules/deployRegistry";
import { AaveV3Module, CompoundModule, MorphoModule } from "./modules/deployHandlers";

// Define Protocol enum directly
enum Protocol {
    AAVE_V3,
    COMPOUND,
    MORPHO,
    FLUID,
    MOONWELL,
}

async function main() {
    try {
        // Get gas options once for the entire deployment
        const gasOptions = await getGasOptions();
        console.log("Gas options:", gasOptions);

        // Deploy the registry first
        const { registry } = await hre.ignition.deploy(ProtocolRegistryModule);
        const registryAddress = await registry.getAddress();
        console.log(`ProtocolRegistry deployed to: ${registryAddress}`);

        // Set up registry configuration
        await setupRegistry(registry);

        // Now deploy all handlers with registry address as parameter
        console.log("Deploying AaveV3Handler...");
        const { aaveV3Handler } = await hre.ignition.deploy(AaveV3Module, {
            parameters: {
                AaveV3Handler: {
                    registryAddress: registryAddress,
                },
            },
        });
        const aaveV3HandlerAddress = await aaveV3Handler.getAddress();
        console.log(`AaveV3Handler deployed to: ${aaveV3HandlerAddress}`);

        console.log("Deploying CompoundHandler...");
        const { compoundHandler } = await hre.ignition.deploy(CompoundModule, {
            parameters: {
                CompoundHandler: {
                    registryAddress: registryAddress,
                },
            },
        });
        const compoundHandlerAddress = await compoundHandler.getAddress();
        console.log(`CompoundHandler deployed to: ${compoundHandlerAddress}`);

        console.log("Deploying MorphoHandler...");
        const { morphoHandler } = await hre.ignition.deploy(MorphoModule, {
            parameters: {
                MorphoHandler: {
                    registryAddress: registryAddress,
                },
            },
        });
        const morphoHandlerAddress = await morphoHandler.getAddress();
        console.log(`MorphoHandler deployed to: ${morphoHandlerAddress}`);

        // Deploy DebtSwap directly using ethers
        console.log("Deploying DebtSwap directly...");
        const DebtSwapFactory = await ethers.getContractFactory("DebtSwap");

        const protocols = [Protocol.AAVE_V3, Protocol.COMPOUND, Protocol.MORPHO];
        const handlers = [aaveV3HandlerAddress, compoundHandlerAddress, morphoHandlerAddress];

        const debtSwap = await DebtSwapFactory.deploy(UNISWAP_V3_FACTORY_ADRESS, protocols, handlers, {
            ...gasOptions,
            gasLimit: 5000000,
        });
        await debtSwap.waitForDeployment();

        console.log(`DebtSwap deployed to: ${await debtSwap.getAddress()}`);

        const paraswapTx = await debtSwap.setParaswapAddresses(
            PARASWAP_V6_CONTRACT_ADDRESS,
            PARASWAP_V6_CONTRACT_ADDRESS,
            {
                ...gasOptions,
                gasLimit: 200000,
            },
        );
        await paraswapTx.wait();
        console.log("Paraswap addresses set");
    } catch (error) {
        console.error("Deployment error:", error);
    }
}

main().catch(console.error);
