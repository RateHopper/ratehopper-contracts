import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * Module to deploy Logger contract
 *
 * Usage:
 * npx hardhat ignition deploy ignition/modules/Logger.ts --network base --verify
 */
export default buildModule("Logger", (m) => {
    const logger = m.contract("Logger");

    return { logger };
});
