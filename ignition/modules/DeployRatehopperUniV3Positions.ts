import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import {
    PROTOCOL_REGISTRY_ADDRESS,
    UNISWAP_V3_FACTORY_ADDRESS,
    UNISWAP_V3_NPM_ADDRESS,
    UNISWAP_V3_SWAP_ROUTER_ADDRESS,
    USDC_ADDRESS,
    WETH_ADDRESS,
} from "../../contractAddresses";

/**
 * Combined deployment module for TimelockController + RatehopperUniV3Positions.
 *
 * By default deploys a fresh TimelockController (2-day delay, admin EOA as
 * both proposer and executor, no separate admin) and wires its address into
 * RHP's `_timelock` constructor arg. To reuse an existing timelock, set
 * `RHP_TIMELOCK` — when present, the module skips the timelock deployment
 * and points RHP at the supplied address instead.
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
 *                               When set, SKIPS the new timelock deployment.
 *  - TIMELOCK_ADMIN:            EOA / multisig set as BOTH proposer AND
 *                               executor on the new timelock. Falls back to
 *                               ADMIN_ADDRESS. Required when RHP_TIMELOCK
 *                               is unset.
 *  - TIMELOCK_DELAY:            Minimum delay in seconds before a queued tx
 *                               can be executed. Defaults to 172800 (2 days).
 *                               Lower this for testnet only.
 *  - RHP_PERFORMANCE_FEE_BPS:   Performance fee on net profit at closeLp in
 *                               bps. Defaults to 1000 (10%).
 *  - RHP_FEE_COLLECT_BPS:       Fee on harvested LP fees in bps. Defaults to
 *                               250 (2.5%).
 *  - RHP_MAX_FEE_BPS:           Hard upper bound on BOTH fees. Defaults to
 *                               2000 (20%).
 *  - DEPLOYER_PRIVATE_KEY:      Deployer key (set in hardhat.config.ts).
 *
 * Usage:
 *   npx hardhat ignition deploy ignition/modules/DeployRatehopperUniV3Positions.ts \
 *     --network base --verify
 */
export default buildModule("DeployRatehopperUniV3Positions", (m) => {
    const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
    const TWO_DAYS = 2 * 24 * 60 * 60;

    // ── Timelock (deploy fresh OR reuse via RHP_TIMELOCK) ──────────────────
    const reuseTimelockAddr = process.env.RHP_TIMELOCK ?? "";
    const timelockAdmin = m.getParameter<string>(
        "timelockAdmin",
        process.env.TIMELOCK_ADMIN ?? process.env.ADMIN_ADDRESS ?? "",
    );
    const timelockDelay = m.getParameter<number>(
        "timelockDelay",
        Number(process.env.TIMELOCK_DELAY ?? TWO_DAYS),
    );

    const timelock = reuseTimelockAddr
        ? undefined
        : m.contract("TimelockController", [
              timelockDelay,
              [timelockAdmin], // proposers
              [timelockAdmin], // executors
              ZERO_ADDRESS, // no separate admin — timelock holds DEFAULT_ADMIN_ROLE on itself
          ]);

    // Concrete address used for the RHP constructor arg: either the future
    // newly-deployed timelock (Ignition resolves the address) or the literal
    // `RHP_TIMELOCK` pin.
    const timelockArg: any = timelock ?? reuseTimelockAddr;

    // ── RHP ────────────────────────────────────────────────────────────────
    const registry = m.getParameter<string>("registry", process.env.RHP_REGISTRY ?? PROTOCOL_REGISTRY_ADDRESS);
    const treasury = m.getParameter<string>("treasury", process.env.RHP_TREASURY ?? "");
    const initialAdmin = m.getParameter<string>(
        "initialAdmin",
        process.env.RHP_INITIAL_ADMIN ?? process.env.ADMIN_ADDRESS ?? "",
    );
    const performanceFeeBps = m.getParameter<number>(
        "performanceFeeBps",
        Number(process.env.RHP_PERFORMANCE_FEE_BPS ?? 1000),
    );
    const feeCollectBps = m.getParameter<number>("feeCollectBps", Number(process.env.RHP_FEE_COLLECT_BPS ?? 250));
    const maxFeeBps = m.getParameter<number>("maxFeeBps", Number(process.env.RHP_MAX_FEE_BPS ?? 2000));

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
        ],
        timelock ? { after: [timelock] } : undefined,
    );

    return timelock ? { timelock, ratehopperUniV3Positions } : { ratehopperUniV3Positions };
});
