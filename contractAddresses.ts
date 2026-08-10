import { AbiCoder } from "ethers";

// Token addresses
export const WETH_ADDRESS = "0x4200000000000000000000000000000000000006";
export const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Circle
export const USDbC_ADDRESS = "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA"; // Coinbase
export const cbETH_ADDRESS = "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22";
export const cbBTC_ADDRESS = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf";
export const DAI_ADDRESS = "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb";
export const AERO_ADDRESS = "0x940181a94a35a4569e4529a3cdfb74e38fd98631";
export const wstETH_ADDRESS = "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452";
export const rETH_ADDRESS = "0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c";
export const weETH_ADDRESS = "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A";
export const EURC_ADDRESS = "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42";
export const wrsETH_ADDRESS = "0xedfa23602d0ec14714057867a78d01e94176bea0";
export const WELL_ADDRESS = "0xA88594D404727625A9437C3f886C7643872296AE";
export const USDS_ADDRESS = "0x820c137fa70c8691f0e44dc420a5e53c168921dc";
export const tBTC_ADDRESS = "0x236aa50979d5f3de3bd1eeb40e81137f22ab794b";
export const LBTC_ADDRESS = "0xecAc9C5F704e954931349Da37F60E39f515c11c1";
export const VIRTUAL_ADDRESS = "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b";
export const eUSD_ADDRESS = "0xCfA3Ef56d303AE4fAabA0592388F19d7C3399FB4";
export const MAI_ADDRESS = "0xbf1aeA8670D2528E08334083616dD9C5F3B087aE";
export const sUSDS_ADDRESS = "0x5875eee11cf8398102fdad704c9e96607675467a";
export const GHO_ADDRESS = "0x6Bb7a212910682DCFdbd5BCBb3e28FB4E8da10Ee";

// Uniswap V3
export const UNISWAP_V3_FACTORY_ADDRESS = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD";
export const UNISWAP_V3_NPM_ADDRESS = "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1";
export const UNISWAP_V3_SWAP_ROUTER_ADDRESS = "0x2626664c2603336E57B271c5C0b26F421741e481";

// Aerodrome Slipstream (CL) — the concentrated-liquidity product (NOT the V2
// AMM `IRouter`). Used by AerodromeYieldHandler for WETH/USDC LPs. The
// canonical contracts and live WETH/USDC spacing-100 pool are also
// exercised by test/yield/safeYieldManagerAerodromeFork.ts on a pinned Base fork.
export const AERODROME_CL_FACTORY_ADDRESS = "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A";
export const AERODROME_SLIPSTREAM_NPM_ADDRESS = "0x827922686190790b37229fd06084350E74485b72";
export const AERODROME_SLIPSTREAM_SWAP_ROUTER_ADDRESS = "0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5";
// Aerodrome Voter — canonical pool -> stake pool registry. AerodromeYieldHandler
// resolves the stakePool to stake into (open) / withdraw from (close) via
// `VOTER.gauges(pool)` (verified: gauges(WETH/USDC spacing-100 pool) is live).
export const AERODROME_VOTER_ADDRESS = "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5";

// Uniswap V4 — singleton architecture: pools live inside the PoolManager and
// are identified by PoolId = keccak256(abi.encode(PoolKey)), not by a pool
// address. Reads go through StateView; LP through the V4 PositionManager
// (ERC-721, pulls ERC20s via Permit2); swaps through the UniversalRouter.
// Native ETH pools use currency0 == address(0). Addresses verified against
// the official Uniswap deployments page and live on-chain reads.
export const UNISWAP_V4_POOL_MANAGER_ADDRESS = "0x498581fF718922c3f8e6A244956aF099B2652b2b";
export const UNISWAP_V4_POSITION_MANAGER_ADDRESS = "0x7C5f5A4bBd8fD63184577525326123B519429bDc";
export const UNISWAP_V4_STATE_VIEW_ADDRESS = "0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71";
export const UNISWAP_V4_QUOTER_ADDRESS = "0x0d5e0F971ED27FBfF6c2837bf31316121532048D";
export const UNIVERSAL_ROUTER_ADDRESS = "0x6fF5693b99212Da76ad316178A184AB56D299b43";
// NOTE: Base uses this Permit2 deployment (verified on-chain via
// PositionManager.permit2()), NOT the older 0x...72F4d96f8 address.
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

// Paraswap
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
export const ADMIN_ADDRESS = "0xc74fc973A0740Ca1ED6f8F31Ed56003A13D4F5F1";

// RateHopper canonical Base deployments — referenced by downstream deploys
// (e.g. 2_DeployYieldManager reads PROTOCOL_REGISTRY_ADDRESS to wire
// SafeYieldManager to the existing registry).
//
// AUTO-MANAGED: registry/core deploy scripts run scripts/syncRegistryAddress.js,
// rewriting the address below to the configured
// ProtocolRegistry. Commit the resulting diff. Only edit by hand if pointing at
// a registry deployed outside this repo's Ignition flow.
export const PROTOCOL_REGISTRY_ADDRESS = "0x2f1331Df43E2f63e01298f570F9e467375077d7d";

// DebtProtocol enum
export enum DebtProtocol {
    AAVE_V3,
    COMPOUND,
    MORPHO,
    FLUID,
    MOONWELL,
}

// Mirrors the YIELD_PROTOCOL_* uint8 id constants in contracts/Types.sol (append-only)
export enum YieldProtocol {
    UNISWAP_V3,
    AERODROME,
    UNISWAP_V4,
}

// SafeYieldManager pool params carry the pair: abi.encode(token0, token1, key).
// These are THE encoding points — ignition, scripts, and tests must all agree
// with the handlers' _decodePoolParam, so never hand-roll the encode elsewhere.
export function encodeUniV3PoolParam(token0: string, token1: string, feeTier: number | bigint): string {
    return AbiCoder.defaultAbiCoder().encode(["address", "address", "uint24"], [token0, token1, feeTier]);
}

export function encodeAerodromePoolParam(token0: string, token1: string, tickSpacing: number | bigint): string {
    return AbiCoder.defaultAbiCoder().encode(["address", "address", "int24"], [token0, token1, tickSpacing]);
}

// Uniswap V4 pool param is the full PoolKey tuple, so keccak256 of it IS the
// V4 PoolId. Native ETH pools use currency0 = ZeroAddress; hookless pools use
// hooks = ZeroAddress (hooked pools are gated by the admin allow-list only).
export function encodeUniV4PoolParam(
    currency0: string,
    currency1: string,
    fee: number | bigint,
    tickSpacing: number | bigint,
    hooks: string,
): string {
    return AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "uint24", "int24", "address"],
        [currency0, currency1, fee, tickSpacing, hooks],
    );
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
