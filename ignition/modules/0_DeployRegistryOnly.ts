import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import TimelockControllerModule from "./TimelockControllerModule";
import {
    PARASWAP_V6_CONTRACT_ADDRESS,
    UNISWAP_V3_FACTORY_ADDRESS,
    WETH_ADDRESS,
} from "../../contractAddresses";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function requireAddress(label: string, value: string): void {
    if (!ADDRESS_RE.test(value)) {
        throw new Error(
            `DeployRegistryOnly: ${label} must be a valid address but got "${value}". ` +
                "Set the corresponding env var in your .env before deploying.",
        );
    }
}

/**
 * Deploys only ProtocolRegistry.
 *
 * If REGISTRY_TIMELOCK is set, that existing TimelockController address is used.
 * If unset, this module deploys/reuses the shared TimelockControllerModule.
 *
 * Environment variables:
 *  - REGISTRY_INITIAL_ADMIN: DEFAULT_ADMIN_ROLE holder. Falls back to ADMIN_ADDRESS.
 *  - SAFE_OPERATOR_ADDRESS:  Initial registry safeOperator.
 *  - REGISTRY_TIMELOCK:      Optional existing timelock to use for CRITICAL_ROLE.
 *  - TIMELOCK_ADMIN:         Used by TimelockControllerModule when REGISTRY_TIMELOCK is unset.
 *                            Falls back to ADMIN_ADDRESS.
 *  - TIMELOCK_DELAY:         Used by TimelockControllerModule when REGISTRY_TIMELOCK is unset.
 *                            Defaults to 172800 seconds.
 *  - DEPLOYER_PRIVATE_KEY:   Deployer key (set in hardhat.config.ts).
 *
 * Usage:
 *   npx hardhat ignition deploy ignition/modules/0_DeployRegistryOnly.ts \
 *     --network base --verify
 */
export default buildModule("DeployRegistryOnly", (m) => {
    const initialAdminAddr = process.env.REGISTRY_INITIAL_ADMIN ?? process.env.ADMIN_ADDRESS ?? "";
    const operatorAddr = process.env.SAFE_OPERATOR_ADDRESS ?? "";
    const reuseTimelockAddr = process.env.REGISTRY_TIMELOCK ?? "";

    requireAddress("initialAdmin (REGISTRY_INITIAL_ADMIN / ADMIN_ADDRESS)", initialAdminAddr);
    requireAddress("operator (SAFE_OPERATOR_ADDRESS)", operatorAddr);
    if (reuseTimelockAddr) requireAddress("timelock (REGISTRY_TIMELOCK)", reuseTimelockAddr);

    const timelock = reuseTimelockAddr ? undefined : m.useModule(TimelockControllerModule).timelock;
    const timelockArg: any = timelock ?? reuseTimelockAddr;

    const initialAdmin = m.getParameter<string>("initialAdmin", initialAdminAddr);
    const operator = m.getParameter<string>("operator", operatorAddr);

    const registry = m.contract(
        "ProtocolRegistry",
        [
            WETH_ADDRESS,
            UNISWAP_V3_FACTORY_ADDRESS,
            initialAdmin,
            timelockArg,
            operator,
            PARASWAP_V6_CONTRACT_ADDRESS,
        ],
        timelock ? { after: [timelock] } : undefined,
    );

    return { registry, ...(timelock ? { timelock } : {}) };
});
