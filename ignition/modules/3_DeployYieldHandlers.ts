import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import {
    AERODROME_CL_FACTORY_ADDRESS,
    AERODROME_SLIPSTREAM_NPM_ADDRESS,
    AERODROME_SLIPSTREAM_SWAP_ROUTER_ADDRESS,
    AERODROME_VOTER_ADDRESS,
    PERMIT2_ADDRESS,
    UNISWAP_V3_FACTORY_ADDRESS,
    UNISWAP_V3_NPM_ADDRESS,
    UNISWAP_V3_SWAP_ROUTER_ADDRESS,
    UNISWAP_V4_POSITION_MANAGER_ADDRESS,
    UNISWAP_V4_STATE_VIEW_ADDRESS,
    UNIVERSAL_ROUTER_ADDRESS,
    USDC_ADDRESS,
    WETH_ADDRESS,
} from "../../contractAddresses";
import { envNumber } from "./deployHelpers";

/**
 * Deploys ONLY the three yield handlers, for registration on the EXISTING
 * SafeYieldManager through the timelock (scripts/timelockSetYieldHandlers.ts).
 *
 * Use this to ship a handler change — e.g. the mint-time price guard
 * (MintPriceGuard) — without a new manager: users keep the module they
 * enabled, and existing positions keep closing through the handler pinned at
 * open time. Only new opens and switch destinations use the new handlers.
 *
 * Environment:
 *  - SYM_MAX_MINT_DEVIATION_TICKS / MAX_MINT_DEVIATION_TICKS: see
 *    2_DeployYieldManager.ts. Default 200 (~2%).
 *
 * Usage:
 *   npx hardhat ignition deploy ignition/modules/3_DeployYieldHandlers.ts \
 *     --network base --verify
 */
export default buildModule("DeployYieldHandlers", (m) => {
    const maxMintDeviationTicks = m.getParameter<number>(
        "maxMintDeviationTicks",
        envNumber(200, "SYM_MAX_MINT_DEVIATION_TICKS", "MAX_MINT_DEVIATION_TICKS"),
    );

    const uniV3YieldHandler = m.contract("UniV3YieldHandler", [
        UNISWAP_V3_NPM_ADDRESS,
        USDC_ADDRESS,
        UNISWAP_V3_SWAP_ROUTER_ADDRESS,
        UNISWAP_V3_FACTORY_ADDRESS,
        maxMintDeviationTicks,
    ]);

    const aerodromeYieldHandler = m.contract("AerodromeYieldHandler", [
        AERODROME_SLIPSTREAM_NPM_ADDRESS,
        USDC_ADDRESS,
        AERODROME_SLIPSTREAM_SWAP_ROUTER_ADDRESS,
        AERODROME_CL_FACTORY_ADDRESS,
        AERODROME_VOTER_ADDRESS,
        maxMintDeviationTicks,
    ]);

    const uniV4YieldHandler = m.contract("UniV4YieldHandler", [
        UNISWAP_V4_POSITION_MANAGER_ADDRESS,
        UNIVERSAL_ROUTER_ADDRESS,
        PERMIT2_ADDRESS,
        UNISWAP_V4_STATE_VIEW_ADDRESS,
        USDC_ADDRESS,
        WETH_ADDRESS,
        maxMintDeviationTicks,
    ]);

    return { uniV3YieldHandler, aerodromeYieldHandler, uniV4YieldHandler };
});
