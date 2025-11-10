import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { UNISWAP_V3_FACTORY_ADRESS, Protocol, PARASWAP_V6_CONTRACT_ADDRESS } from "../../contractAddresses";
import SharedInfrastructureModule from "./SharedInfrastructure";

/**
 * Module to deploy LeveragedPosition with all handlers
 *
 * This module uses the SharedInfrastructure module to get the deployed handler addresses,
 * ensuring consistency and avoiding hardcoded addresses.
 *
 * Environment Variables Required:
 * - OPERATOR_ADDRESS: Address that can operate the contract
 * - TEAM_OWNER_WALLET: Address to transfer ownership to after deployment
 *
 * Usage:
 * npx hardhat ignition deploy ignition/modules/LeveragedPosition.ts --network base --verify
 */
export default buildModule("LeveragedPositionDeploy", (m) => {
    // Load operator address from environment variables
    const operatorAddress = m.getParameter("operatorAddress", process.env.OPERATOR_ADDRESS);

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

    const leveragedPosition = m.contract("LeveragedPosition", [
        UNISWAP_V3_FACTORY_ADRESS,
        protocols,
        handlers,
    ]);

    // Set Paraswap addresses (first call)
    const setParaswap = m.call(leveragedPosition, "setParaswapAddresses", [PARASWAP_V6_CONTRACT_ADDRESS, PARASWAP_V6_CONTRACT_ADDRESS]);

    // Set operator (after Paraswap)
    const setOperator = m.call(leveragedPosition, "setOperator", [operatorAddress], {
        after: [setParaswap]
    });

    // Transfer ownership to team owner wallet (after all setup is complete)
    m.call(leveragedPosition, "transferOwnership", [process.env.TEAM_OWNER_WALLET!], {
        after: [setOperator]
    });

    return { leveragedPosition };
});
