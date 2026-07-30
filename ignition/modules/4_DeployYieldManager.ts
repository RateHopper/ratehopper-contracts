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
import { makeRequireAddress } from "./deployHelpers";

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
 * Coexists with the previously deployed standalone
 * RatehopperUniV3Positions / RatehopperAerodromePositions — existing
 * positions keep closing through those; new positions open here.
 *
 * Environment variables (SYM_* falls back to the RHP_* equivalent so a .env
 * already configured for the standalone helpers keeps working):
 *  - SYM_REGISTRY / RHP_REGISTRY:            ProtocolRegistry address.
 *  - SYM_TREASURY / RHP_TREASURY:            Fee treasury. Required.
 *  - SYM_INITIAL_ADMIN / RHP_INITIAL_ADMIN / ADMIN_ADDRESS: DEFAULT_ADMIN_ROLE holder. Required.
 *  - SYM_PAUSER / RHP_PAUSER / ADMIN_ADDRESS: pauser address. Required.
 *  - SYM_TIMELOCK / RHP_TIMELOCK:            Pre-deployed TimelockController to
 *                                            reuse; unset → shared TimelockControllerModule.
 *  - SYM_PERFORMANCE_FEE_BPS:                Default 1000 (10%).
 *  - SYM_FEE_COLLECT_BPS:                    Default 250 (2.5%).
 *  - SYM_MAX_FEE_BPS:                        Default 2000 (20%).
 *  - SYM_MIN_POSITION_LIQUIDITY:             Per-protocol mint-liquidity floor. Default 10000.
 *  - SYM_MIN_POOL_LIQUIDITY:                 Per-protocol pool-liquidity floor. Default 0 (disabled);
 *                                            tune post-deploy via setMinPoolLiquidity.
 *
 * Usage:
 *   npx hardhat ignition deploy ignition/modules/4_DeployYieldManager.ts \
 *     --network base --verify
 */
export default buildModule("DeployYieldManager", (m) => {
    const reuseTimelockAddr = process.env.SYM_TIMELOCK ?? process.env.RHP_TIMELOCK ?? "";
    const timelock = reuseTimelockAddr ? undefined : m.useModule(TimelockControllerModule).timelock;
    const timelockArg: any = timelock ?? reuseTimelockAddr;

    const registryAddr = process.env.SYM_REGISTRY ?? process.env.RHP_REGISTRY ?? PROTOCOL_REGISTRY_ADDRESS;
    const treasuryAddr = process.env.SYM_TREASURY ?? process.env.RHP_TREASURY ?? "";
    const initialAdminAddr =
        process.env.SYM_INITIAL_ADMIN ?? process.env.RHP_INITIAL_ADMIN ?? process.env.ADMIN_ADDRESS ?? "";
    const pauserAddr = process.env.SYM_PAUSER ?? process.env.RHP_PAUSER ?? process.env.ADMIN_ADDRESS ?? "";

    requireAddress("registry (SYM_REGISTRY / PROTOCOL_REGISTRY_ADDRESS)", registryAddr);
    requireAddress("treasury (SYM_TREASURY / RHP_TREASURY)", treasuryAddr);
    requireAddress("initialAdmin (SYM_INITIAL_ADMIN / ADMIN_ADDRESS)", initialAdminAddr);
    requireAddress("pauser (SYM_PAUSER / ADMIN_ADDRESS)", pauserAddr);
    if (reuseTimelockAddr) requireAddress("timelock (SYM_TIMELOCK / RHP_TIMELOCK)", reuseTimelockAddr);

    const registry = m.getParameter<string>("registry", registryAddr);
    const treasury = m.getParameter<string>("treasury", treasuryAddr);
    const initialAdmin = m.getParameter<string>("initialAdmin", initialAdminAddr);
    const pauser = m.getParameter<string>("pauser", pauserAddr);
    const performanceFeeBps = m.getParameter<number>(
        "performanceFeeBps",
        Number(process.env.SYM_PERFORMANCE_FEE_BPS ?? 1000),
    );
    const feeCollectBps = m.getParameter<number>("feeCollectBps", Number(process.env.SYM_FEE_COLLECT_BPS ?? 250));
    const maxFeeBps = m.getParameter<number>("maxFeeBps", Number(process.env.SYM_MAX_FEE_BPS ?? 2000));
    const minPositionLiquidity = m.getParameter<bigint>(
        "minPositionLiquidity",
        BigInt(process.env.SYM_MIN_POSITION_LIQUIDITY ?? 10_000),
    );
    const minPoolLiquidity = m.getParameter<bigint>(
        "minPoolLiquidity",
        BigInt(process.env.SYM_MIN_POOL_LIQUIDITY ?? 0),
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
            [minPoolLiquidity, minPoolLiquidity],
            [minPositionLiquidity, minPositionLiquidity],
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
