import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * Zodiac Roles Modifier deployment module
 *
 * The Roles contract provides granular, role-based access control for Safe wallets.
 * It allows you to create roles with specific permissions and assign them to addresses.
 *
 * Constructor Parameters:
 * - owner: Address that will own the Roles modifier (usually the Safe or admin address)
 * - avatar: Address of the Safe wallet that will use this modifier
 * - target: Address that the modifier will call (usually same as avatar)
 *
 * Environment Variables Required:
 * - SAFE_WALLET_ADDRESS: The address of your Safe wallet (used as both avatar and target)
 * - ADMIN_ADDRESS: Address that will own the Roles modifier
 *
 * Usage:
 * npx hardhat ignition deploy ignition/modules/ZodiacRoles.ts --network base --verify
 *
 * Or with custom parameters:
 * npx hardhat ignition deploy ignition/modules/ZodiacRoles.ts --network base \
 *   --parameters '{"ZodiacRoles":{"owner":"0x...","avatar":"0x...","target":"0x..."}}' --verify
 */
export default buildModule("ZodiacRoles", (m) => {
    // Parameters with defaults from environment variables
    const owner = m.getParameter("owner", process.env.ADMIN_ADDRESS!);
    const avatar = m.getParameter("avatar", process.env.SAFE_WALLET_ADDRESS!);
    const target = m.getParameter("target", process.env.SAFE_WALLET_ADDRESS!);

    // Deploy Roles contract
    const roles = m.contract("Roles", [owner, avatar, target]);

    return { roles };
});
