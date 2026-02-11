import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import {
    getCTokenMappingArrays,
    getMTokenMappingArrays,
    UNISWAP_V3_FACTORY_ADDRESS,
    FLUID_VAULT_RESOLVER,
    AAVE_V3_POOL_ADDRESS,
    AAVE_V3_DATA_PROVIDER_ADDRESS,
    MORPHO_ADDRESS,
    COMPTROLLER_ADDRESS,
    PARASWAP_V6_CONTRACT_ADDRESS,
    Protocol,
    WETH_ADDRESS,
    USDC_ADDRESS,
    USDbC_ADDRESS,
    cbETH_ADDRESS,
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
    wrsETH_ADDRESS,
    WELL_ADDRESS,
    USDS_ADDRESS,
    tBTC_ADDRESS,
    LBTC_ADDRESS,
    VIRTUAL_ADDRESS,
} from "../../contractAddresses";

/**
 * Single unified deployment module that deploys ALL contracts in one command.
 *
 * All steps are chained sequentially via `after` to avoid nonce race conditions.
 *
 * Deployment order:
 *  1. TimelockController (2-day delay)
 *  2. ProtocolRegistry (with timelock, operator, paraswap set in constructor)
 *  3. Handlers: AaveV3 → Compound → Morpho → FluidSafe → Moonwell
 *  4. Registry config: Moonwell mappings → Compound mappings → Fluid resolver → Whitelist
 *  5. Registry admin transfer: grant ADMIN_ADDRESS → revoke deployer
 *  6. SafeDebtManager → transferOwnership to ADMIN_ADDRESS
 *  7. LeveragedPosition → transferOwnership to ADMIN_ADDRESS
 *  8. SafeExecTransactionWrapper
 *
 * Environment Variables Required:
 *  - ADMIN_ADDRESS:          Admin / timelock proposer+executor / final owner
 *  - SAFE_OPERATOR_ADDRESS:  Operator address stored in ProtocolRegistry
 *  - PAUSER_ADDRESS:         Can pause/unpause SafeDebtManager and LeveragedPosition
 *  - DEPLOYER_PRIVATE_KEY:   Deployer private key (in hardhat.config.ts)
 *
 * Usage:
 *  npx hardhat ignition deploy ignition/modules/DeployAll.ts --network base --verify --reset
 */
export default buildModule("DeployAll", (m) => {
    // ── Validate env vars ──────────────────────────────────────────────
    const adminAddress = process.env.ADMIN_ADDRESS;
    if (!adminAddress) {
        throw new Error("Please set ADMIN_ADDRESS environment variable");
    }
    const operatorAddress = process.env.SAFE_OPERATOR_ADDRESS;
    if (!operatorAddress) {
        throw new Error("Please set SAFE_OPERATOR_ADDRESS environment variable");
    }
    const pauserAddress = process.env.PAUSER_ADDRESS;
    if (!pauserAddress) {
        throw new Error("Please set PAUSER_ADDRESS environment variable");
    }

    const deployer = m.getAccount(0);
    const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
    const DEFAULT_ADMIN_ROLE = "0x0000000000000000000000000000000000000000000000000000000000000000";

    // ── 1. TimelockController ──────────────────────────────────────────
    const MIN_DELAY = 2 * 24 * 60 * 60; // 2 days
    const timelock = m.contract("TimelockController", [
        MIN_DELAY,
        [adminAddress], // proposers
        [adminAddress], // executors
        ZERO_ADDRESS, // no admin
    ]);

    // ── 2. ProtocolRegistry ────────────────────────────────────────────
    const registry = m.contract(
        "ProtocolRegistry",
        [WETH_ADDRESS, UNISWAP_V3_FACTORY_ADDRESS, deployer, timelock, operatorAddress, PARASWAP_V6_CONTRACT_ADDRESS],
        { after: [timelock] },
    );

    // ── 3. Handlers (sequential) ──────────────────────────────────────
    const aaveV3Handler = m.contract(
        "AaveV3Handler",
        [AAVE_V3_POOL_ADDRESS, AAVE_V3_DATA_PROVIDER_ADDRESS, UNISWAP_V3_FACTORY_ADDRESS, registry],
        { after: [registry] },
    );

    const compoundHandler = m.contract("CompoundHandler", [registry, UNISWAP_V3_FACTORY_ADDRESS], {
        after: [aaveV3Handler],
    });

    const morphoHandler = m.contract("MorphoHandler", [MORPHO_ADDRESS, UNISWAP_V3_FACTORY_ADDRESS, registry], {
        after: [compoundHandler],
    });

    const fluidSafeHandler = m.contract("FluidSafeHandler", [UNISWAP_V3_FACTORY_ADDRESS, registry], {
        after: [morphoHandler],
    });

    const moonwellHandler = m.contract("MoonwellHandler", [COMPTROLLER_ADDRESS, UNISWAP_V3_FACTORY_ADDRESS, registry], {
        after: [fluidSafeHandler],
    });

    // ── 4. Registry configuration ─────────────────────────────────────
    const [mTokens, mContracts] = getMTokenMappingArrays();
    const setMoonwellMappings = m.call(registry, "batchSetTokenMContracts", [mTokens, mContracts], {
        id: "registry_setMoonwellMappings",
        after: [moonwellHandler],
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

    // ── 5. Transfer registry admin role ────────────────────────────────
    const grantAdminRole = m.call(registry, "grantRole", [DEFAULT_ADMIN_ROLE, adminAddress], {
        id: "registry_grantAdminToFinalAdmin",
        after: [addToWhitelist],
    });

    const revokeDeployerRole = m.call(registry, "revokeRole", [DEFAULT_ADMIN_ROLE, deployer], {
        id: "registry_revokeAdminFromDeployer",
        after: [grantAdminRole],
    });

    // ── 6. SafeDebtManager ─────────────────────────────────────────────
    const protocols = [Protocol.AAVE_V3, Protocol.COMPOUND, Protocol.MORPHO, Protocol.FLUID, Protocol.MOONWELL];
    const handlers = [aaveV3Handler, compoundHandler, morphoHandler, fluidSafeHandler, moonwellHandler];

    const safeDebtManager = m.contract("SafeDebtManager", [registry, protocols, handlers, pauserAddress], {
        after: [revokeDeployerRole],
    });

    const safeDebtManagerTransfer = m.call(safeDebtManager, "transferOwnership", [adminAddress], {
        id: "safeDebtManager_transferOwnership",
    });

    // ── 7. LeveragedPosition ───────────────────────────────────────────
    const leveragedPosition = m.contract("LeveragedPosition", [registry, protocols, handlers, pauserAddress], {
        after: [safeDebtManagerTransfer],
    });

    const leveragedPositionTransfer = m.call(leveragedPosition, "transferOwnership", [adminAddress], {
        id: "leveragedPosition_transferOwnership",
    });

    // ── 8. SafeExecTransactionWrapper ──────────────────────────────────
    const safeExecTransactionWrapper = m.contract("SafeExecTransactionWrapper", [], {
        after: [leveragedPositionTransfer],
    });

    return {
        timelock,
        registry,
        aaveV3Handler,
        compoundHandler,
        morphoHandler,
        fluidSafeHandler,
        moonwellHandler,
        safeDebtManager,
        leveragedPosition,
        safeExecTransactionWrapper,
    };
});
