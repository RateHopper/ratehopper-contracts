import { ethers } from "hardhat";
import dotenv from "dotenv";
dotenv.config();
import { SPARK_PSM3_ADDRESS, YieldProtocol, encodeSkySavingsPoolParam, sUSDS_ADDRESS } from "../contractAddresses";
import { waitForReceipt } from "./lpSafeShared";
import {
    BuiltAction,
    Contracts,
    SavingsConfig,
    buildAction,
    contractsFor,
    rateVia,
    readConfig,
    send,
    trackedSharesVia,
} from "./savingsBySafe";

/**
 * First-deploy canary for the savings source (protocol 3): one small open and
 * one full close through a deployed SafeYieldManager, judged from balances,
 * records and events rather than from the transactions succeeding. A wiring
 * test for what the fork suites cannot see: the registry operator, the module
 * enabled on a real Safe, the timelock-registered build, the live PSM3 pocket.
 *
 * Stages, each a list of named checks:
 *   preflight  reads only: build registered, both switches on, pool param
 *              allow-listed, module enabled, no open position, the oracle
 *              answers, PSM3 and the Safe can cover the amount. Any failure
 *              stops the run before a transaction is sent.
 *   open       USDC left the Safe, the basis and the shares record match, the
 *              shares are worth the deposit at the oracle rate.
 *   close      the record is cleared, the shares left, the USDC came back
 *              within CANARY_TOLERANCE_BPS of the deposit.
 * An open whose checks fail is left in place for inspection, and a run that
 * throws after a transaction was sent says so: the result's `note` names what
 * may be open and how to close it (savingsBySafe.ts ACTION=close). The run
 * reports FAIL either way.
 *
 * Usage (DRY_RUN=true runs preflight only and prints the open calldata):
 *   IGNITION_DEPLOYMENT_ID=<id> CALLER=operator DRY_RUN=false USDC_AMOUNT=1 \
 *   npx hardhat run scripts/canarySavings.ts --network base
 * Env: as savingsBySafe.ts (SAFE_ADDRESS, MANAGER_ADDRESS, CALLER, SLIPPAGE_BPS, the
 * signer keys), plus USDC_AMOUNT (default 1) and CANARY_TOLERANCE_BPS (default 50:
 * the handler's default oracle tolerance ceiling). Exit code 1 unless every check passes.
 */

const PROTOCOL = YieldProtocol.SKY_SAVINGS;
const POOL_PARAM = encodeSkySavingsPoolParam(SPARK_PSM3_ADDRESS, sUSDS_ADDRESS);
const BPS = 10_000n;

export interface Check {
    name: string;
    ok: boolean;
    detail: string;
}

export interface Snapshot {
    safeUsdc: bigint;
    safeSusds: bigint;
    basis: bigint;
    tracked: bigint;
    pinned: string;
}

export interface OpenEvidence {
    before: Snapshot;
    after: Snapshot;
    amount: bigint;
    rate: bigint;
    events: string[];
    toleranceBps: number;
}

export interface CloseEvidence {
    before: Snapshot;
    after: Snapshot;
    amount: bigint;
    events: string[];
    toleranceBps: number;
}

export interface CanaryConfig extends SavingsConfig {
    toleranceBps: number;
}

export type Sender = (cfg: SavingsConfig, built: BuiltAction) => Promise<string>;

export interface CanaryResult {
    ok: boolean;
    stage: "preflight" | "open" | "close";
    checks: Check[];
    /** What to do about a position the run may have left open; absent when nothing is open. */
    note?: string;
}

const CLOSE_HINT = "close it with savingsBySafe.ts ACTION=close";
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function readCanaryConfig(env: NodeJS.ProcessEnv = process.env): CanaryConfig {
    const base = readConfig({ ...env, ACTION: "open", USDC_AMOUNT: env.USDC_AMOUNT || "1" });
    const toleranceBps = Number(env.CANARY_TOLERANCE_BPS || "50");
    validateTolerance(toleranceBps);
    validateAmount(base.usdcAmount);
    return { ...base, toleranceBps };
}

function validateTolerance(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 300)
        throw new Error("CANARY_TOLERANCE_BPS must be an integer between 0 and 300");
}

function validateAmount(value: bigint): void {
    if (value <= 0n || value >= 1n << 128n)
        throw new Error("USDC_AMOUNT must be positive and fit in uint128 USDC units");
}

const usdc = (v: bigint) => `${ethers.formatUnits(v, 6)} USDC`;
const check = (name: string, ok: boolean, detail: string): Check => ({ name, ok, detail });

export function evaluateOpen(e: OpenEvidence): Check[] {
    const usdcOut = e.before.safeUsdc - e.after.safeUsdc;
    const sharesIn = e.after.safeSusds - e.before.safeSusds;
    const worth = (e.after.tracked * e.rate) / 10n ** 30n;
    const floor = (e.amount * (BPS - BigInt(e.toleranceBps))) / BPS;
    return [
        check("PositionOpened emitted", e.events.includes("PositionOpened"), e.events.join(", ") || "no events"),
        check("SavingsDeposited emitted", e.events.includes("SavingsDeposited"), e.events.join(", ") || "no events"),
        check("position pinned", e.after.pinned !== ethers.ZeroAddress, `pinned build ${e.after.pinned}`),
        check(
            "basis equals the deposit",
            e.after.basis === e.amount,
            `basis ${usdc(e.after.basis)}, deposit ${usdc(e.amount)}`,
        ),
        check("USDC left the Safe equals the deposit", usdcOut === e.amount, `${usdc(usdcOut)} left the Safe`),
        check(
            "shares received equal the record",
            sharesIn === e.after.tracked && e.after.tracked > 0n,
            `${ethers.formatEther(sharesIn)} sUSDS received, record ${ethers.formatEther(e.after.tracked)}`,
        ),
        check(
            "shares worth at least the deposit less tolerance",
            worth >= floor,
            `${usdc(worth)} at the oracle rate, floor ${usdc(floor)}`,
        ),
    ];
}

export function evaluateClose(e: CloseEvidence): Check[] {
    const returned = e.after.safeUsdc - e.before.safeUsdc;
    const sharesOut = e.before.safeSusds - e.after.safeSusds;
    const floor = (e.amount * (BPS - BigInt(e.toleranceBps))) / BPS;
    const ceiling = (e.amount * (BPS + BigInt(e.toleranceBps))) / BPS;
    const cleared = e.after.pinned === ethers.ZeroAddress && e.after.basis === 0n && e.after.tracked === 0n;
    return [
        check("PositionClosed emitted", e.events.includes("PositionClosed"), e.events.join(", ") || "no events"),
        check("SavingsRedeemed emitted", e.events.includes("SavingsRedeemed"), e.events.join(", ") || "no events"),
        check(
            "record cleared",
            cleared,
            `pinned ${e.after.pinned}, basis ${usdc(e.after.basis)}, record ${ethers.formatEther(e.after.tracked)} sUSDS`,
        ),
        check(
            "shares left the Safe equal the record",
            sharesOut === e.before.tracked,
            `${ethers.formatEther(sharesOut)} sUSDS left, record was ${ethers.formatEther(e.before.tracked)}`,
        ),
        check(
            "USDC returned within tolerance",
            returned >= floor && returned <= ceiling,
            `${usdc(returned)} returned for ${usdc(e.amount)}, window ${usdc(floor)} to ${usdc(ceiling)}`,
        ),
    ];
}

async function snapshot(c: Contracts, cfg: SavingsConfig): Promise<Snapshot> {
    const pinned: string = await c.manager.positionHandlerOf(PROTOCOL, c.tokenId);
    return {
        safeUsdc: await c.usdc.balanceOf(cfg.safeAddress),
        safeSusds: await c.susds.balanceOf(cfg.safeAddress),
        basis: await c.manager.residualBasisUsd6Of(PROTOCOL, c.tokenId),
        tracked: pinned === ethers.ZeroAddress ? 0n : await trackedSharesVia(c, cfg, pinned),
        pinned,
    };
}

async function read<T>(name: string, promise: Promise<T>, judge: (v: T) => [boolean, string]): Promise<Check> {
    try {
        const [ok, detail] = judge(await promise);
        return check(name, ok, detail);
    } catch (error) {
        return check(name, false, `read failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export async function preflight(cfg: CanaryConfig): Promise<Check[]> {
    const c = await contractsFor(cfg);
    const registered: string = await c.manager.yieldHandlers(PROTOCOL).catch(() => ethers.ZeroAddress);
    const yes = (v: boolean) => [v, String(v)] as [boolean, string];
    return Promise.all([
        read("manager unpaused", c.manager.paused(), (v: boolean) => [!v, `paused=${v}`]),
        read("handler registered", Promise.resolve(registered), (v) => [v !== ethers.ZeroAddress, v]),
        read("opens enabled", c.manager.protocolEnabledForOpen(PROTOCOL), yes),
        read("closes enabled", c.manager.protocolEnabledForClose(PROTOCOL), yes),
        read("pool param allow-listed", c.manager.isPoolParamAllowed(PROTOCOL, POOL_PARAM), yes),
        read("module enabled on the Safe", c.safeView.isModuleEnabled(cfg.managerAddress), yes),
        read("no open position", c.manager.positionHandlerOf(PROTOCOL, c.tokenId), (v: string) => [
            v === ethers.ZeroAddress,
            v === ethers.ZeroAddress ? "none" : `pinned to ${v}`,
        ]),
        read(
            "oracle answers",
            registered === ethers.ZeroAddress ? Promise.reject(new Error("no build")) : rateVia(registered),
            (v: bigint) => [v > 0n, `${ethers.formatEther(v)} USDC per sUSDS`],
        ),
        read(
            "PSM3 pocket covers the deposit",
            c.psm3.pocket().then((pocket: string) => c.usdc.balanceOf(pocket)),
            (v: bigint) => [v >= cfg.usdcAmount, usdc(v)],
        ),
        read("Safe holds the deposit", c.usdc.balanceOf(cfg.safeAddress), (v: bigint) => [
            v >= cfg.usdcAmount,
            usdc(v),
        ]),
    ]);
}

function eventNames(
    c: Contracts,
    cfg: SavingsConfig,
    logs: ReadonlyArray<{ address: string; topics: ReadonlyArray<string>; data: string }>,
) {
    const names: string[] = [];
    for (const log of logs) {
        if (log.address.toLowerCase() !== cfg.managerAddress.toLowerCase()) continue;
        for (const contract of [c.manager, c.handlerEvents]) {
            const parsed = contract.interface.parseLog({ topics: [...log.topics], data: log.data });
            if (parsed) names.push(parsed.name);
        }
    }
    return names;
}

export async function runCanary(
    cfg: CanaryConfig,
    sender: Sender,
    receiptReader = waitForReceipt,
): Promise<CanaryResult> {
    validateTolerance(cfg.toleranceBps);
    validateAmount(cfg.usdcAmount);
    const checks = await preflight(cfg);
    if (checks.some((c) => !c.ok)) return { ok: false, stage: "preflight", checks };

    const c = await contractsFor(cfg);
    const before = await snapshot(c, cfg);
    let openHash: string | undefined;
    let openAttempted = false;
    let afterOpen: Snapshot;
    try {
        const built = await buildAction({ ...cfg, action: "open" });
        openAttempted = true;
        openHash = await sender(cfg, built);
        console.log("Open submitted:", openHash);
        const openReceipt = await receiptReader(c.provider, openHash);
        const rate = await rateVia(await c.manager.yieldHandlers(PROTOCOL));
        afterOpen = await snapshot(c, cfg);
        checks.push(check("open confirmed", true, `tx ${openHash} in block ${openReceipt.blockNumber}`));
        checks.push(
            ...evaluateOpen({
                before,
                after: afterOpen,
                amount: cfg.usdcAmount,
                rate,
                events: eventNames(c, cfg, openReceipt.logs),
                toleranceBps: cfg.toleranceBps,
            }),
        );
    } catch (error) {
        checks.push(check("open confirmed", false, `${openHash ? `tx ${openHash}: ` : ""}${describe(error)}`));
        return {
            ok: false,
            stage: "open",
            checks,
            note: openAttempted
                ? `Open outcome unknown${openHash ? ` (tx ${openHash})` : " (sender returned no hash)"}. A transaction may be pending or confirmed. Do not retry the open until its receipt and sender nonce are reconciled. Check ACTION=status; if a position is confirmed open, ${CLOSE_HINT}.`
                : "Open preparation failed before calling the sender; this run submitted no transaction.",
        };
    }
    if (checks.some((x) => !x.ok)) {
        return { ok: false, stage: "open", checks, note: `the position was left open for inspection; ${CLOSE_HINT}` };
    }

    const floor = (cfg.usdcAmount * (BPS - BigInt(cfg.toleranceBps))) / BPS;
    const closeCfg: SavingsConfig = { ...cfg, action: "close", exitBps: 10_000, minUsdcOut: floor, ownerMinSet: true };
    let closeHash: string | undefined;
    let closeAttempted = false;
    try {
        const built = await buildAction(closeCfg);
        closeAttempted = true;
        closeHash = await sender(closeCfg, built);
        console.log("Close submitted:", closeHash);
        const closeReceipt = await receiptReader(c.provider, closeHash);
        const afterClose = await snapshot(c, cfg);
        checks.push(check("close confirmed", true, `tx ${closeHash} in block ${closeReceipt.blockNumber}`));
        checks.push(
            ...evaluateClose({
                before: afterOpen,
                after: afterClose,
                amount: cfg.usdcAmount,
                events: eventNames(c, cfg, closeReceipt.logs),
                toleranceBps: cfg.toleranceBps,
            }),
        );
    } catch (error) {
        checks.push(check("close confirmed", false, `${closeHash ? `tx ${closeHash}: ` : ""}${describe(error)}`));
        return {
            ok: false,
            stage: "close",
            checks,
            note: closeAttempted
                ? `Close outcome unknown${closeHash ? ` (tx ${closeHash})` : " (sender returned no hash)"}. It may be pending or confirmed. Reconcile the receipt, sender nonce and ACTION=status before retrying. If still open and no transaction is pending, ${CLOSE_HINT}.`
                : `Close preparation failed before calling the sender; inspect the confirmed open, then ${CLOSE_HINT}.`,
        };
    }
    return { ok: checks.every((x) => x.ok), stage: "close", checks };
}

export function render(checks: Check[]): string {
    return checks.map((x) => `${x.ok ? "PASS" : "FAIL"}  ${x.name.padEnd(44)} ${x.detail}`).join("\n");
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const cfg = readCanaryConfig(env);
    console.log(
        `Canary: ${usdc(cfg.usdcAmount)} on ${cfg.managerAddress} for Safe ${cfg.safeAddress} (tolerance ${cfg.toleranceBps} bps)\n`,
    );
    if (cfg.dryRun) {
        const checks = await preflight(cfg);
        console.log(render(checks));
        if (checks.every((x) => x.ok)) {
            const built = await buildAction({ ...cfg, action: "open" });
            console.log(`\nDRY_RUN — preflight passed; open calldata to ${built.target}:\n${built.data}`);
        } else {
            process.exitCode = 1;
        }
        return;
    }
    const result = await runCanary(cfg, send);
    console.log(render(result.checks));
    console.log(
        `\n${result.ok ? "PASS" : `FAIL at ${result.stage}`}: ${result.checks.filter((x) => x.ok).length}/${result.checks.length} checks`,
    );
    if (result.note) console.log(`Note: ${result.note}`);
    if (!result.ok) process.exitCode = 1;
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
