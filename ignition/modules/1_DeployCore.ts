import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import DeployRegistryOnlyModule from "./0_DeployRegistryOnly";
import {
    UNISWAP_V3_FACTORY_ADDRESS,
    AAVE_V3_POOL_ADDRESS,
    AAVE_V3_DATA_PROVIDER_ADDRESS,
    MORPHO_ADDRESS,
    COMPTROLLER_ADDRESS,
    Protocol,
} from "../../contractAddresses";

/**
 * Single unified deployment module that deploys ALL contracts in one command.
 *
 * All steps are chained sequentially via `after` to avoid nonce race conditions.
 *
 * Deployment order:
 *  1. Deploy/reuse configured ProtocolRegistry from DeployRegistryOnly
 *  2. Handlers: AaveV3 → Compound → Morpho → FluidSafe → Moonwell
 *  3. SafeDebtManager → transferOwnership to ADMIN_ADDRESS
 *  4. LeveragedPosition → transferOwnership to ADMIN_ADDRESS
 *  5. SafeExecTransactionWrapper
 *
 * Environment Variables Required:
 *  - ADMIN_ADDRESS:          Admin / timelock proposer+executor / final owner
 *  - SAFE_OPERATOR_ADDRESS:  Operator address stored in ProtocolRegistry
 *  - PAUSER_ADDRESS:         Can pause/unpause SafeDebtManager and LeveragedPosition
 *  - DEPLOYER_PRIVATE_KEY:   Deployer private key (in hardhat.config.ts)
 *
 * Usage:
 *  npx hardhat ignition deploy ignition/modules/1_DeployCore.ts --network base --verify
 */
export default buildModule("DeployCore", (m) => {
    // ── Validate env vars ──────────────────────────────────────────────
    const adminAddress = process.env.ADMIN_ADDRESS;
    if (!adminAddress) {
        throw new Error("Please set ADMIN_ADDRESS environment variable");
    }
    const pauserAddress = process.env.PAUSER_ADDRESS;
    if (!pauserAddress) {
        throw new Error("Please set PAUSER_ADDRESS environment variable");
    }

    const { registry, registryConfigured } = m.useModule(DeployRegistryOnlyModule);

    // ── 1. Handlers (sequential) ──────────────────────────────────────
    const aaveV3Handler = m.contract(
        "AaveV3Handler",
        [AAVE_V3_POOL_ADDRESS, AAVE_V3_DATA_PROVIDER_ADDRESS, UNISWAP_V3_FACTORY_ADDRESS, registry],
        { after: [registryConfigured] },
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

    // ── 2. SafeDebtManager ─────────────────────────────────────────────
    const protocols = [Protocol.AAVE_V3, Protocol.COMPOUND, Protocol.MORPHO, Protocol.FLUID, Protocol.MOONWELL];
    const handlers = [aaveV3Handler, compoundHandler, morphoHandler, fluidSafeHandler, moonwellHandler];

    const safeDebtManager = m.contract("SafeDebtManager", [registry, protocols, handlers, pauserAddress], {
        after: [moonwellHandler],
    });

    const safeDebtManagerTransfer = m.call(safeDebtManager, "transferOwnership", [adminAddress], {
        id: "safeDebtManager_transferOwnership",
    });

    // ── 3. LeveragedPosition ───────────────────────────────────────────
    const leveragedPosition = m.contract("LeveragedPosition", [registry, protocols, handlers, pauserAddress], {
        after: [safeDebtManagerTransfer],
    });

    const leveragedPositionTransfer = m.call(leveragedPosition, "transferOwnership", [adminAddress], {
        id: "leveragedPosition_transferOwnership",
    });

    // ── 4. SafeExecTransactionWrapper ──────────────────────────────────
    const safeExecTransactionWrapper = m.contract("SafeExecTransactionWrapper", [], {
        after: [leveragedPositionTransfer],
    });

    return {
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
