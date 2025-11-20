import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import {
    getCTokenMappingArrays,
    getMTokenMappingArrays,
    UNISWAP_V3_FACTORY_ADRESS,
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

// ProtocolRegistry module
const ProtocolRegistryModule = buildModule("ProtocolRegistry", (m) => {
    const wethAddress = m.getParameter("wethAddress", WETH_ADDRESS);
    const uniswapV3Factory = m.getParameter("uniswapV3Factory", UNISWAP_V3_FACTORY_ADRESS);
    const registry = m.contract("ProtocolRegistry", [wethAddress, uniswapV3Factory]);
    return { registry };
});

/**
 * Comprehensive module that deploys the entire shared infrastructure:
 * - ProtocolRegistry
 * - All protocol handlers (Aave, Compound, Morpho, Fluid, Moonwell)
 *
 * Environment Variables Required:
 * - ADMIN_ADDRESS: Address to transfer ProtocolRegistry ownership to after deployment
 * - SAFE_OPERATOR_ADDRESS: Address that can operate contracts via the registry
 *
 * Usage:
 * npx hardhat ignition deploy ignition/modules/SharedInfrastructure.ts --network base --verify
 */
export default buildModule("SharedInfrastructure", (m) => {
    // Load operator address from environment variable
    const operatorAddress = m.getParameter("operatorAddress", process.env.SAFE_OPERATOR_ADDRESS);

    // Deploy registry first
    const { registry } = m.useModule(ProtocolRegistryModule);

    // Deploy handlers sequentially to avoid nonce conflicts
    // Each handler waits for the previous one to complete
    const aaveV3Handler = m.contract("AaveV3Handler", [
        AAVE_V3_POOL_ADDRESS,
        AAVE_V3_DATA_PROVIDER_ADDRESS,
        UNISWAP_V3_FACTORY_ADRESS,
        registry,
    ]);

    const compoundHandler = m.contract("CompoundHandler", [registry, UNISWAP_V3_FACTORY_ADRESS], {
        after: [aaveV3Handler],
    });

    const morphoHandler = m.contract("MorphoHandler", [MORPHO_ADDRESS, UNISWAP_V3_FACTORY_ADRESS, registry], {
        after: [compoundHandler],
    });

    const fluidSafeHandler = m.contract("FluidSafeHandler", [UNISWAP_V3_FACTORY_ADRESS, registry], {
        after: [morphoHandler],
    });

    const moonwellHandler = m.contract("MoonwellHandler", [COMPTROLLER_ADDRESS, UNISWAP_V3_FACTORY_ADRESS, registry], {
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

    // Set Paraswap V6 address (after Fluid resolver)
    const setParaswapV6 = m.call(registry, "setParaswapV6", [PARASWAP_V6_CONTRACT_ADDRESS], {
        after: [setFluidResolver],
    });

    // Set operator address (after Paraswap V6)
    const setOperator = m.call(registry, "setOperator", [operatorAddress], {
        after: [setParaswapV6],
    });

    // Add tokens to whitelist (after operator is set)
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
        after: [setOperator],
    });

    // Transfer ownership to team owner wallet (after all setup is complete)
    m.call(registry, "transferOwnership", [process.env.ADMIN_ADDRESS!], {
        after: [addToWhitelist],
    });

    return {
        registry,
        aaveV3Handler,
        compoundHandler,
        morphoHandler,
        fluidSafeHandler,
        moonwellHandler,
    };
});
