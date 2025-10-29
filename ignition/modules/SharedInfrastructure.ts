import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { ProtocolRegistryModule } from "./deployRegistry";
import { UNISWAP_V3_FACTORY_ADRESS, FLUID_VAULT_RESOLVER } from "./constants";
import { getCTokenMappingArrays, getMTokenMappingArrays } from "../../contractAddresses";
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

// Protocol constants
const AAVE_V3_POOL_ADDRESS = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
const AAVE_V3_DATA_PROVIDER_ADDRESS = "0xd82a47fdebB5bf5329b09441C3DaB4b5df2153Ad";
const MORPHO_ADDRESS = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const COMPTROLLER_ADDRESS = "0xfbb21d0380bee3312b33c4353c8936a0f13ef26c";

/**
 * Comprehensive module that deploys the entire shared infrastructure:
 * - ProtocolRegistry
 * - All protocol handlers (Aave, Compound, Morpho, Fluid, Moonwell)
 *
 * Usage:
 * npx hardhat ignition deploy ignition/modules/SharedInfrastructure.ts --network base --verify
 */
export default buildModule("SharedInfrastructure", (m) => {
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

    const compoundHandler = m.contract("CompoundHandler", [
        registry,
        UNISWAP_V3_FACTORY_ADRESS
    ], {
        after: [aaveV3Handler]
    });

    const morphoHandler = m.contract("MorphoHandler", [
        MORPHO_ADDRESS,
        UNISWAP_V3_FACTORY_ADRESS,
        registry
    ], {
        after: [compoundHandler]
    });

    const fluidSafeHandler = m.contract("FluidSafeHandler", [
        UNISWAP_V3_FACTORY_ADRESS,
        registry
    ], {
        after: [morphoHandler]
    });

    const moonwellHandler = m.contract("MoonwellHandler", [
        COMPTROLLER_ADDRESS,
        UNISWAP_V3_FACTORY_ADRESS,
        registry
    ], {
        after: [fluidSafeHandler]
    });

    // Configure registry after all handlers are deployed
    // Set up Moonwell token mappings (first call)
    const [mTokens, mContracts] = getMTokenMappingArrays();
    const setMoonwellMappings = m.call(registry, "batchSetTokenMContracts", [mTokens, mContracts], {
        after: [moonwellHandler]
    });

    // Set up Compound token mappings (after Moonwell mappings)
    const [cTokens, cContracts] = getCTokenMappingArrays();
    const setCompoundMappings = m.call(registry, "batchSetTokenCContracts", [cTokens, cContracts], {
        after: [setMoonwellMappings]
    });

    // Set Fluid vault resolver (after Compound mappings)
    const setFluidResolver = m.call(registry, "setFluidVaultResolver", [FLUID_VAULT_RESOLVER], {
        after: [setCompoundMappings]
    });

    // Add tokens to whitelist (after Fluid resolver)
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
    m.call(registry, "addToWhitelistBatch", [tokens], {
        after: [setFluidResolver]
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
