import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { UNISWAP_V3_FACTORY_ADRESS, Protocol, PARASWAP_V6_CONTRACT_ADDRESS } from "./constants";
import SharedInfrastructureModule from "./SharedInfrastructure";

const PAUSER_ADDRESS = "0x9E073c36F63BF1c611026fdA1fF6007A81932231";
const OPERATOR_ADDRESS = "0xE549DE35b4D370B76c0A777653aD85Aef6eb8Fa4";

/**
 * Module to deploy SafeModuleDebtSwap with all handlers
 *
 * This module uses the SharedInfrastructure module to get the deployed handler addresses,
 * ensuring consistency and avoiding hardcoded addresses.
 *
 * Usage:
 * npx hardhat ignition deploy ignition/modules/SafeModuleDebtSwap.ts --network base --verify
 */
export default buildModule("SafeModuleDebtSwapDeploy", (m) => {
    // Use the SharedInfrastructure module to get deployed handlers
    const { aaveV3Handler, compoundHandler, morphoHandler, fluidSafeHandler, moonwellHandler } = m.useModule(SharedInfrastructureModule);

    const protocols = [Protocol.AAVE_V3, Protocol.COMPOUND, Protocol.MORPHO, Protocol.FLUID, Protocol.MOONWELL];
    const handlers = [
        aaveV3Handler,
        compoundHandler,
        morphoHandler,
        fluidSafeHandler,
        moonwellHandler,
    ];

    const safeModuleDebtSwap = m.contract("SafeModuleDebtSwap", [
        UNISWAP_V3_FACTORY_ADRESS,
        protocols,
        handlers,
        PAUSER_ADDRESS,
    ]);

    // Set Paraswap addresses (first call)
    const setParaswap = m.call(safeModuleDebtSwap, "setParaswapAddresses", [PARASWAP_V6_CONTRACT_ADDRESS, PARASWAP_V6_CONTRACT_ADDRESS]);

    // Set operator (after Paraswap)
    m.call(safeModuleDebtSwap, "setoperator", [OPERATOR_ADDRESS], {
        after: [setParaswap]
    });

    return { safeModuleDebtSwap };
});
