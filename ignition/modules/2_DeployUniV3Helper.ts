import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import TimelockControllerModule from "./TimelockControllerModule";
import {
    PROTOCOL_REGISTRY_ADDRESS,
    UNISWAP_V3_FACTORY_ADDRESS,
    UNISWAP_V3_NPM_ADDRESS,
    UNISWAP_V3_SWAP_ROUTER_ADDRESS,
    USDC_ADDRESS,
    WETH_ADDRESS,
} from "../../contractAddresses";
import { envBigInt, envNumber, envString, makeRequireAddress } from "./deployHelpers";

const requireAddress = makeRequireAddress("DeployUniV3Helper");

/**
 * Combined deployment module for TimelockController + RatehopperUniV3Positions.
 *
 * The TimelockController is delegated to the shared `TimelockControllerModule`
 * sub-module, which is ALSO consumed by `DeployCore`. Ignition deduplicates the
 * `TimelockControllerModule#TimelockController` future across runs via the
 * journal, so whichever deploy command runs first owns the deployment and the
 * later command(s) reuse that same address automatically. To bypass the shared
 * sub-module entirely and point RHP at a pre-existing (or externally deployed)
 * timelock, set `RHP_TIMELOCK` — when present, this module skips the
 * sub-module path and uses the literal address directly.
 *
 * Environment variables:
 *  - RHP_REGISTRY:              ProtocolRegistry address. If unset, falls back
 *                               to `PROTOCOL_REGISTRY_ADDRESS` in
 *                               `contractAddresses.ts` (canonical Base registry).
 *  - RHP_TREASURY:              Treasury address that collects fees. Required.
 *  - RHP_INITIAL_ADMIN:         DEFAULT_ADMIN_ROLE holder on RHP
 *                               (operational setters: rescueToken, etc.).
 *                               Falls back to ADMIN_ADDRESS. Required.
 *  - RHP_TIMELOCK:              Pre-deployed TimelockController to reuse.
 *                               When set, SKIPS the shared sub-module entirely.
 *  - TIMELOCK_ADMIN:            (consumed by TimelockControllerModule) EOA /
 *                               multisig set as BOTH proposer AND executor.
 *                               Falls back to ADMIN_ADDRESS. Required when
 *                               RHP_TIMELOCK is unset.
 *  - TIMELOCK_DELAY:            (consumed by TimelockControllerModule) Minimum
 *                               delay in seconds. Defaults to 28800 (8 hours).
 *  - RHP_PERFORMANCE_FEE_BPS:   Performance fee on net profit at closeLp in
 *                               bps. Defaults to 1000 (10%).
 *  - RHP_FEE_COLLECT_BPS:       Fee on harvested LP fees in bps. Defaults to
 *                               250 (2.5%).
 *  - RHP_MAX_FEE_BPS:           Hard upper bound on BOTH fees. Defaults to
 *                               2000 (20%).
 *  - RHP_MIN_POSITION_LIQUIDITY: Floor on NPM `mint` liquidity (L-2 / L-4
 *                               hardening). Defaults to 10000 — the exact
 *                               threshold below which a 1-bps partial close
 *                               can decrement basis while removing zero
 *                               liquidity. Real WETH/USDC positions carry L
 *                               orders of magnitude larger, so this default
 *                               never rejects a legitimate position while
 *                               fully closing the L-4 dust regime. Set 0 to
 *                               disable.
 *  - RHP_MIN_POOL_LIQUIDITY:    Floor on `pool.liquidity()` for any pool a
 *                               spot price is read from (I-3 / manipulation
 *                               hardening). Defaults to 0 (disabled) because
 *                               the safe value is pool- and market-dependent:
 *                               an over-aggressive floor bricks normal
 *                               operation. RUNBOOK: measure the target
 *                               WETH/USDC pool's in-range `liquidity()` and
 *                               set this to a conservative fraction (e.g.
 *                               ~25-50%) via this env var or post-deploy
 *                               `setMinPoolLiquidity` (DEFAULT_ADMIN_ROLE).
 *  - DEPLOYER_PRIVATE_KEY:      Deployer key (set in hardhat.config.ts).
 *
 * Usage:
 *   npx hardhat ignition deploy ignition/modules/2_DeployUniV3Helper.ts \
 *     --network base --verify
 */
export default buildModule("DeployUniV3Helper", (m) => {
    // ── Timelock ───────────────────────────────────────────────────────────
    // Three modes:
    //   1. `RHP_TIMELOCK` set  → reuse the supplied address (no deploy here).
    //   2. `RHP_TIMELOCK` unset → consume the shared TimelockControllerModule.
    //      Because Ignition keys futures by `<moduleName>#<contractName>`, the
    //      sub-module's `TimelockControllerModule#TimelockController` is the
    //      same future the `DeployCore` module references. The journal at
    //      `ignition/deployments/chain-<chainId>/` deduplicates across runs,
    //      so if `yarn deploy:1_core` already deployed it, `yarn deploy:2_univ3_helper` reuses
    //      that exact address.
    //   3. First-ever run → sub-module deploys it; params (TIMELOCK_ADMIN,
    //      TIMELOCK_DELAY) come from env vars inside TimelockControllerModule.
    const reuseTimelockAddr = envString("RHP_TIMELOCK");

    const timelock = reuseTimelockAddr ? undefined : m.useModule(TimelockControllerModule).timelock;

    // Concrete address used for the RHP constructor arg: either the
    // shared-sub-module future (Ignition resolves the address) or the literal
    // `RHP_TIMELOCK` pin.
    const timelockArg: any = timelock ?? reuseTimelockAddr;

    // ── RHP ────────────────────────────────────────────────────────────────
    // Module-specific RHP_* overrides win; unprefixed names are shared with
    // the other yield deploy modules (3_aerodrome_helper, 4_yield_manager).
    const registryAddr = envString("RHP_REGISTRY", "REGISTRY") || PROTOCOL_REGISTRY_ADDRESS;
    const treasuryAddr = envString("RHP_TREASURY", "TREASURY");
    const initialAdminAddr = envString("RHP_INITIAL_ADMIN", "INITIAL_ADMIN", "ADMIN_ADDRESS");

    requireAddress("registry (RHP_REGISTRY / REGISTRY / PROTOCOL_REGISTRY_ADDRESS)", registryAddr);
    requireAddress("treasury (RHP_TREASURY / TREASURY)", treasuryAddr);
    requireAddress("initialAdmin (RHP_INITIAL_ADMIN / INITIAL_ADMIN / ADMIN_ADDRESS)", initialAdminAddr);
    if (reuseTimelockAddr) requireAddress("timelock (RHP_TIMELOCK)", reuseTimelockAddr);

    const registry = m.getParameter<string>("registry", registryAddr);
    const treasury = m.getParameter<string>("treasury", treasuryAddr);
    const initialAdmin = m.getParameter<string>("initialAdmin", initialAdminAddr);
    const performanceFeeBps = m.getParameter<number>(
        "performanceFeeBps",
        envNumber(1000, "RHP_PERFORMANCE_FEE_BPS", "PERFORMANCE_FEE_BPS"),
    );
    const feeCollectBps = m.getParameter<number>(
        "feeCollectBps",
        envNumber(250, "RHP_FEE_COLLECT_BPS", "FEE_COLLECT_BPS"),
    );
    const maxFeeBps = m.getParameter<number>("maxFeeBps", envNumber(2000, "RHP_MAX_FEE_BPS", "MAX_FEE_BPS"));
    const minPositionLiquidity = m.getParameter<bigint>(
        "minPositionLiquidity",
        envBigInt(10_000n, "RHP_MIN_POSITION_LIQUIDITY", "MIN_POSITION_LIQUIDITY"),
    );
    const minPoolLiquidity = m.getParameter<bigint>(
        "minPoolLiquidity",
        envBigInt(0n, "RHP_MIN_POOL_LIQUIDITY", "MIN_POOL_LIQUIDITY"),
    );

    const ratehopperUniV3Positions = m.contract(
        "RatehopperUniV3Positions",
        [
            UNISWAP_V3_NPM_ADDRESS,
            registry,
            USDC_ADDRESS,
            WETH_ADDRESS,
            UNISWAP_V3_SWAP_ROUTER_ADDRESS,
            UNISWAP_V3_FACTORY_ADDRESS,
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

    return { ratehopperUniV3Positions, ...(timelock ? { timelock } : {}) };
});
