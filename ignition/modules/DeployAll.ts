import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

// ============================================================
// Constants
// ============================================================
const UNISWAP_V3_FACTORY_ADDRESS = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD";
const WETH_ADDRESS = "0x4200000000000000000000000000000000000006";
const PARASWAP_V6_CONTRACT_ADDRESS = "0x6a000f20005980200259b80c5102003040001068";
const FLUID_VAULT_RESOLVER = "0x1500d70d8551b828f8fb56fa739c977d113444df";

const AAVE_V3_POOL_ADDRESS = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
const AAVE_V3_DATA_PROVIDER_ADDRESS = "0xd82a47fdebB5bf5329b09441C3DaB4b5df2153Ad";
const MORPHO_ADDRESS = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const COMPTROLLER_ADDRESS = "0xfbb21d0380bee3312b33c4353c8936a0f13ef26c";

const PAUSER_ADDRESS = "0x9E073c36F63BF1c611026fdA1fF6007A81932231";
const OPERATOR_ADDRESS = "0xE549DE35b4D370B76c0A777653aD85Aef6eb8Fa4";

// Protocol enum values (must match contracts/Types.sol)
const AAVE_V3 = 0;
const COMPOUND = 1;
const MORPHO = 2;
const FLUID = 3;
const MOONWELL = 4;

// ============================================================
// Moonwell token mappings
// ============================================================
const mTokenAddresses = [
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
    "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", // DAI
    "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", // cbETH
    "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", // cbBTC
    "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", // wstETH
    "0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c", // rETH
    "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A", // weETH
    "0x940181a94a35a4569e4529a3cdfb74e38fd98631", // AERO
    "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", // EURC
    "0xedfa23602d0ec14714057867a78d01e94176bea0", // wrsETH
    "0xA88594D404727625A9437C3f886C7643872296AE", // WELL
    "0x820c137fa70c8691f0e44dc420a5e53c168921dc", // USDS
    "0x236aa50979d5f3de3bd1eeb40e81137f22ab794b", // tBTC
    "0xecAc9C5F704e954931349Da37F60E39f515c11c1", // LBTC
    "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b", // VIRTUAL
    "0x4200000000000000000000000000000000000006", // WETH
];
const mContractAddresses = [
    "0xedc817a28e8b93b03976fbd4a3ddbc9f7d176c22", // mUSDC
    "0x73b06d8d18de422e269645eace15400de7462417", // mDAI
    "0x3bf93770f2d4a794c3d9ebefbaebae2a8f09a5e5", // mcbETH
    "0xf877acafa28c19b96727966690b2f44d35ad5976", // mcbBTC
    "0x627Fe393Bc6EdDA28e99AE648fD6fF362514304b", // mwstETH
    "0xcb1dacd30638ae38f2b94ea64f066045b7d45f44", // mrETH
    "0xb8051464C8c92209C92F3a4CD9C73746C4c3CFb3", // mWeETH
    "0x73902f619CEB9B31FD8EFecf435CbDf89E369Ba6", // mAERO
    "0xb682c840B5F4FC58B20769E691A6fa1305A501a2", // mEURC
    "0xfC41B49d064Ac646015b459C522820DB9472F4B5", // mwrsETH
    "0xdC7810B47eAAb250De623F0eE07764afa5F71ED1", // mWELL
    "0xb6419c6C2e60c4025D6D06eE4F913ce89425a357", // mUSDS
    "0x9A858ebfF1bEb0D3495BB0e2897c1528eD84A218", // mtBTC
    "0x10fF57877b79e9bd949B3815220eC87B9fc5D2ee", // mLBTC
    "0xdE8Df9d942D78edE3Ca06e60712582F79CFfFC64", // mVIRTUAL
    "0x628ff693426583D9a7FB391E54366292F509D457", // mWETH
];

// ============================================================
// Compound token mappings
// ============================================================
const cTokenAddresses = [
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
    "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", // USDbC
    "0x4200000000000000000000000000000000000006", // WETH
    "0x940181a94a35a4569e4529a3cdfb74e38fd98631", // AERO
    "0x820c137fa70c8691f0e44dc420a5e53c168921dc", // USDS
];
const cContractAddresses = [
    "0xb125E6687d4313864e53df431d5425969c15Eb2F", // USDC Comet
    "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf", // USDbC Comet
    "0x46e6b214b524310239732D51387075E0e70970bf", // WETH Comet
    "0x784efeB622244d2348d4F2522f8860B96fbEcE89", // AERO Comet
    "0x2c776041CCFe903071AF44aa147368a9c8EEA518", // USDS Comet
];

// ============================================================
// Whitelist tokens
// ============================================================
const whitelistTokens = [
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
    "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", // cbETH
    "0x4200000000000000000000000000000000000006", // WETH
    "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", // USDbC
    "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", // cbBTC
    "0xCfA3Ef56d303AE4fAabA0592388F19d7C3399FB4", // eUSD
    "0xbf1aeA8670D2528E08334083616dD9C5F3B087aE", // MAI
    "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", // DAI
    "0x5875eee11cf8398102fdad704c9e96607675467a", // sUSDS
    "0x940181a94a35a4569e4529a3cdfb74e38fd98631", // AERO
    "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", // wstETH
    "0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c", // rETH
    "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A", // weETH
    "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", // EURC
    "0xedfa23602d0ec14714057867a78d01e94176bea0", // wrsETH
    "0xA88594D404727625A9437C3f886C7643872296AE", // WELL
    "0x820c137fa70c8691f0e44dc420a5e53c168921dc", // USDS
    "0x236aa50979d5f3de3bd1eeb40e81137f22ab794b", // tBTC
    "0xecAc9C5F704e954931349Da37F60E39f515c11c1", // LBTC
    "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b", // VIRTUAL
];

// ============================================================
// Module
// ============================================================
export default buildModule("DeployAll", (m) => {
    // 1. Deploy ProtocolRegistry
    const registry = m.contract("ProtocolRegistry", [WETH_ADDRESS]);

    // 2. Configure ProtocolRegistry
    const setMoonwell = m.call(registry, "batchSetTokenMContracts", [mTokenAddresses, mContractAddresses], {
        id: "registry_setMoonwellMappings",
    });
    const setCompound = m.call(registry, "batchSetTokenCContracts", [cTokenAddresses, cContractAddresses], {
        id: "registry_setCompoundMappings",
        after: [setMoonwell],
    });
    const setFluidResolver = m.call(registry, "setFluidVaultResolver", [FLUID_VAULT_RESOLVER], {
        id: "registry_setFluidVaultResolver",
        after: [setCompound],
    });
    const setWhitelist = m.call(registry, "addToWhitelistBatch", [whitelistTokens], {
        id: "registry_addToWhitelistBatch",
        after: [setFluidResolver],
    });

    // 3. Deploy Handlers (chained sequentially to avoid nonce race conditions)
    const aaveV3Handler = m.contract(
        "AaveV3Handler",
        [AAVE_V3_POOL_ADDRESS, AAVE_V3_DATA_PROVIDER_ADDRESS, UNISWAP_V3_FACTORY_ADDRESS, registry],
        { after: [setWhitelist] },
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
    const moonwellHandler = m.contract(
        "MoonwellHandler",
        [COMPTROLLER_ADDRESS, UNISWAP_V3_FACTORY_ADDRESS, registry],
        { after: [fluidSafeHandler] },
    );

    const allProtocols = [AAVE_V3, COMPOUND, MORPHO, FLUID, MOONWELL];
    const allHandlers = [aaveV3Handler, compoundHandler, morphoHandler, fluidSafeHandler, moonwellHandler];

    // 4. Deploy DebtSwap
    const debtSwap = m.contract("DebtSwap", [UNISWAP_V3_FACTORY_ADDRESS, allProtocols, allHandlers], {
        after: [moonwellHandler],
    });
    const debtSwapParaswap = m.call(debtSwap, "setParaswapAddresses", [PARASWAP_V6_CONTRACT_ADDRESS, PARASWAP_V6_CONTRACT_ADDRESS], {
        id: "debtSwap_setParaswap",
    });

    // 5. Deploy SafeModuleDebtSwap
    const safeModuleDebtSwap = m.contract("SafeModuleDebtSwap", [
        UNISWAP_V3_FACTORY_ADDRESS,
        allProtocols,
        allHandlers,
        PAUSER_ADDRESS,
    ], { after: [debtSwapParaswap] });
    const safeModuleParaswap = m.call(
        safeModuleDebtSwap,
        "setParaswapAddresses",
        [PARASWAP_V6_CONTRACT_ADDRESS, PARASWAP_V6_CONTRACT_ADDRESS],
        { id: "safeModule_setParaswap" },
    );
    const safeModuleOperator = m.call(safeModuleDebtSwap, "setoperator", [OPERATOR_ADDRESS], {
        id: "safeModule_setOperator",
        after: [safeModuleParaswap],
    });

    // 6. Deploy LeveragedPosition
    const leveragedPosition = m.contract("LeveragedPosition", [
        UNISWAP_V3_FACTORY_ADDRESS,
        allProtocols,
        allHandlers,
    ], { after: [safeModuleOperator] });
    m.call(
        leveragedPosition,
        "setParaswapAddresses",
        [PARASWAP_V6_CONTRACT_ADDRESS, PARASWAP_V6_CONTRACT_ADDRESS],
        { id: "leveragedPosition_setParaswap" },
    );

    return {
        registry,
        aaveV3Handler,
        compoundHandler,
        morphoHandler,
        fluidSafeHandler,
        moonwellHandler,
        debtSwap,
        safeModuleDebtSwap,
        leveragedPosition,
    };
});
