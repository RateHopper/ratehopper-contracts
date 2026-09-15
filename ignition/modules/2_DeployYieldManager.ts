import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import TimelockControllerModule from "./TimelockControllerModule";
import {
    AERODROME_CL_FACTORY_ADDRESS,
    AERODROME_SLIPSTREAM_NPM_ADDRESS,
    AERODROME_SLIPSTREAM_SWAP_ROUTER_ADDRESS,
    AERODROME_VOTER_ADDRESS,
    PERMIT2_ADDRESS,
    PROTOCOL_REGISTRY_ADDRESS,
    UNISWAP_V3_FACTORY_ADDRESS,
    UNISWAP_V3_NPM_ADDRESS,
    UNISWAP_V3_SWAP_ROUTER_ADDRESS,
    UNISWAP_V4_POSITION_MANAGER_ADDRESS,
    UNISWAP_V4_STATE_VIEW_ADDRESS,
    UNIVERSAL_ROUTER_ADDRESS,
    USDC_ADDRESS,
    WETH_ADDRESS,
    YieldProtocol,
    encodeAerodromePoolParam,
    encodeUniV3PoolParam,
    encodeUniV4PoolParam,
    TWAP_REF_WETH_USDC_POOL,
    TWAP_REF_AERO_USDC_POOL,
    TWAP_WINDOW,
    TWAP_CARDINALITY,
    AERO_ADDRESS,
} from "../../contractAddresses";
import { envBigInt, envNumber, envString, makeRequireAddress } from "./deployHelpers";

const requireAddress = makeRequireAddress("DeployYieldManager");

const UNISWAP_V3 = YieldProtocol.UNISWAP_V3;
const AERODROME = YieldProtocol.AERODROME;
const UNISWAP_V4 = YieldProtocol.UNISWAP_V4;

const NATIVE = "0x0000000000000000000000000000000000000000";

// Default pool-param allow-lists — pool params carry the pair:
// abi.encode(token0, token1, feeTier | tickSpacing). WETH/USDC pools with
// Uniswap V3 fee tiers {100, 500, 3000} (10000 deliberately excluded — thin
// pool, cheap slot0 manipulation); Aerodrome Slipstream tick spacings
// {100, 200}; the canonical hookless native ETH/USDC 0.05% Uniswap V4 pool.
// Price references are SEEDED AT CONSTRUCTION (see TWAP_SEEDS below), because
// `setTwapConfig` is timelock-critical: configuring after the fact would leave
// a freshly deployed manager open-enabled but unable to swap until a timelock
// proposal executed, days later. Seeding also lets the constructor hold its own
// allow-listed pool params to the same reference requirement `setPoolParamAllowed`
// applies, so "allow-listed implies a live reference" holds from block one.
//
// Every non-USDC side of every seeded pool param needs an entry: WETH, the
// native `address(0)` key used by V4 native pools (both point at the same
// WETH/USDC pool — WETH is substituted only for tick math), and AERO so staked
// Aerodrome emissions can be sold without waiting on the timelock. A native V4
// pool param requires BOTH the NATIVE and the WETH key (its withdraw leg hands
// the native side back wrapped). A seeded reference is validated live, so the
// deploy reverts rather than installing one that cannot answer — if the AERO
// pool happens to be quiet at deploy time, drop that entry and add it later by
// timelock; only WETH and NATIVE are load-bearing for the pool params seeded
// below.
//
// Additional pairs are allow-listed post-deploy via setPoolParamAllowed only
// after every non-USDC side has a live TWAP reference — which now means a
// timelock proposal for the reference first. Hooked V4 pool keys are admitted
// only through the timelocked allowHookedPoolParam, after the hook has been
// reviewed; routine setPoolParamAllowed (and this constructor) refuse them.
const UNIV3_POOL_PARAMS = [100, 500, 3000].map((feeTier) => encodeUniV3PoolParam(WETH_ADDRESS, USDC_ADDRESS, feeTier));
const AERODROME_POOL_PARAMS = [100, 200].map((tickSpacing) =>
    encodeAerodromePoolParam(WETH_ADDRESS, USDC_ADDRESS, tickSpacing),
);
const UNIV4_POOL_PARAMS = [encodeUniV4PoolParam(NATIVE, USDC_ADDRESS, 500, 10, NATIVE)];

const twapSeed = (token: string, pool: string) => ({
    token,
    config: { pool, window: TWAP_WINDOW, minCardinality: TWAP_CARDINALITY },
});
const TWAP_SEEDS = [
    twapSeed(WETH_ADDRESS, TWAP_REF_WETH_USDC_POOL),
    twapSeed(NATIVE, TWAP_REF_WETH_USDC_POOL),
    twapSeed(AERO_ADDRESS, TWAP_REF_AERO_USDC_POOL),
];

/**
 * Deployment module for the yield adapter stack (AP-4817):
 *   UniV3YieldHandler + AerodromeYieldHandler + UniV4YieldHandler
 *   + SafeYieldManager.
 *
 * SafeYieldManager is the ONLY contract users enable as a Safe module; the
 * handlers are stateless delegatecall targets registered in its constructor
 * (registration auto-enables open/close and seeds the pool allow-lists).
 * Coexists with the previously deployed standalone RatehopperUniV3Positions:
 * existing positions keep closing there; new positions open here.
 *
 * Environment variables — resolution order is SYM_* module override, then
 * the unprefixed name shared by all yield deploy modules, then a legacy
 * RHP_* fallback (addresses only), then the default. Empty values (X=)
 * count as unset:
 *  - SYM_REGISTRY / REGISTRY / RHP_REGISTRY: ProtocolRegistry address.
 *                                            Falls back to PROTOCOL_REGISTRY_ADDRESS.
 *  - SYM_TREASURY / TREASURY / RHP_TREASURY: Fee treasury. Required.
 *  - SYM_INITIAL_ADMIN / INITIAL_ADMIN / ADMIN_ADDRESS: DEFAULT_ADMIN_ROLE holder. Required.
 *  - SYM_PAUSER / PAUSER_ADDRESS / ADMIN_ADDRESS: Pauser address. Required.
 *  - SYM_TIMELOCK / RHP_TIMELOCK:            Pre-deployed TimelockController to
 *                                            reuse; unset → shared TimelockControllerModule.
 *  - SYM_PERFORMANCE_FEE_BPS / PERFORMANCE_FEE_BPS: Default 1000 (10%).
 *  - SYM_FEE_COLLECT_BPS / FEE_COLLECT_BPS:  Default 250 (2.5%).
 *  - SYM_MAX_FEE_BPS / MAX_FEE_BPS:          Default 2000 (20%).
 *  - SYM_UNIV3_MIN_POSITION_LIQUIDITY / SYM_AERODROME_MIN_POSITION_LIQUIDITY /
 *    MIN_POSITION_LIQUIDITY:                 Mint-liquidity floors. Default 10000.
 *  - SYM_UNIV3_MIN_POOL_LIQUIDITY / SYM_AERODROME_MIN_POOL_LIQUIDITY /
 *    MIN_POOL_LIQUIDITY:                     Pool-liquidity floors. Default 0 (disabled).
 *  - SYM_UNIV4_MIN_POSITION_LIQUIDITY / SYM_UNIV4_MIN_POOL_LIQUIDITY:
 *                                            Same floors for Uniswap V4.
 *  - SYM_UNIV4_POSITION_MANAGER / UNIV4_POSITION_MANAGER: V4 PositionManager.
 *  - SYM_UNIVERSAL_ROUTER / UNIVERSAL_ROUTER:             UniversalRouter.
 *  - SYM_PERMIT2 / PERMIT2:                               Permit2 (Base uses
 *                                                         0x...B43aC78BA3).
 *  - SYM_UNIV4_STATE_VIEW / UNIV4_STATE_VIEW:             StateView lens.
 *
 * Usage:
 *   npx hardhat ignition deploy ignition/modules/2_DeployYieldManager.ts \
 *     --network base --verify
 */
export default buildModule("DeployYieldManager", (m) => {
    const reuseTimelockAddr = envString("SYM_TIMELOCK", "RHP_TIMELOCK");
    const timelock = reuseTimelockAddr ? undefined : m.useModule(TimelockControllerModule).timelock;
    const timelockArg: any = timelock ?? reuseTimelockAddr;

    // Module-specific SYM_* overrides win; unprefixed names are shared with
    // the other yield deploy modules (RHP_* kept as a legacy fallback).
    const registryAddr = envString("SYM_REGISTRY", "REGISTRY", "RHP_REGISTRY") || PROTOCOL_REGISTRY_ADDRESS;
    const treasuryAddr = envString("SYM_TREASURY", "TREASURY", "RHP_TREASURY");
    const initialAdminAddr = envString("SYM_INITIAL_ADMIN", "INITIAL_ADMIN", "ADMIN_ADDRESS");
    const pauserAddr = envString("SYM_PAUSER", "PAUSER_ADDRESS", "ADMIN_ADDRESS");

    requireAddress("registry (SYM_REGISTRY / REGISTRY / PROTOCOL_REGISTRY_ADDRESS)", registryAddr);
    requireAddress("treasury (SYM_TREASURY / TREASURY)", treasuryAddr);
    requireAddress("initialAdmin (SYM_INITIAL_ADMIN / INITIAL_ADMIN / ADMIN_ADDRESS)", initialAdminAddr);
    requireAddress("pauser (SYM_PAUSER / PAUSER_ADDRESS / ADMIN_ADDRESS)", pauserAddr);
    if (reuseTimelockAddr) requireAddress("timelock (SYM_TIMELOCK / RHP_TIMELOCK)", reuseTimelockAddr);

    const registry = m.getParameter<string>("registry", registryAddr);
    const treasury = m.getParameter<string>("treasury", treasuryAddr);
    const initialAdmin = m.getParameter<string>("initialAdmin", initialAdminAddr);
    const pauser = m.getParameter<string>("pauser", pauserAddr);
    const performanceFeeBps = m.getParameter<number>(
        "performanceFeeBps",
        envNumber(1000, "SYM_PERFORMANCE_FEE_BPS", "PERFORMANCE_FEE_BPS"),
    );
    const feeCollectBps = m.getParameter<number>(
        "feeCollectBps",
        envNumber(250, "SYM_FEE_COLLECT_BPS", "FEE_COLLECT_BPS"),
    );
    const maxFeeBps = m.getParameter<number>("maxFeeBps", envNumber(2000, "SYM_MAX_FEE_BPS", "MAX_FEE_BPS"));
    const uniV3MinPositionLiquidity = m.getParameter<bigint>(
        "uniV3MinPositionLiquidity",
        envBigInt(10_000n, "SYM_UNIV3_MIN_POSITION_LIQUIDITY", "MIN_POSITION_LIQUIDITY"),
    );
    const aerodromeMinPositionLiquidity = m.getParameter<bigint>(
        "aerodromeMinPositionLiquidity",
        envBigInt(10_000n, "SYM_AERODROME_MIN_POSITION_LIQUIDITY", "MIN_POSITION_LIQUIDITY"),
    );
    const uniV3MinPoolLiquidity = m.getParameter<bigint>(
        "uniV3MinPoolLiquidity",
        envBigInt(0n, "SYM_UNIV3_MIN_POOL_LIQUIDITY", "MIN_POOL_LIQUIDITY"),
    );
    const aerodromeMinPoolLiquidity = m.getParameter<bigint>(
        "aerodromeMinPoolLiquidity",
        envBigInt(0n, "SYM_AERODROME_MIN_POOL_LIQUIDITY", "MIN_POOL_LIQUIDITY"),
    );
    const uniV4MinPositionLiquidity = m.getParameter<bigint>(
        "uniV4MinPositionLiquidity",
        envBigInt(10_000n, "SYM_UNIV4_MIN_POSITION_LIQUIDITY", "MIN_POSITION_LIQUIDITY"),
    );
    const uniV4MinPoolLiquidity = m.getParameter<bigint>(
        "uniV4MinPoolLiquidity",
        envBigInt(0n, "SYM_UNIV4_MIN_POOL_LIQUIDITY", "MIN_POOL_LIQUIDITY"),
    );

    const uniV4PositionManagerAddr =
        envString("SYM_UNIV4_POSITION_MANAGER", "UNIV4_POSITION_MANAGER") || UNISWAP_V4_POSITION_MANAGER_ADDRESS;
    const universalRouterAddr = envString("SYM_UNIVERSAL_ROUTER", "UNIVERSAL_ROUTER") || UNIVERSAL_ROUTER_ADDRESS;
    const permit2Addr = envString("SYM_PERMIT2", "PERMIT2") || PERMIT2_ADDRESS;
    const stateViewAddr = envString("SYM_UNIV4_STATE_VIEW", "UNIV4_STATE_VIEW") || UNISWAP_V4_STATE_VIEW_ADDRESS;

    requireAddress("uniV4PositionManager (SYM_UNIV4_POSITION_MANAGER)", uniV4PositionManagerAddr);
    requireAddress("universalRouter (SYM_UNIVERSAL_ROUTER)", universalRouterAddr);
    requireAddress("permit2 (SYM_PERMIT2)", permit2Addr);
    requireAddress("stateView (SYM_UNIV4_STATE_VIEW)", stateViewAddr);

    const uniV4PositionManager = m.getParameter<string>("uniV4PositionManager", uniV4PositionManagerAddr);
    const universalRouter = m.getParameter<string>("universalRouter", universalRouterAddr);
    const permit2 = m.getParameter<string>("permit2", permit2Addr);
    const stateView = m.getParameter<string>("stateView", stateViewAddr);

    const uniV3YieldHandler = m.contract("UniV3YieldHandler", [
        UNISWAP_V3_NPM_ADDRESS,
        USDC_ADDRESS,
        UNISWAP_V3_SWAP_ROUTER_ADDRESS,
        UNISWAP_V3_FACTORY_ADDRESS,
    ]);

    const aerodromeYieldHandler = m.contract("AerodromeYieldHandler", [
        AERODROME_SLIPSTREAM_NPM_ADDRESS,
        USDC_ADDRESS,
        AERODROME_SLIPSTREAM_SWAP_ROUTER_ADDRESS,
        AERODROME_CL_FACTORY_ADDRESS,
        AERODROME_VOTER_ADDRESS,
    ]);

    const uniV4YieldHandler = m.contract("UniV4YieldHandler", [
        uniV4PositionManager,
        universalRouter,
        permit2,
        stateView,
        USDC_ADDRESS,
        WETH_ADDRESS,
    ]);

    const safeYieldManager = m.contract(
        "SafeYieldManager",
        [
            registry,
            USDC_ADDRESS,
            WETH_ADDRESS,
            [UNISWAP_V3, AERODROME, UNISWAP_V4],
            [uniV3YieldHandler, aerodromeYieldHandler, uniV4YieldHandler],
            [UNIV3_POOL_PARAMS, AERODROME_POOL_PARAMS, UNIV4_POOL_PARAMS],
            [uniV3MinPoolLiquidity, aerodromeMinPoolLiquidity, uniV4MinPoolLiquidity],
            [uniV3MinPositionLiquidity, aerodromeMinPositionLiquidity, uniV4MinPositionLiquidity],
            TWAP_SEEDS,
            treasury,
            performanceFeeBps,
            feeCollectBps,
            maxFeeBps,
            initialAdmin,
            timelockArg,
            pauser,
        ],
        timelock ? { after: [timelock] } : undefined,
    );

    return {
        uniV3YieldHandler,
        aerodromeYieldHandler,
        uniV4YieldHandler,
        safeYieldManager,
        ...(timelock ? { timelock } : {}),
    };
});
