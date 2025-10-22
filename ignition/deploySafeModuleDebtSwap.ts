import hre from "hardhat";
import { ethers } from "hardhat";
import { PARASWAP_V6_CONTRACT_ADDRESS, UNISWAP_V3_FACTORY_ADRESS, Protocol } from "./constants";
import { FluidSafeModule, MoonwellModule } from "./deployHandlers";

const PAUSER_ADDRESS = "0x9E073c36F63BF1c611026fdA1fF6007A81932231";
const OPERATOR_ADDRESS = "0xE549DE35b4D370B76c0A777653aD85Aef6eb8Fa4";

async function main() {
    try {
        const registryAddress = "0xc2b45C4FCaEAE99e609Dd2aAB1684ffBbb95fDEa";

        // Deploy FluidSafeHandler using Ignition
        console.log("Deploying FluidSafeHandler...");
        const { fluidSafeHandler } = await hre.ignition.deploy(FluidSafeModule, {
            parameters: {
                FluidSafeHandler: {
                    registryAddress: registryAddress,
                },
            },
        });
        const fluidSafeHandlerAddress = await fluidSafeHandler.getAddress();
        console.log(`FluidSafeHandler deployed to: ${fluidSafeHandlerAddress}`);

        // Deploy MoonwellHandler using Ignition
        console.log("Deploying MoonwellHandler...");
        const { moonwellHandler } = await hre.ignition.deploy(MoonwellModule, {
            parameters: {
                MoonwellHandler: {
                    registryAddress: registryAddress,
                },
            },
        });
        const moonwellHandlerAddress = await moonwellHandler.getAddress();
        console.log(`MoonwellHandler deployed to: ${moonwellHandlerAddress}`);

        // Deploy SafeModuleDebtSwap
        console.log("Deploying SafeModuleDebtSwap...");
        const SafeModuleDebtSwapFactory = await ethers.getContractFactory("SafeModuleDebtSwap");

        const protocols = [Protocol.AAVE_V3, Protocol.COMPOUND, Protocol.MORPHO, Protocol.FLUID, Protocol.MOONWELL];
        const handlers = [
            "0x7f1be446C938c9046206eCbf803405A0B7741D3f", // AaveV3Handler
            "0x2397AE142c2BFd7C3dEc242CE98f87Da172983a7", // CompoundHandler
            "0xb03B40507829d4Ec4b5681d566eA64CE0264Bf48", // MorphoHandler
            fluidSafeHandlerAddress,
            moonwellHandlerAddress,
        ];

        const safeModuleDebtSwap = await SafeModuleDebtSwapFactory.deploy(
            UNISWAP_V3_FACTORY_ADRESS,
            protocols,
            handlers,
            PAUSER_ADDRESS,
        );
        await safeModuleDebtSwap.waitForDeployment();
        console.log(`SafeModuleDebtSwap deployed to: ${await safeModuleDebtSwap.getAddress()}`);

        // Set Paraswap addresses
        const setParaswapTx = await safeModuleDebtSwap.setParaswapAddresses(PARASWAP_V6_CONTRACT_ADDRESS, PARASWAP_V6_CONTRACT_ADDRESS);
        await setParaswapTx.wait();
        console.log("Paraswap addresses set successfully");

        // Set operator
        const setOperatorTx = await safeModuleDebtSwap.setoperator(OPERATOR_ADDRESS);
        await setOperatorTx.wait();
        console.log("Operator set successfully");
    } catch (error) {
        console.error("Deployment error:", error);
    }
}

main().catch(console.error);
