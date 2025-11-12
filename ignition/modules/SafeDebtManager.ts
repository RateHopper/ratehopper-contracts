import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { UNISWAP_V3_FACTORY_ADRESS, Protocol, PARASWAP_V6_CONTRACT_ADDRESS } from "../../contractAddresses";
import SharedInfrastructureModule from "./SharedInfrastructure";

/**
 * Module to deploy SafeDebtManager with all handlers
 *
 * This module uses the SharedInfrastructure module to get the deployed handler addresses,
 * ensuring consistency and avoiding hardcoded addresses.
 *
 * Environment Variables Required:
 * - PAUSER_ADDRESS: Address that can pause/unpause the contract
 * - SAFE_OPERATOR_ADDRESS: Address that can operate the contract
 * - ADMIN_WALLET: Address to transfer ownership to after deployment
 *
 * Usage:
 * npx hardhat ignition deploy ignition/modules/SafeDebtManager.ts --network base --verify
 */
export default buildModule("SafeDebtManagerDeploy", (m) => {
    // Load addresses from environment variables
    const pauserAddress = m.getParameter("pauserAddress", process.env.PAUSER_ADDRESS);
    const operatorAddress = m.getParameter("operatorAddress", process.env.SAFE_OPERATOR_ADDRESS);

    // Use the SharedInfrastructure module to get deployed handlers
    const { aaveV3Handler, compoundHandler, morphoHandler, fluidSafeHandler, moonwellHandler } =
        m.useModule(SharedInfrastructureModule);

    const protocols = [Protocol.AAVE_V3, Protocol.COMPOUND, Protocol.MORPHO, Protocol.FLUID, Protocol.MOONWELL];
    const handlers = [aaveV3Handler, compoundHandler, morphoHandler, fluidSafeHandler, moonwellHandler];

    const safeDebtManager = m.contract("SafeDebtManager", [
        UNISWAP_V3_FACTORY_ADRESS,
        protocols,
        handlers,
        pauserAddress,
    ]);

    // Set Paraswap addresses (first call)
    const setParaswap = m.call(safeDebtManager, "setParaswapAddresses", [
        PARASWAP_V6_CONTRACT_ADDRESS,
        PARASWAP_V6_CONTRACT_ADDRESS,
    ]);

    // Set operator (after Paraswap)
    const setOperator = m.call(safeDebtManager, "setoperator", [operatorAddress], {
        after: [setParaswap],
    });

    // Transfer ownership to team owner wallet (after all setup is complete)
    m.call(safeDebtManager, "transferOwnership", [process.env.ADMIN_WALLET!], {
        after: [setOperator],
    });

    return { safeDebtManager };
});
