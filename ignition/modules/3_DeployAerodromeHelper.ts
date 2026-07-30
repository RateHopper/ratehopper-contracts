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
import { makeRequireAddress } from "./deployHelpers";

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
 * Environment variables (same surface as the UniV3 helper):
 *  - RHA_REGISTRY:              ProtocolRegistry address. Falls back to
 *                               `PROTOCOL_REGISTRY_ADDRESS`.
 *  - RHA_TREASURY:              Treasury address that collects fees. Required.
 *  - RHA_INITIAL_ADMIN:         DEFAULT_ADMIN_ROLE holder. Falls back to
 *                               ADMIN_ADDRESS. Required.
 *  - RHP_TIMELOCK:              Pre-deployed TimelockController to reuse (shared
 *                               with the UniV3 helper). When set, SKIPS the
 *                               shared sub-module entirely.
 *  - TIMELOCK_ADMIN / TIMELOCK_DELAY: consumed by TimelockControllerModule.
 *  - RHA_PERFORMANCE_FEE_BPS:   Performance fee on net profit at closeLp in
 *                               bps. Defaults to 1000 (10%).
 *  - RHA_FEE_COLLECT_BPS:       Fee on harvested LP fees in bps. Defaults to
 *                               250 (2.5%).
 *  - RHA_MAX_FEE_BPS:           Hard upper bound on BOTH fees. Defaults to
 *                               2000 (20%).
 *  - RHA_MIN_POSITION_LIQUIDITY: Floor on NPM `mint` liquidity. Defaults to
 *                               10000. Set 0 to disable.
 *  - RHA_MIN_POOL_LIQUIDITY:    Floor on `pool.liquidity()` for any pool a spot
 *                               price is read from. Defaults to 0 (disabled);
 *                               measure the target CL WETH/USDC pool's in-range
 *                               `liquidity()` and set a conservative fraction
 *                               here or via post-deploy `setMinPoolLiquidity`.
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
    const reuseTimelockAddr = process.env.RHP_TIMELOCK ?? "";

    const timelock = reuseTimelockAddr ? undefined : m.useModule(TimelockControllerModule).timelock;

    const timelockArg: any = timelock ?? reuseTimelockAddr;

    // ── RHA ────────────────────────────────────────────────────────────────
    const registryAddr = process.env.RHA_REGISTRY ?? PROTOCOL_REGISTRY_ADDRESS;
    const treasuryAddr = process.env.RHA_TREASURY ?? process.env.RHP_TREASURY ?? "";
    const initialAdminAddr = process.env.RHA_INITIAL_ADMIN ?? process.env.ADMIN_ADDRESS ?? "";

    requireAddress("registry (RHA_REGISTRY / PROTOCOL_REGISTRY_ADDRESS)", registryAddr);
    requireAddress("treasury (RHA_TREASURY)", treasuryAddr);
    requireAddress("initialAdmin (RHA_INITIAL_ADMIN / ADMIN_ADDRESS)", initialAdminAddr);
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
        Number(process.env.RHA_PERFORMANCE_FEE_BPS ?? 1000),
    );
    const feeCollectBps = m.getParameter<number>("feeCollectBps", Number(process.env.RHA_FEE_COLLECT_BPS ?? 250));
    const maxFeeBps = m.getParameter<number>("maxFeeBps", Number(process.env.RHA_MAX_FEE_BPS ?? 2000));
    const minPositionLiquidity = m.getParameter<bigint>(
        "minPositionLiquidity",
        BigInt(process.env.RHA_MIN_POSITION_LIQUIDITY ?? 10_000),
    );
    const minPoolLiquidity = m.getParameter<bigint>(
        "minPoolLiquidity",
        BigInt(process.env.RHA_MIN_POOL_LIQUIDITY ?? 0),
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
