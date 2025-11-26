import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { UNISWAP_V3_FACTORY_ADDRESS, Protocol, PARASWAP_V6_CONTRACT_ADDRESS } from "../../contractAddresses";
import SharedInfrastructureModule from "./SharedInfrastructure";

/**
 * Module to deploy LeveragedPosition with all handlers
 *
 * This module uses the SharedInfrastructure module to get the deployed handler addresses,
 * ensuring consistency and avoiding hardcoded addresses.
 *
 * Environment Variables Required:
 * - PAUSER_ADDRESS: Address that can pause/unpause the contract
 * - ADMIN_ADDRESS: Address to transfer ownership to after deployment
 *
 * Note: Operator address is fetched from ProtocolRegistry (no need to set separately)
 *
 * Usage:
 * npx hardhat ignition deploy ignition/modules/LeveragedPosition.ts --network base --verify
 */
export default buildModule("LeveragedPositionDeploy", (m) => {
    // Load pauser address from environment variables
    const pauserAddress = m.getParameter("pauserAddress", process.env.PAUSER_ADDRESS);

    // Use the SharedInfrastructure module to get deployed handlers and registry
    const { registry, aaveV3Handler, compoundHandler, morphoHandler, fluidSafeHandler, moonwellHandler } =
        m.useModule(SharedInfrastructureModule);

    const protocols = [Protocol.AAVE_V3, Protocol.COMPOUND, Protocol.MORPHO, Protocol.FLUID, Protocol.MOONWELL];
    const handlers = [aaveV3Handler, compoundHandler, morphoHandler, fluidSafeHandler, moonwellHandler];

    // Deploy LeveragedPosition
    // Note: Operator is retrieved from registry.safeOperator(), not stored locally
    const leveragedPosition = m.contract("LeveragedPosition", [registry, protocols, handlers, pauserAddress]);

    // Transfer ownership to admin wallet
    m.call(leveragedPosition, "transferOwnership", [process.env.ADMIN_ADDRESS!]);

    return { leveragedPosition };
});
