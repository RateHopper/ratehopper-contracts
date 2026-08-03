import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { AbiCoder } from "ethers";
import TimelockControllerModule from "./TimelockControllerModule";
import {
    AERODROME_CL_FACTORY_ADDRESS,
    AERODROME_SLIPSTREAM_NPM_ADDRESS,
    AERODROME_SLIPSTREAM_SWAP_ROUTER_ADDRESS,
    PROTOCOL_REGISTRY_ADDRESS,
    UNISWAP_V3_FACTORY_ADDRESS,
    UNISWAP_V3_NPM_ADDRESS,
    UNISWAP_V3_SWAP_ROUTER_ADDRESS,
    USDC_ADDRESS,
    WETH_ADDRESS,
    YieldProtocol,
} from "../../contractAddresses";
import { envBigInt, envNumber, envString, makeRequireAddress } from "./deployHelpers";

const requireAddress = makeRequireAddress("DeployYieldManager");

const abi = AbiCoder.defaultAbiCoder();

const UNISWAP_V3 = YieldProtocol.UNISWAP_V3;
const AERODROME = YieldProtocol.AERODROME;

// Default pool-param allow-lists, matching the standalone helpers' deploy
// defaults: Uniswap V3 fee tiers {100, 500, 3000} (10000 deliberately
// excluded — thin pool, cheap slot0 manipulation); Aerodrome Slipstream tick
// spacings {100, 200}.
const UNIV3_POOL_PARAMS = [100, 500, 3000].map((feeTier) => abi.encode(["uint24"], [feeTier]));
const AERODROME_POOL_PARAMS = [100, 200].map((tickSpacing) => abi.encode(["int24"], [tickSpacing]));

/**
 * Deployment module for the yield adapter stack (AP-4817):
 *   UniV3YieldHandler + AerodromeYieldHandler + SafeYieldManager.
 *
 * SafeYieldManager is the ONLY contract users enable as a Safe module; the
 * handlers are stateless delegatecall targets registered in its constructor.
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
 *
 * Usage:
 *   npx hardhat ignition deploy ignition/modules/4_DeployYieldManager.ts \
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

    const uniV3YieldHandler = m.contract("UniV3YieldHandler", [
        UNISWAP_V3_NPM_ADDRESS,
        USDC_ADDRESS,
        WETH_ADDRESS,
        UNISWAP_V3_SWAP_ROUTER_ADDRESS,
        UNISWAP_V3_FACTORY_ADDRESS,
    ]);

    const aerodromeYieldHandler = m.contract("AerodromeYieldHandler", [
        AERODROME_SLIPSTREAM_NPM_ADDRESS,
        USDC_ADDRESS,
        WETH_ADDRESS,
        AERODROME_SLIPSTREAM_SWAP_ROUTER_ADDRESS,
        AERODROME_CL_FACTORY_ADDRESS,
    ]);

    const safeYieldManager = m.contract(
        "SafeYieldManager",
        [
            registry,
            USDC_ADDRESS,
            [UNISWAP_V3, AERODROME],
            [uniV3YieldHandler, aerodromeYieldHandler],
            [UNIV3_POOL_PARAMS, AERODROME_POOL_PARAMS],
            [uniV3MinPoolLiquidity, aerodromeMinPoolLiquidity],
            [uniV3MinPositionLiquidity, aerodromeMinPositionLiquidity],
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

    return { uniV3YieldHandler, aerodromeYieldHandler, safeYieldManager, ...(timelock ? { timelock } : {}) };
});
