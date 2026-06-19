import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import TimelockControllerModule from "./TimelockControllerModule";
import {
    AERO_ADDRESS,
    cbBTC_ADDRESS,
    cbETH_ADDRESS,
    DAI_ADDRESS,
    eUSD_ADDRESS,
    EURC_ADDRESS,
    FLUID_VAULT_RESOLVER,
    GHO_ADDRESS,
    getCTokenMappingArrays,
    getMTokenMappingArrays,
    LBTC_ADDRESS,
    MAI_ADDRESS,
    PARASWAP_V6_CONTRACT_ADDRESS,
    rETH_ADDRESS,
    sUSDS_ADDRESS,
    tBTC_ADDRESS,
    UNISWAP_V3_FACTORY_ADDRESS,
    USDbC_ADDRESS,
    USDC_ADDRESS,
    USDS_ADDRESS,
    VIRTUAL_ADDRESS,
    weETH_ADDRESS,
    WELL_ADDRESS,
    WETH_ADDRESS,
    wrsETH_ADDRESS,
    wstETH_ADDRESS,
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
 * Deploys and configures ProtocolRegistry.
 *
 * If REGISTRY_TIMELOCK is set, that existing TimelockController address is used.
 * If unset, this module deploys/reuses the shared TimelockControllerModule.
 *
 * Environment variables:
 *  - REGISTRY_INITIAL_ADMIN: Final DEFAULT_ADMIN_ROLE holder. Falls back to ADMIN_ADDRESS.
 *  - SAFE_OPERATOR_ADDRESS:  Initial registry safeOperator.
 *  - REGISTRY_TIMELOCK:      Optional existing timelock to use for CRITICAL_ROLE.
 *  - TIMELOCK_ADMIN:         Used by TimelockControllerModule when REGISTRY_TIMELOCK is unset.
 *                            Falls back to ADMIN_ADDRESS.
 *  - TIMELOCK_DELAY:         Used by TimelockControllerModule when REGISTRY_TIMELOCK is unset.
 *                            Defaults to 28800 seconds.
 *  - DEPLOYER_PRIVATE_KEY:   Deployer key (set in hardhat.config.ts).
 *
 * Usage:
 *   npx hardhat ignition deploy ignition/modules/0_DeployRegistryOnly.ts \
 *     --network base --verify
 */
export default buildModule("DeployRegistryOnly", (m) => {
    const finalAdminAddr = process.env.REGISTRY_INITIAL_ADMIN ?? process.env.ADMIN_ADDRESS ?? "";
    const operatorAddr = process.env.SAFE_OPERATOR_ADDRESS ?? "";
    const reuseTimelockAddr = process.env.REGISTRY_TIMELOCK ?? "";

    requireAddress("finalAdmin (REGISTRY_INITIAL_ADMIN / ADMIN_ADDRESS)", finalAdminAddr);
    requireAddress("operator (SAFE_OPERATOR_ADDRESS)", operatorAddr);
    if (reuseTimelockAddr) requireAddress("timelock (REGISTRY_TIMELOCK)", reuseTimelockAddr);

    const deployer = m.getAccount(0);
    const DEFAULT_ADMIN_ROLE = "0x0000000000000000000000000000000000000000000000000000000000000000";

    const timelock = reuseTimelockAddr ? undefined : m.useModule(TimelockControllerModule).timelock;
    const timelockArg: any = timelock ?? reuseTimelockAddr;

    const finalAdmin = m.getParameter<string>("finalAdmin", finalAdminAddr);
    const operator = m.getParameter<string>("operator", operatorAddr);

    const registry = m.contract(
        "ProtocolRegistry",
        [
            WETH_ADDRESS,
            UNISWAP_V3_FACTORY_ADDRESS,
            deployer,
            timelockArg,
            operator,
            PARASWAP_V6_CONTRACT_ADDRESS,
        ],
        timelock ? { after: [timelock] } : undefined,
    );

    const [mTokens, mContracts] = getMTokenMappingArrays();
    const setMoonwellMappings = m.call(registry, "batchSetTokenMContracts", [mTokens, mContracts], {
        id: "registry_setMoonwellMappings",
    });

    const [cTokens, cContracts] = getCTokenMappingArrays();
    const setCompoundMappings = m.call(registry, "batchSetTokenCContracts", [cTokens, cContracts], {
        id: "registry_setCompoundMappings",
        after: [setMoonwellMappings],
    });

    const setFluidResolver = m.call(registry, "setFluidVaultResolver", [FLUID_VAULT_RESOLVER], {
        id: "registry_setFluidVaultResolver",
        after: [setCompoundMappings],
    });

    const whitelistTokens = [
        USDC_ADDRESS,
        cbETH_ADDRESS,
        WETH_ADDRESS,
        USDbC_ADDRESS,
        cbBTC_ADDRESS,
        eUSD_ADDRESS,
        MAI_ADDRESS,
        DAI_ADDRESS,
        sUSDS_ADDRESS,
        AERO_ADDRESS,
        wstETH_ADDRESS,
        rETH_ADDRESS,
        weETH_ADDRESS,
        EURC_ADDRESS,
        GHO_ADDRESS,
        wrsETH_ADDRESS,
        WELL_ADDRESS,
        USDS_ADDRESS,
        tBTC_ADDRESS,
        LBTC_ADDRESS,
        VIRTUAL_ADDRESS,
    ];
    const addToWhitelist = m.call(registry, "addToWhitelistBatch", [whitelistTokens], {
        id: "registry_addToWhitelistBatch",
        after: [setFluidResolver],
    });

    const grantAdminRole = m.call(registry, "grantRole", [DEFAULT_ADMIN_ROLE, finalAdmin], {
        id: "registry_grantAdminToFinalAdmin",
        after: [addToWhitelist],
    });

    const revokeDeployerRole = m.call(registry, "revokeRole", [DEFAULT_ADMIN_ROLE, deployer], {
        id: "registry_revokeAdminFromDeployer",
        after: [grantAdminRole],
    });

    // `registryConfigured` is the final config call (revoke), exposed so 1_DeployCore
    // can gate handler deployment on registry configuration completing. Ignition's
    // result type only models contract deployment futures, so cast the call future to
    // satisfy the type while keeping the real future for `after` dependencies.
    const registryConfigured = revokeDeployerRole as unknown as ReturnType<typeof m.contract>;

    return { registry, registryConfigured, ...(timelock ? { timelock } : {}) };
});
