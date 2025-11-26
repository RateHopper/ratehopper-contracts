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
} from "../../contractAddresses";
import {
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
} from "../../test/constants";

// TimelockController module
const TimelockControllerModule = buildModule("TimelockController", (m) => {
    // Configuration
    const MIN_DELAY = 2 * 24 * 60 * 60; // 2 days in seconds
    const adminAddress = m.getParameter("adminAddress", process.env.ADMIN_ADDRESS);

    if (!adminAddress) {
        throw new Error("Please set ADMIN_ADDRESS environment variable");
    }

    // Deploy TimelockController
    const timelock = m.contract("TimelockController", [
        MIN_DELAY,
        [adminAddress], // proposers (can schedule operations)
        [adminAddress], // executors (can execute operations)
        "0x0000000000000000000000000000000000000000", // admin (zero address = no admin)
    ]);

    return { timelock };
});

// ProtocolRegistry module
const ProtocolRegistryModule = buildModule("ProtocolRegistry", (m) => {
    const wethAddress = m.getParameter("wethAddress", WETH_ADDRESS);
    const uniswapV3Factory = m.getParameter("uniswapV3Factory", UNISWAP_V3_FACTORY_ADDRESS);
    const initialAdmin = m.getParameter("initialAdmin", process.env.ADMIN_ADDRESS);
    const initialOperator = m.getParameter("initialOperator", process.env.SAFE_OPERATOR_ADDRESS);
    const initialParaswapV6 = m.getParameter("initialParaswapV6", PARASWAP_V6_CONTRACT_ADDRESS);

    // Import TimelockController from its module
    const { timelock } = m.useModule(TimelockControllerModule);

    const registry = m.contract("ProtocolRegistry", [
        wethAddress,
        uniswapV3Factory,
        initialAdmin,
        timelock,
        initialOperator,
        initialParaswapV6,
    ]);
    return { registry };
});

/**
 * Comprehensive module that deploys the entire shared infrastructure:
 * - TimelockController (2-day delay for critical operations)
 * - ProtocolRegistry
 * - All protocol handlers (Aave, Compound, Morpho, Fluid, Moonwell)
 *
 * Environment Variables Required:
 * - ADMIN_ADDRESS: Address for initial admin role and timelock proposer/executor
 * - SAFE_OPERATOR_ADDRESS: Address that can operate contracts via the registry
 *
 * Usage:
 * npx hardhat ignition deploy ignition/modules/SharedInfrastructure.ts --network base --verify
 *
 * This will deploy everything in the correct order:
 * 1. TimelockController
 * 2. ProtocolRegistry (with timelock address)
 * 3. All protocol handlers
 * 4. Configure registry with token mappings and whitelists
 */
export default buildModule("SharedInfrastructure", (m) => {
    // Deploy TimelockController and ProtocolRegistry
    const { timelock } = m.useModule(TimelockControllerModule);
    const { registry } = m.useModule(ProtocolRegistryModule);

    // Deploy handlers sequentially to avoid nonce conflicts
    // Each handler waits for the previous one to complete
    const aaveV3Handler = m.contract("AaveV3Handler", [
        AAVE_V3_POOL_ADDRESS,
        AAVE_V3_DATA_PROVIDER_ADDRESS,
        UNISWAP_V3_FACTORY_ADDRESS,
        registry,
    ]);

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

    // Configure registry after all handlers are deployed
    // Set up Moonwell token mappings (first call)
    const [mTokens, mContracts] = getMTokenMappingArrays();
    const setMoonwellMappings = m.call(registry, "batchSetTokenMContracts", [mTokens, mContracts], {
        after: [moonwellHandler],
    });

    // Set up Compound token mappings (after Moonwell mappings)
    const [cTokens, cContracts] = getCTokenMappingArrays();
    const setCompoundMappings = m.call(registry, "batchSetTokenCContracts", [cTokens, cContracts], {
        after: [setMoonwellMappings],
    });

    // Set Fluid vault resolver (after Compound mappings)
    const setFluidResolver = m.call(registry, "setFluidVaultResolver", [FLUID_VAULT_RESOLVER], {
        after: [setCompoundMappings],
    });

    // Add tokens to whitelist (after Fluid resolver is set)
    // Note: Paraswap V6 and operator are now set in constructor
    const tokens = [
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
    const addToWhitelist = m.call(registry, "addToWhitelistBatch", [tokens], {
        after: [setFluidResolver],
    });

    return {
        timelock,
        registry,
        aaveV3Handler,
        compoundHandler,
        morphoHandler,
        fluidSafeHandler,
        moonwellHandler,
    };
});
