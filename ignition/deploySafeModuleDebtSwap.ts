import hre from "hardhat";
import { PARASWAP_V6_CONTRACT_ADDRESS, Protocol } from "./modules/constants";
import { SafeModuleDebtSwapModule } from "./modules/deployHandlers";

const PAUSER_ADDRESS = "0x9E073c36F63BF1c611026fdA1fF6007A81932231";
const OPERATOR_ADDRESS = "0xE549DE35b4D370B76c0A777653aD85Aef6eb8Fa4";

async function main() {
    try {
        // Deploy SafeModuleDebtSwap using Ignition
        console.log("Deploying SafeModuleDebtSwap...");

        const protocols = [Protocol.AAVE_V3, Protocol.COMPOUND, Protocol.MORPHO, Protocol.FLUID, Protocol.MOONWELL];
        const handlers = [
            "0x4c66eB971B93A24CA1FF73476d4195d03AbD0C96", // AaveV3Handler
            "0xE7a7951a64ee3DE7F1b30Ed86fC4b23F36d43938", // CompoundHandler
            "0xb40c31CfE9ae176266F99DA9C52Eb1254eE1dB47", // MorphoHandler
            "0xFCCfc6D05130e4485837989Ac216Bc38B675B10F", // FluidSafeHandler
            "0x9019DEe61cAB6fcAB3A5EAa7D9FF98964a17dc95", // MoonwellHandler
        ];

        const { safeModuleDebtSwap } = await hre.ignition.deploy(SafeModuleDebtSwapModule, {
            parameters: {
                SafeModuleDebtSwap: {
                    protocols: protocols,
                    handlers: handlers,
                    pauserAddress: PAUSER_ADDRESS,
                    paraswapAddress: PARASWAP_V6_CONTRACT_ADDRESS,
                    operatorAddress: OPERATOR_ADDRESS,
                },
            },
        });

        const safeModuleDebtSwapAddress = await safeModuleDebtSwap.getAddress();
        console.log(`SafeModuleDebtSwap deployed to: ${safeModuleDebtSwapAddress}`);
        console.log("Paraswap addresses set successfully");
        console.log("Operator set successfully");
    } catch (error) {
        console.error("Deployment error:", error);
    }
}

main().catch(console.error);
