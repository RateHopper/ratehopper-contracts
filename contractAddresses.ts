import {
    USDbC_ADDRESS,
    WETH_ADDRESS,
    cbBTC_ADDRESS,
    cbETH_ADDRESS,
    DAI_ADDRESS,
    EURC_ADDRESS,
    LBTC_ADDRESS,
    rETH_ADDRESS,
    tBTC_ADDRESS,
    USDC_ADDRESS,
    USDS_ADDRESS,
    VIRTUAL_ADDRESS,
    weETH_ADDRESS,
    WELL_ADDRESS,
    wrsETH_ADDRESS,
    wstETH_ADDRESS,
    AERO_ADDRESS,
} from "./test/constants";

// Uniswap V3
export const UNISWAP_V3_FACTORY_ADRESS = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD";

// Paraswap
export const PARASWAP_ROUTER_ADDRESS = "0x59C7C832e96D2568bea6db468C1aAdcbbDa08A52";
export const PARASWAP_TOKEN_TRANSFER_PROXY_ADDRESS = "0x93aAAe79a53759cD164340E4C8766E4Db5331cD7";
export const PARASWAP_V6_CONTRACT_ADDRESS = "0x6a000f20005980200259b80c5102003040001068";

// Fluid
export const FLUID_VAULT_RESOLVER = "0x1500d70d8551b828f8fb56fa739c977d113444df";

// Aave V3
export const AAVE_V3_POOL_ADDRESS = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
export const AAVE_V3_DATA_PROVIDER_ADDRESS = "0xd82a47fdebB5bf5329b09441C3DaB4b5df2153Ad";

// Morpho
export const MORPHO_ADDRESS = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";

// Moonwell (Comptroller)
export const COMPTROLLER_ADDRESS = "0xfbb21d0380bee3312b33c4353c8936a0f13ef26c";

// Team owner wallet (for ownership transfer after deployment)
export const TEAM_OWNER_WALLET = "0xc74fc973A0740Ca1ED6f8F31Ed56003A13D4F5F1";

// Protocol enum
export enum Protocol {
    AAVE_V3,
    COMPOUND,
    MORPHO,
    FLUID,
    MOONWELL,
}

export const USDC_COMET_ADDRESS = "0xb125E6687d4313864e53df431d5425969c15Eb2F";
export const USDbC_COMET_ADDRESS = "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf";
export const WETH_COMET_ADDRESS = "0x46e6b214b524310239732D51387075E0e70970bf";
export const AERO_COMET_ADDRESS = "0x784efeB622244d2348d4F2522f8860B96fbEcE89";
export const USDS_COMET_ADDRESS = "0x2c776041CCFe903071AF44aa147368a9c8EEA518";

export const cometAddressMap = new Map<string, string>([
    [USDC_ADDRESS, USDC_COMET_ADDRESS],
    [USDbC_ADDRESS, USDbC_COMET_ADDRESS],
    [WETH_ADDRESS, WETH_COMET_ADDRESS],
    [AERO_ADDRESS, AERO_COMET_ADDRESS],
    [USDS_ADDRESS, USDS_COMET_ADDRESS],
]);

/**
 * Converts the cometAddressMap to two arrays format for batch setting
 * @returns [tokenAddresses, cometAddresses] - Arrays for use with batchSetTokenCContracts
 */
export function getCTokenMappingArrays(): [string[], string[]] {
    const tokenAddresses: string[] = [];
    const cometAddresses: string[] = [];

    cometAddressMap.forEach((cometAddress, tokenAddress) => {
        tokenAddresses.push(tokenAddress);
        cometAddresses.push(cometAddress);
    });

    return [tokenAddresses, cometAddresses];
}

// https://docs.moonwell.fi/moonwell/protocol-information/contracts#token-contract-addresses
export const mDAI = "0x73b06d8d18de422e269645eace15400de7462417";
export const mUSDC = "0xedc817a28e8b93b03976fbd4a3ddbc9f7d176c22";
export const mUSDbC = "0x703843C3379b52F9FF486c9f5892218d2a065cC8";
export const mWETH = "0x628ff693426583D9a7FB391E54366292F509D457";
export const mcbETH = "0x3bf93770f2d4a794c3d9ebefbaebae2a8f09a5e5";
export const mwstETH = "0x627Fe393Bc6EdDA28e99AE648fD6fF362514304b";
export const mrETH = "0xcb1dacd30638ae38f2b94ea64f066045b7d45f44";
export const mWeETH = "0xb8051464C8c92209C92F3a4CD9C73746C4c3CFb3";
export const mAERO = "0x73902f619CEB9B31FD8EFecf435CbDf89E369Ba6";
export const mcbBTC = "0xf877acafa28c19b96727966690b2f44d35ad5976";
export const mEURC = "0xb682c840B5F4FC58B20769E691A6fa1305A501a2";
export const mwrsETH = "0xfC41B49d064Ac646015b459C522820DB9472F4B5";
export const mWELL = "0xdC7810B47eAAb250De623F0eE07764afa5F71ED1";
export const mUSDS = "0xb6419c6C2e60c4025D6D06eE4F913ce89425a357";
export const mtBTC = "0x9A858ebfF1bEb0D3495BB0e2897c1528eD84A218";
export const mLBTC = "0x10fF57877b79e9bd949B3815220eC87B9fc5D2ee";
export const mVIRTUAL = "0xdE8Df9d942D78edE3Ca06e60712582F79CFfFC64";

export const mContractAddressMap = new Map<string, string>([
    [USDC_ADDRESS, mUSDC],
    [DAI_ADDRESS, mDAI],
    [cbETH_ADDRESS, mcbETH],
    [cbBTC_ADDRESS, mcbBTC],
    [wstETH_ADDRESS, mwstETH],
    [rETH_ADDRESS, mrETH],
    [weETH_ADDRESS, mWeETH],
    [AERO_ADDRESS, mAERO],
    [EURC_ADDRESS, mEURC],
    [wrsETH_ADDRESS, mwrsETH],
    [WELL_ADDRESS, mWELL],
    [USDS_ADDRESS, mUSDS],
    [tBTC_ADDRESS, mtBTC],
    [LBTC_ADDRESS, mLBTC],
    [VIRTUAL_ADDRESS, mVIRTUAL],
    [WETH_ADDRESS, mWETH],
]);

/**
 * Converts the mContractAddressMap to two arrays format for batch setting
 * @returns [tokenAddresses, mTokenAddresses] - Arrays for use with batchSetTokenMContracts
 */
export function getMTokenMappingArrays(): [string[], string[]] {
    const tokenAddresses: string[] = [];
    const mTokenAddresses: string[] = [];

    mContractAddressMap.forEach((mTokenAddress, tokenAddress) => {
        tokenAddresses.push(tokenAddress);
        mTokenAddresses.push(mTokenAddress);
    });

    return [tokenAddresses, mTokenAddresses];
}
