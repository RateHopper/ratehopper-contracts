import { ethers, network } from "hardhat";
import type { Interface } from "ethers";
import dotenv from "dotenv";
dotenv.config();
import Safe from "@safe-global/protocol-kit";
import { MetaTransactionData, OperationType } from "@safe-global/types-kit";
import {
    OSERO_REFERRAL_CODE,
    SPARK_PSM3_ADDRESS,
    USDC_ADDRESS,
    YieldProtocol,
    encodeSkySavingsPoolParam,
    sUSDS_ADDRESS,
} from "../contractAddresses";
import { ERC20_ABI, deployedManagerAddress, resolveOwnerKey, waitForReceipt } from "./lpSafeShared";

/**
 * Walks a Safe through the savings source (protocol 3, sUSDS through Spark
 * PSM3) on a deployed SafeYieldManager: status, open, close, withdraw, and a
 * direct PSM3 redemption of sUSDS the module no longer tracks.
 *
 * Recovery ordering: every action is encoded from the reads it needs and
 * nothing else. `withdraw` needs the manager's pin; `redeem-direct` needs the
 * Safe's sUSDS balance and PSM3's quote (or MIN_USDC_OUT when PSM3 cannot be
 * quoted); `close` needs the pin, the pinned build's record and PSM3's quote;
 * only `open` needs the registered build's rate provider. A position pinned to
 * an older build is read and released through that build, whatever the
 * registered one does. Everything else (the rate, the pocket, the switches,
 * the balances) is diagnostics: best-effort before and after, never a reason
 * to abort, and never a reason to report a confirmed transaction as failed.
 *
 * Caller paths (CALLER env):
 *   safe      (default) the Safe owner executes through protocol-kit, threshold
 *             must be 1; `enableModule(manager)` is prepended when needed.
 *             Key: TESTING_SAFE_OWNER_KEY / SAFE_OWNER_PRIVATE_KEY / DEPLOYER_PRIVATE_KEY.
 *   operator  the registry operator calls the manager directly.
 *             Key: TESTING_SAFE_OPERATOR_KEY / OPERATOR_PRIVATE_KEY.
 *             (redeem-direct always goes through the Safe.)
 *
 * Usage (always dry-run first; DRY_RUN=false to send):
 *   IGNITION_DEPLOYMENT_ID=<id> ACTION=status   npx hardhat run scripts/savingsBySafe.ts --network base
 *   IGNITION_DEPLOYMENT_ID=<id> ACTION=open     USDC_AMOUNT=0.5 DRY_RUN=false npx hardhat run ...
 *   IGNITION_DEPLOYMENT_ID=<id> ACTION=close    EXIT_BPS=5000 DRY_RUN=false npx hardhat run ...
 *   IGNITION_DEPLOYMENT_ID=<id> ACTION=withdraw DRY_RUN=false npx hardhat run ...
 *   IGNITION_DEPLOYMENT_ID=<id> ACTION=redeem-direct DRY_RUN=false npx hardhat run ...
 * Env: SAFE_ADDRESS (defaults to TESTING_SAFE_WALLET_ADDRESS), MANAGER_ADDRESS
 * (defaults to the Ignition journal named by IGNITION_DEPLOYMENT_ID),
 * SLIPPAGE_BPS (oracle tolerance, default 20), MIN_USDC_OUT (close: the
 * caller's floor, default 0; redeem-direct: the owner's reviewed minimum,
 * used instead of PSM3's quote when set and required when PSM3 cannot be quoted).
 */

export const ACTIONS = ["status", "open", "close", "withdraw", "redeem-direct"] as const;
export type Action = (typeof ACTIONS)[number];

export interface SavingsConfig {
    action: Action;
    caller: "safe" | "operator";
    dryRun: boolean;
    safeAddress: string;
    managerAddress: string;
    slippageBps: number;
    exitBps: number;
    usdcAmount: bigint;
    minUsdcOut: bigint;
    /** MIN_USDC_OUT was given explicitly (redeem-direct takes it over PSM3's quote). */
    ownerMinSet: boolean;
}

export interface BuiltAction {
    target: string;
    data: string;
    /** Further Safe calls after `data` (redeem-direct: the PSM3 swap and the allowance reset). */
    extra: MetaTransactionData[];
}

const PROTOCOL = YieldProtocol.SKY_SAVINGS;
const POOL_PARAM = encodeSkySavingsPoolParam(SPARK_PSM3_ADDRESS, sUSDS_ADDRESS);
const ZERO_LEG = { amountOutMin: 0, poolParam: "0x" };
const DEADLINE_SECONDS = 1_200n;

const PSM3_ABI = [
    "function pocket() view returns (address)",
    "function previewSwapExactIn(address,address,uint256) view returns (uint256)",
    "function swapExactIn(address,address,uint256,uint256,address,uint256) returns (uint256)",
];
const SAFE_VIEW_ABI = [
    "function isModuleEnabled(address) view returns (bool)",
    "function getThreshold() view returns (uint256)",
];
const ERC20_APPROVE = new ethers.Interface(["function approve(address,uint256)"]);

type Settled<T> = { ok: true; value: T } | { ok: false; error: string };

function describeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.split("\n")[0].slice(0, 160);
}

/** A diagnostic read: its failure is reported, never thrown. */
async function settle<T>(read: Promise<T>): Promise<Settled<T>> {
    try {
        return { ok: true, value: await read };
    } catch (error) {
        return { ok: false, error: describeError(error) };
    }
}

function show<T>(read: Settled<T>, format: (value: T) => string): string {
    return read.ok ? format(read.value) : `unavailable (${read.error})`;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): SavingsConfig {
    const get = (name: string, fallback = ""): string => {
        const value = env[name];
        return value === undefined || value === "" ? fallback : value;
    };
    const action = get("ACTION", "status");
    if (!(ACTIONS as readonly string[]).includes(action)) throw new Error(`Unknown ACTION ${action}`);
    const caller = get("CALLER", "safe");
    if (caller !== "safe" && caller !== "operator") throw new Error(`Unknown CALLER ${caller}`);
    const safeAddress = get("SAFE_ADDRESS", get("TESTING_SAFE_WALLET_ADDRESS"));
    if (!ethers.isAddress(safeAddress)) throw new Error("Set SAFE_ADDRESS (or TESTING_SAFE_WALLET_ADDRESS)");
    const ownerMin = get("MIN_USDC_OUT");
    return {
        action: action as Action,
        caller,
        dryRun: get("DRY_RUN", "true") !== "false",
        safeAddress,
        managerAddress: get("MANAGER_ADDRESS") || deployedManagerAddress(),
        slippageBps: Number(get("SLIPPAGE_BPS", "20")),
        exitBps: Number(get("EXIT_BPS", "10000")),
        usdcAmount: ethers.parseUnits(get("USDC_AMOUNT", "0.5"), 6),
        minUsdcOut: ethers.parseUnits(ownerMin || "0", 6),
        ownerMinSet: ownerMin !== "",
    };
}

async function contractsFor(cfg: SavingsConfig) {
    const provider = ethers.provider;
    return {
        provider,
        manager: await ethers.getContractAt("SafeYieldManager", cfg.managerAddress),
        /** The handler ABI at the manager address: the savings events are emitted from there. */
        handlerEvents: await ethers.getContractAt("SkySavingsYieldHandler", cfg.managerAddress),
        psm3: new ethers.Contract(SPARK_PSM3_ADDRESS, PSM3_ABI, provider),
        usdc: new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider),
        susds: new ethers.Contract(sUSDS_ADDRESS, ERC20_ABI, provider),
        safeView: new ethers.Contract(cfg.safeAddress, SAFE_VIEW_ABI, provider),
        tokenId: BigInt(cfg.safeAddress),
    };
}
type Contracts = Awaited<ReturnType<typeof contractsFor>>;

/** The record the manager keeps for this Safe, read through the build it is pinned to. */
async function trackedSharesVia(c: Contracts, cfg: SavingsConfig, build: string): Promise<bigint> {
    const handler = await ethers.getContractAt("SkySavingsYieldHandler", build);
    const slot: string = await handler.savingsSharesSlot(c.tokenId);
    return BigInt(await c.provider.getStorage(cfg.managerAddress, slot));
}

/** USDC per sUSDS (18 dp) from the rate provider the given build prices with. */
async function rateVia(build: string): Promise<bigint> {
    const handler = await ethers.getContractAt("SkySavingsYieldHandler", build);
    const rateProvider = await ethers.getContractAt("ChainlinkSsrRateProvider", await handler.RATE_PROVIDER());
    return rateProvider.rate(sUSDS_ADDRESS);
}

/** Best-effort diagnostics: every read is reported on its own and none can abort the script. */
export async function printStatus(cfg: SavingsConfig): Promise<void> {
    const c = await contractsFor(cfg);
    const [pinned, registered] = await Promise.all([
        settle<string>(c.manager.positionHandlerOf(PROTOCOL, c.tokenId)),
        settle<string>(c.manager.yieldHandlers(PROTOCOL)),
    ]);
    const build = pinned.ok && pinned.value !== ethers.ZeroAddress ? pinned.value : registered.ok ? registered.value : "";
    const hasBuild = build !== "" && build !== ethers.ZeroAddress;
    const [rate, pocket, tracked, basis, openOn, closeOn, allowed, moduleOn, safeUsdc, safeSusds] = await Promise.all([
        hasBuild ? settle<bigint>(rateVia(build)) : Promise.resolve({ ok: false, error: "no build" } as Settled<bigint>),
        settle<bigint>(c.psm3.pocket().then((pocket: string) => c.usdc.balanceOf(pocket))),
        hasBuild
            ? settle<bigint>(trackedSharesVia(c, cfg, build))
            : Promise.resolve({ ok: false, error: "no build" } as Settled<bigint>),
        settle<bigint>(c.manager.residualBasisUsd6Of(PROTOCOL, c.tokenId)),
        settle<boolean>(c.manager.protocolEnabledForOpen(PROTOCOL)),
        settle<boolean>(c.manager.protocolEnabledForClose(PROTOCOL)),
        settle<boolean>(c.manager.isPoolParamAllowed(PROTOCOL, POOL_PARAM)),
        settle<boolean>(c.safeView.isModuleEnabled(cfg.managerAddress)),
        settle<bigint>(c.usdc.balanceOf(cfg.safeAddress)),
        settle<bigint>(c.susds.balanceOf(cfg.safeAddress)),
    ]);
    console.log(
        "Manager:",
        cfg.managerAddress,
        "| registered build (protocol 3):",
        show(registered, (v) => v),
        "| pinned build:",
        show(pinned, (v) => v),
    );
    console.log(
        "Switches: open",
        show(openOn, String),
        "close",
        show(closeOn, String),
        "| pool param allowed:",
        show(allowed, String),
        "| module enabled on Safe:",
        show(moduleOn, String),
    );
    console.log(
        "sUSDS rate (USDC per sUSDS):",
        show(rate, (v) => ethers.formatEther(v)),
        "| PSM3 pocket USDC:",
        show(pocket, (v) => ethers.formatUnits(v, 6)),
    );
    console.log(
        "Safe:",
        cfg.safeAddress,
        "| USDC",
        show(safeUsdc, (v) => ethers.formatUnits(v, 6)),
        "| sUSDS",
        show(safeSusds, (v) => ethers.formatEther(v)),
    );
    const valued =
        tracked.ok && rate.ok && tracked.value > 0n
            ? `(~${ethers.formatUnits((tracked.value * rate.value) / 10n ** 30n, 6)} USDC at the oracle rate)`
            : "";
    console.log(
        "Position: basis USDC",
        show(basis, (v) => ethers.formatUnits(v, 6)),
        "| tracked shares",
        show(tracked, (v) => ethers.formatEther(v)),
        valued,
    );
}

/** Encodes the action from the reads it needs; diagnostics are not among them. */
export async function buildAction(cfg: SavingsConfig): Promise<BuiltAction> {
    const c = await contractsFor(cfg);
    const deadline = async () => BigInt((await c.provider.getBlock("latest"))!.timestamp) + DEADLINE_SECONDS;
    const requirePin = async (): Promise<string> => {
        const pinned: string = await c.manager.positionHandlerOf(PROTOCOL, c.tokenId);
        if (pinned === ethers.ZeroAddress) throw new Error("No open savings position for this Safe");
        return pinned;
    };

    if (cfg.action === "open") {
        const registered: string = await c.manager.yieldHandlers(PROTOCOL);
        if (registered === ethers.ZeroAddress)
            throw new Error(`No handler registered under protocol ${PROTOCOL} on ${cfg.managerAddress}`);
        if (!(await c.manager.protocolEnabledForOpen(PROTOCOL))) throw new Error("Protocol 3 is disabled for open");
        if ((await c.manager.positionHandlerOf(PROTOCOL, c.tokenId)) !== ethers.ZeroAddress)
            throw new Error("This Safe already has an open savings position (no top-ups): close or withdraw first");
        const balance: bigint = await c.usdc.balanceOf(cfg.safeAddress);
        if (balance < cfg.usdcAmount)
            throw new Error(
                `Safe USDC ${ethers.formatUnits(balance, 6)} < requested ${ethers.formatUnits(cfg.usdcAmount, 6)}`,
            );
        // The floor the handler will enforce comes from the registered build's provider: an open
        // cannot be rehearsed without it.
        const rate = await rateVia(registered);
        const quoted: bigint = await c.psm3.previewSwapExactIn(USDC_ADDRESS, sUSDS_ADDRESS, cfg.usdcAmount);
        const floor = (((cfg.usdcAmount * 10n ** 12n * 10n ** 18n) / rate) * BigInt(10_000 - cfg.slippageBps)) / 10_000n;
        console.log(
            "open:",
            ethers.formatUnits(cfg.usdcAmount, 6),
            "USDC -> PSM3 quotes",
            ethers.formatEther(quoted),
            "sUSDS | handler floor",
            ethers.formatEther(floor),
            `(tolerance ${cfg.slippageBps} bps)`,
        );
        if (quoted < floor)
            throw new Error(
                "PSM3 pays below the oracle floor right now; raise SLIPPAGE_BPS within the handler's ceiling or wait",
            );
        return {
            target: cfg.managerAddress,
            data: c.manager.interface.encodeFunctionData("open", [
                PROTOCOL,
                {
                    onBehalfOf: cfg.safeAddress,
                    usdcAmount: cfg.usdcAmount,
                    tickLower: 0,
                    tickUpper: 0,
                    mintAmount0Min: 0,
                    mintAmount1Min: 0,
                    swap0: ZERO_LEG,
                    swap1: ZERO_LEG,
                    slippageBps: cfg.slippageBps,
                    deadline: await deadline(),
                    poolParam: POOL_PARAM,
                    stake: false,
                },
            ]),
            extra: [],
        };
    }

    if (cfg.action === "close") {
        const pinned = await requirePin();
        const tracked = await trackedSharesVia(c, cfg, pinned);
        const toRedeem = cfg.exitBps === 10_000 ? tracked : (tracked * BigInt(cfg.exitBps)) / 10_000n;
        const quoted =
            toRedeem > 0n
                ? await settle<bigint>(c.psm3.previewSwapExactIn(sUSDS_ADDRESS, USDC_ADDRESS, toRedeem))
                : ({ ok: true, value: 0n } as Settled<bigint>);
        console.log(
            "close:",
            `exitBps ${cfg.exitBps}`,
            "redeems",
            ethers.formatEther(toRedeem),
            "sUSDS -> PSM3 quotes",
            show(quoted, (v) => `${ethers.formatUnits(v, 6)} USDC`),
            `| floor minUsdcOut ${ethers.formatUnits(cfg.minUsdcOut, 6)} USDC (the chain also floors at the oracle rate)`,
        );
        return {
            target: cfg.managerAddress,
            data: c.manager.interface.encodeFunctionData("close", [
                PROTOCOL,
                {
                    onBehalfOf: cfg.safeAddress,
                    tokenId: c.tokenId,
                    exitBps: cfg.exitBps,
                    swap0: ZERO_LEG,
                    swap1: ZERO_LEG,
                    slippageBps: cfg.slippageBps,
                    decreaseAmount0Min: 0,
                    decreaseAmount1Min: 0,
                    deadline: await deadline(),
                    minUsdcOut: cfg.minUsdcOut,
                },
            ]),
            extra: [],
        };
    }

    if (cfg.action === "withdraw") {
        const pinned = await requirePin();
        const tracked = await settle<bigint>(trackedSharesVia(c, cfg, pinned));
        console.log(
            "withdraw: releases",
            show(tracked, (v) => ethers.formatEther(v)),
            "sUSDS in kind (no price read, no PSM3 call); they stay on the Safe",
        );
        return {
            target: cfg.managerAddress,
            data: c.manager.interface.encodeFunctionData("withdraw", [
                PROTOCOL,
                {
                    onBehalfOf: cfg.safeAddress,
                    tokenId: c.tokenId,
                    decreaseAmount0Min: 0,
                    decreaseAmount1Min: 0,
                    deadline: await deadline(),
                },
            ]),
            extra: [],
        };
    }

    if (cfg.action === "redeem-direct") {
        if (cfg.caller !== "safe") throw new Error("redeem-direct runs as the Safe owner (CALLER=safe)");
        // Nothing here reads the manager or the rate provider: the owner redeems at PSM3 directly.
        const shares: bigint = await c.susds.balanceOf(cfg.safeAddress);
        if (shares === 0n) throw new Error("The Safe holds no sUSDS");
        const quoted = await settle<bigint>(c.psm3.previewSwapExactIn(sUSDS_ADDRESS, USDC_ADDRESS, shares));
        let minOut: bigint;
        if (cfg.ownerMinSet) {
            minOut = cfg.minUsdcOut;
        } else if (quoted.ok) {
            minOut = (quoted.value * BigInt(10_000 - cfg.slippageBps)) / 10_000n;
        } else {
            throw new Error(
                `PSM3 cannot be quoted (${quoted.error}); set MIN_USDC_OUT to the owner's reviewed minimum to redeem anyway`,
            );
        }
        console.log(
            "redeem-direct:",
            ethers.formatEther(shares),
            "sUSDS -> PSM3 quotes",
            show(quoted, (v) => `${ethers.formatUnits(v, 6)} USDC`),
            "| minOut",
            ethers.formatUnits(minOut, 6),
            cfg.ownerMinSet ? "(MIN_USDC_OUT)" : `(quote less ${cfg.slippageBps} bps)`,
        );
        return {
            target: sUSDS_ADDRESS,
            data: ERC20_APPROVE.encodeFunctionData("approve", [SPARK_PSM3_ADDRESS, shares]),
            extra: [
                {
                    to: SPARK_PSM3_ADDRESS,
                    value: "0",
                    data: c.psm3.interface.encodeFunctionData("swapExactIn", [
                        sUSDS_ADDRESS,
                        USDC_ADDRESS,
                        shares,
                        minOut,
                        cfg.safeAddress,
                        OSERO_REFERRAL_CODE,
                    ]),
                    operation: OperationType.Call,
                },
                {
                    to: sUSDS_ADDRESS,
                    value: "0",
                    data: ERC20_APPROVE.encodeFunctionData("approve", [SPARK_PSM3_ADDRESS, 0]),
                    operation: OperationType.Call,
                },
            ],
        };
    }

    throw new Error(`ACTION ${cfg.action} builds no transaction`);
}

async function send(cfg: SavingsConfig, built: BuiltAction): Promise<string> {
    const c = await contractsFor(cfg);
    const rpcUrl = (network.config as { url?: string }).url;
    if (!rpcUrl) throw new Error(`Network ${network.name} has no RPC url — run with --network base`);
    // The one Safe read a send depends on: whether the manager may act for this Safe.
    const moduleOn: boolean = await c.safeView.isModuleEnabled(cfg.managerAddress);

    if (cfg.caller === "operator") {
        const key = process.env.TESTING_SAFE_OPERATOR_KEY || process.env.OPERATOR_PRIVATE_KEY || "";
        if (!key) throw new Error("Set TESTING_SAFE_OPERATOR_KEY (or OPERATOR_PRIVATE_KEY)");
        if (!moduleOn)
            throw new Error("The manager is not enabled as a module on this Safe; run once with CALLER=safe first");
        const operator = new ethers.Wallet(key, new ethers.JsonRpcProvider(rpcUrl));
        return (await operator.sendTransaction({ to: built.target, data: built.data })).hash;
    }

    const ownerKey = resolveOwnerKey();
    if (!ownerKey) throw new Error("Set TESTING_SAFE_OWNER_KEY (or SAFE_OWNER_PRIVATE_KEY / DEPLOYER_PRIVATE_KEY)");
    const safeWallet = await Safe.init({ provider: rpcUrl, signer: ownerKey, safeAddress: cfg.safeAddress });
    if ((await safeWallet.getThreshold()) > 1)
        throw new Error("Safe threshold > 1: propose the printed calldata through the Safe UI instead");
    const transactions: MetaTransactionData[] = [];
    if (!moduleOn && built.target === cfg.managerAddress) {
        console.log("Manager not enabled as a module — prepending enableModule");
        const safeIface = new ethers.Interface(["function enableModule(address)"]);
        transactions.push({
            to: cfg.safeAddress,
            value: "0",
            data: safeIface.encodeFunctionData("enableModule", [cfg.managerAddress]),
            operation: OperationType.Call,
        });
    }
    transactions.push({ to: built.target, value: "0", data: built.data, operation: OperationType.Call }, ...built.extra);
    return (await safeWallet.executeTransaction(await safeWallet.createTransaction({ transactions }))).hash;
}

/** The confirmed transaction's events, then best-effort diagnostics: a failing read after the
 *  receipt is reported, never turned into a failed exit. */
export async function reportReceipt(
    cfg: SavingsConfig,
    receipt: { blockNumber: number; logs: ReadonlyArray<{ address: string; topics: ReadonlyArray<string>; data: string }> },
): Promise<void> {
    const c = await contractsFor(cfg);
    console.log("Confirmed in block", receipt.blockNumber);
    const eventTables: Array<[{ interface: Interface }, string[]]> = [
        [c.manager, ["PositionOpened", "PositionClosed", "PositionWithdrawn"]],
        [c.handlerEvents, ["SavingsDeposited", "SavingsRedeemed", "SavingsReleased", "SavingsSharesShortfall"]],
    ];
    for (const [contract, names] of eventTables) {
        for (const log of receipt.logs) {
            if (log.address.toLowerCase() !== cfg.managerAddress.toLowerCase()) continue;
            const parsed = contract.interface.parseLog({ topics: [...log.topics], data: log.data });
            if (parsed && names.includes(parsed.name)) console.log(`${parsed.name}:`, parsed.args.toObject());
        }
    }
    console.log("\nAfter:");
    try {
        await printStatus(cfg);
    } catch (error) {
        console.log("Diagnostics after the transaction failed; the transaction itself is confirmed:", describeError(error));
    }
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const cfg = readConfig(env);
    if (cfg.action === "status") {
        await printStatus(cfg);
        return;
    }
    // The action first, from the reads it needs; the diagnostics after, and only best-effort.
    const built = await buildAction(cfg);
    console.log("\nBefore:");
    await printStatus(cfg);

    if (cfg.dryRun) {
        console.log(`\nDRY_RUN — ${cfg.action} calldata to ${built.target}:`);
        console.log(built.data);
        for (const tx of built.extra) console.log(`then to ${tx.to}:`, tx.data);
        return;
    }

    const hash = await send(cfg, built);
    console.log("Submitted:", hash);
    const receipt = await waitForReceipt(ethers.provider, hash);
    await reportReceipt(cfg, receipt);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
