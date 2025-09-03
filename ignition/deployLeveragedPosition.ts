import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import hre from "hardhat";
import { ethers } from "hardhat";
import { PARASWAP_V6_CONTRACT_ADDRESS, UNISWAP_V3_FACTORY_ADRESS, Protocol } from "./constants";
import { deploySharedInfrastructure } from "./deploySharedInfrastructure";

const LeveragedPositionModule = buildModule("LeveragedPosition", (m) => {
    const uniswapV3Factory = m.getParameter("uniswapV3Factory");
    const protocols = m.getParameter("protocols");
    const handlers = m.getParameter("handlers");

    const leveragedPosition = m.contract("LeveragedPosition", [uniswapV3Factory, protocols, handlers]);
    return { leveragedPosition };
});

export default LeveragedPositionModule;

async function main() {
    try {
        // Deploy shared infrastructure (registry + handlers)
        console.log("Deploying shared infrastructure...");
        const { registryAddress, handlers, gasOptions } = await deploySharedInfrastructure();

        const PROTOCOLS = [Protocol.AAVE_V3, Protocol.COMPOUND, Protocol.MORPHO, Protocol.FLUID, Protocol.MOONWELL];
        
        // Collect handler addresses in the correct order
        const handlerAddresses = [
            handlers.aaveV3,
            handlers.compound,
            handlers.morpho,
            handlers.fluidSafe,
            handlers.moonwell,
        ];

        // Deploy LeveragedPosition contract directly using ethers
        console.log("Deploying LeveragedPosition contract...");
        const LeveragedPositionFactory = await ethers.getContractFactory("LeveragedPosition");
        const leveragedPosition = await LeveragedPositionFactory.deploy(
            UNISWAP_V3_FACTORY_ADRESS,
            PROTOCOLS,
            handlerAddresses,
            { ...gasOptions, gasLimit: 5000000 }
        );
        await leveragedPosition.waitForDeployment();
        const leveragedPositionAddress = await leveragedPosition.getAddress();
        console.log(`LeveragedPosition deployed to: ${leveragedPositionAddress}`);

        // Set Paraswap addresses
        await leveragedPosition.setParaswapAddresses(PARASWAP_V6_CONTRACT_ADDRESS, PARASWAP_V6_CONTRACT_ADDRESS);
        console.log("Paraswap addresses set successfully");

        console.log("\n=== LeveragedPosition Deployment Summary ===");
        console.log(`Registry (shared): ${registryAddress}`);
        console.log(`Handlers (shared):`, handlers);
        console.log(`LeveragedPosition: ${leveragedPositionAddress}`);
        console.log("LeveragedPosition deployment completed successfully!");

    } catch (error) {
        console.error("Deployment error:", error);
        process.exit(1);
    }
}

main().catch(console.error);
