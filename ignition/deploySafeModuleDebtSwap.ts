import hre from "hardhat";
import { ethers } from "hardhat";
import { PARASWAP_V6_CONTRACT_ADDRESS, UNISWAP_V3_FACTORY_ADRESS, Protocol } from "./constants";
import { FluidSafeModule, MoonwellModule } from "./deployHandlers";

const PAUSER_ADDRESS = "0x9E073c36F63BF1c611026fdA1fF6007A81932231";
const OPERATOR_ADDRESS = "0xE549DE35b4D370B76c0A777653aD85Aef6eb8Fa4";

async function main() {
    try {
        // const registryAddress = "0xc2b45C4FCaEAE99e609Dd2aAB1684ffBbb95fDEa";

        // // Deploy FluidSafeHandler using Ignition
        // console.log("Deploying FluidSafeHandler...");
        // const { fluidSafeHandler } = await hre.ignition.deploy(FluidSafeModule, {
        //     parameters: {
        //         FluidSafeHandler: {
        //             registryAddress: registryAddress,
        //         },
        //     },
        // });
        // const fluidSafeHandlerAddress = await fluidSafeHandler.getAddress();
        // console.log(`FluidSafeHandler deployed to: ${fluidSafeHandlerAddress}`);

        // // Deploy MoonwellHandler using Ignition
        // console.log("Deploying MoonwellHandler...");
        // const { moonwellHandler } = await hre.ignition.deploy(MoonwellModule, {
        //     parameters: {
        //         MoonwellHandler: {
        //             registryAddress: registryAddress,
        //         },
        //     },
        // });
        // const moonwellHandlerAddress = await moonwellHandler.getAddress();
        // console.log(`MoonwellHandler deployed to: ${moonwellHandlerAddress}`);

        // Deploy SafeModuleDebtSwap
        console.log("Deploying SafeModuleDebtSwap...");
        const SafeModuleDebtSwapFactory = await ethers.getContractFactory("SafeModuleDebtSwap");

        const protocols = [Protocol.AAVE_V3, Protocol.COMPOUND, Protocol.MORPHO, Protocol.FLUID, Protocol.MOONWELL];
        const handlers = [
            "0x4c66eB971B93A24CA1FF73476d4195d03AbD0C96", // AaveV3Handler
            "0xE7a7951a64ee3DE7F1b30Ed86fC4b23F36d43938", // CompoundHandler
            "0xb40c31CfE9ae176266F99DA9C52Eb1254eE1dB47", // MorphoHandler
            "0xFCCfc6D05130e4485837989Ac216Bc38B675B10F", // FluidSafeHandler
            "0x9019DEe61cAB6fcAB3A5EAa7D9FF98964a17dc95", // MoonwellHandler
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
