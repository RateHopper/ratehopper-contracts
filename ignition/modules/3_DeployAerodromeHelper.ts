import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import TimelockControllerModule from "./TimelockControllerModule";
import {
    AERODROME_CL_FACTORY_ADDRESS,
    AERODROME_SLIPSTREAM_NPM_ADDRESS,
    AERODROME_SLIPSTREAM_SWAP_ROUTER_ADDRESS,
    PROTOCOL_REGISTRY_ADDRESS,
    USDC_ADDRESS,
    WETH_ADDRESS,
} from "../../contractAddresses";
import { envBigInt, envNumber, envString, makeRequireAddress } from "./deployHelpers";

const requireAddress = makeRequireAddress("DeployAerodromeHelper");

/**
 * Combined deployment module for TimelockController + RatehopperAerodromePositions.
 *
 * A sibling of `2_DeployUniV3Helper.ts` for the Aerodrome Slipstream (CL)
 * WETH/USDC LP helper. Shares the same TimelockController via the
 * `TimelockControllerModule` sub-module (deduplicated by Ignition across runs),
 * so whichever deploy command runs first owns the deployment and the later
 * command(s) reuse that same address. To point the helper at a pre-existing
 * timelock, set `RHP_TIMELOCK` — when present, this module skips the sub-module
 * path and uses the literal address directly.
 *
 * Environment variables — resolution order is RHA_* module override, then
 * the unprefixed name shared by all yield deploy modules, then a legacy
 * RHP_* fallback (addresses only), then the default. Empty values (X=)
 * count as unset:
 *  - RHA_REGISTRY / REGISTRY:   ProtocolRegistry address. Falls back to
 *                               `PROTOCOL_REGISTRY_ADDRESS`.
 *  - RHA_TREASURY / TREASURY:   Treasury address that collects fees. Required.
 *  - RHA_INITIAL_ADMIN / INITIAL_ADMIN: DEFAULT_ADMIN_ROLE holder. Falls back
 *                               to ADMIN_ADDRESS. Required.
 *  - RHA_TIMELOCK / RHP_TIMELOCK: Pre-deployed TimelockController to reuse
 *                               (shared with the UniV3 helper). When set,
 *                               SKIPS the shared sub-module entirely.
 *  - TIMELOCK_ADMIN / TIMELOCK_DELAY: consumed by TimelockControllerModule.
 *  - RHA_PERFORMANCE_FEE_BPS / PERFORMANCE_FEE_BPS: Performance fee on net
 *                               profit at closeLp in bps. Defaults to 1000 (10%).
 *  - RHA_FEE_COLLECT_BPS / FEE_COLLECT_BPS: Fee on harvested LP fees in bps.
 *                               Defaults to 250 (2.5%).
 *  - RHA_MAX_FEE_BPS / MAX_FEE_BPS: Hard upper bound on BOTH fees. Defaults
 *                               to 2000 (20%).
 *  - RHA_MIN_POSITION_LIQUIDITY / MIN_POSITION_LIQUIDITY: Floor on NPM `mint`
 *                               liquidity. Defaults to 10000. Set 0 to disable.
 *  - RHA_MIN_POOL_LIQUIDITY / MIN_POOL_LIQUIDITY: Floor on `pool.liquidity()`
 *                               for any pool a spot price is read from.
 *                               Defaults to 0 (disabled); measure the target
 *                               CL WETH/USDC pool's in-range `liquidity()` and
 *                               set a conservative fraction here or via
 *                               post-deploy `setMinPoolLiquidity`.
 *  - DEPLOYER_PRIVATE_KEY:      Deployer key (set in hardhat.config.ts).
 *
 * Usage:
 *   npx hardhat ignition deploy ignition/modules/3_DeployAerodromeHelper.ts \
 *     --network base --verify
 */
export default buildModule("DeployAerodromeHelper", (m) => {
    // ── Timelock ───────────────────────────────────────────────────────────
    // Reuse the shared TimelockController unless `RHP_TIMELOCK` pins a literal
    // address. Ignition keys futures by `<moduleName>#<contractName>`, so the
    // sub-module's `TimelockControllerModule#TimelockController` is the same
    // future the other deploy modules reference and is deduplicated across runs.
    const reuseTimelockAddr = envString("RHA_TIMELOCK", "RHP_TIMELOCK");

    const timelock = reuseTimelockAddr ? undefined : m.useModule(TimelockControllerModule).timelock;

    const timelockArg: any = timelock ?? reuseTimelockAddr;

    // ── RHA ────────────────────────────────────────────────────────────────
    // Module-specific RHA_* overrides win; unprefixed names are shared with
    // the other yield deploy modules (RHP_* kept as a legacy fallback).
    const registryAddr = envString("RHA_REGISTRY", "REGISTRY", "RHP_REGISTRY") || PROTOCOL_REGISTRY_ADDRESS;
    const treasuryAddr = envString("RHA_TREASURY", "TREASURY", "RHP_TREASURY");
    const initialAdminAddr = envString("RHA_INITIAL_ADMIN", "INITIAL_ADMIN", "ADMIN_ADDRESS");

    requireAddress("registry (RHA_REGISTRY / REGISTRY / PROTOCOL_REGISTRY_ADDRESS)", registryAddr);
    requireAddress("treasury (RHA_TREASURY / TREASURY)", treasuryAddr);
    requireAddress("initialAdmin (RHA_INITIAL_ADMIN / INITIAL_ADMIN / ADMIN_ADDRESS)", initialAdminAddr);
    requireAddress("slipstream NPM (AERODROME_SLIPSTREAM_NPM_ADDRESS)", AERODROME_SLIPSTREAM_NPM_ADDRESS);
    requireAddress(
        "slipstream swap router (AERODROME_SLIPSTREAM_SWAP_ROUTER_ADDRESS)",
        AERODROME_SLIPSTREAM_SWAP_ROUTER_ADDRESS,
    );
    requireAddress("CL factory (AERODROME_CL_FACTORY_ADDRESS)", AERODROME_CL_FACTORY_ADDRESS);
    if (reuseTimelockAddr) requireAddress("timelock (RHP_TIMELOCK)", reuseTimelockAddr);

    const registry = m.getParameter<string>("registry", registryAddr);
    const treasury = m.getParameter<string>("treasury", treasuryAddr);
    const initialAdmin = m.getParameter<string>("initialAdmin", initialAdminAddr);
    const performanceFeeBps = m.getParameter<number>(
        "performanceFeeBps",
        envNumber(1000, "RHA_PERFORMANCE_FEE_BPS", "PERFORMANCE_FEE_BPS"),
    );
    const feeCollectBps = m.getParameter<number>(
        "feeCollectBps",
        envNumber(250, "RHA_FEE_COLLECT_BPS", "FEE_COLLECT_BPS"),
    );
    const maxFeeBps = m.getParameter<number>("maxFeeBps", envNumber(2000, "RHA_MAX_FEE_BPS", "MAX_FEE_BPS"));
    const minPositionLiquidity = m.getParameter<bigint>(
        "minPositionLiquidity",
        envBigInt(10_000n, "RHA_MIN_POSITION_LIQUIDITY", "MIN_POSITION_LIQUIDITY"),
    );
    const minPoolLiquidity = m.getParameter<bigint>(
        "minPoolLiquidity",
        envBigInt(0n, "RHA_MIN_POOL_LIQUIDITY", "MIN_POOL_LIQUIDITY"),
    );

    const ratehopperAerodromePositions = m.contract(
        "RatehopperAerodromePositions",
        [
            AERODROME_SLIPSTREAM_NPM_ADDRESS,
            registry,
            USDC_ADDRESS,
            WETH_ADDRESS,
            AERODROME_SLIPSTREAM_SWAP_ROUTER_ADDRESS,
            AERODROME_CL_FACTORY_ADDRESS,
            treasury,
            performanceFeeBps,
            feeCollectBps,
            maxFeeBps,
            initialAdmin,
            timelockArg,
            minPoolLiquidity,
            minPositionLiquidity,
        ],
        timelock ? { after: [timelock] } : undefined,
    );

    return { ratehopperAerodromePositions, ...(timelock ? { timelock } : {}) };
});
