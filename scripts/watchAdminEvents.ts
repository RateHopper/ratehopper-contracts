import hre from "hardhat";
import { Interface, Log } from "ethers";
import dotenv from "dotenv";
dotenv.config();
import fs from "fs";
import path from "path";
import type { Artifacts } from "hardhat/types";

/**
 * Reference watcher for the admin and role changes docs/MONITORING.md says to
 * alert on: every privileged setter, every role change, every pause, every
 * timelock schedule/execute, every fee-transfer failure, on the four
 * contracts that hold privileged state. Position activity (opens, closes,
 * swaps, collects) is deliberately not an alert; the catalogue below lists
 * both sides so that a new event cannot slip through unclassified
 * (test/scripts/watchAdminEvents.ts enforces it against the ABIs).
 *
 * Polls `eth_getLogs` from the last block it saw (STATE_FILE) to the head,
 * prints one line per alert and POSTs `{ text }` to ALERT_WEBHOOK_URL when
 * set (Slack-compatible; Telegram or PagerDuty need a small relay). Run it
 * once from cron (ONCE=true) or let it loop (POLL_INTERVAL_MS, default 60s).
 *
 *   ONCE=true npx hardhat run scripts/watchAdminEvents.ts --network base
 * Env: MANIFEST (default deployments/base.json: the watched addresses are its
 * SafeYieldManager, TimelockController, ProtocolRegistry and SafeDebtManager
 * entries), START_BLOCK (first run only; default: the head, so nothing historic
 * is replayed), STATE_FILE (default .watch-admin-events.json), MIN_SEVERITY
 * (info | high | critical, default info), ALERT_WEBHOOK_URL, EXPLORER_URL
 * (default https://basescan.org).
 */

export type ContractName = "SafeYieldManager" | "TimelockController" | "ProtocolRegistry" | "SafeDebtManager";
export type Severity = "critical" | "high" | "info";

export interface CatalogueEntry {
    contract: ContractName;
    event: string;
    severity: Severity;
    meaning: string;
}

export interface Alert {
    severity: Severity;
    contract: ContractName;
    address: string;
    event: string;
    meaning: string;
    args: Record<string, string>;
    blockNumber: number;
    txHash: string;
}

export const WATCHED_CONTRACTS: ContractName[] = [
    "SafeYieldManager",
    "TimelockController",
    "ProtocolRegistry",
    "SafeDebtManager",
];

const roleEvents = (contract: ContractName): CatalogueEntry[] => [
    { contract, event: "RoleGranted", severity: "critical", meaning: "a privileged role was granted" },
    { contract, event: "RoleRevoked", severity: "critical", meaning: "a privileged role was revoked" },
    { contract, event: "RoleAdminChanged", severity: "critical", meaning: "the admin of a role changed" },
];

export const CATALOGUE: CatalogueEntry[] = [
    // SafeYieldManager: who may run handler code, what it charges, who can stop it
    {
        contract: "SafeYieldManager",
        event: "YieldHandlerUpdated",
        severity: "critical",
        meaning: "handler code registered or rolled for a protocol id (timelock)",
    },
    {
        contract: "SafeYieldManager",
        event: "TwapConfigUpdated",
        severity: "critical",
        meaning: "the price reference for a token changed (timelock)",
    },
    {
        contract: "SafeYieldManager",
        event: "TreasuryUpdated",
        severity: "critical",
        meaning: "fees now go to another address (timelock)",
    },
    {
        contract: "SafeYieldManager",
        event: "PerformanceFeeBpsUpdated",
        severity: "critical",
        meaning: "the performance fee changed (timelock)",
    },
    {
        contract: "SafeYieldManager",
        event: "FeeCollectBpsUpdated",
        severity: "critical",
        meaning: "the collect fee changed (timelock)",
    },
    { contract: "SafeYieldManager", event: "PauserUpdated", severity: "critical", meaning: "the pauser key changed" },
    {
        contract: "SafeYieldManager",
        event: "TokenRescued",
        severity: "critical",
        meaning: "tokens were swept out of the module",
    },
    {
        contract: "SafeYieldManager",
        event: "NftRescued",
        severity: "critical",
        meaning: "a position NFT was swept out of the module",
    },
    {
        contract: "SafeYieldManager",
        event: "Paused",
        severity: "critical",
        meaning: "opens and switches are stopped (exit-only mode)",
    },
    { contract: "SafeYieldManager", event: "Unpaused", severity: "high", meaning: "opens and switches resumed" },
    {
        contract: "SafeYieldManager",
        event: "HandlerConfigured",
        severity: "high",
        meaning: "a handler's bounded parameters were retuned",
    },
    {
        contract: "SafeYieldManager",
        event: "ProtocolStatusChanged",
        severity: "high",
        meaning: "a protocol's open or close switch flipped",
    },
    {
        contract: "SafeYieldManager",
        event: "MaxSlippageBpsUpdated",
        severity: "high",
        meaning: "the LP slippage ceiling changed",
    },
    {
        contract: "SafeYieldManager",
        event: "PoolParamAllowedUpdated",
        severity: "high",
        meaning: "a pool was allow-listed or de-listed",
    },
    {
        contract: "SafeYieldManager",
        event: "FeeTransferFailed",
        severity: "high",
        meaning: "a performance fee could not reach the treasury and was waived",
    },
    {
        contract: "SafeYieldManager",
        event: "CollectFeeTransferFailed",
        severity: "high",
        meaning: "a collect fee could not reach the treasury and was waived",
    },
    {
        contract: "SafeYieldManager",
        event: "MinPoolLiquidityUpdated",
        severity: "info",
        meaning: "a pool-liquidity floor changed",
    },
    {
        contract: "SafeYieldManager",
        event: "MinPositionLiquidityUpdated",
        severity: "info",
        meaning: "a position-liquidity floor changed",
    },
    ...roleEvents("SafeYieldManager"),
    // TimelockController: the 48 h window to react to a critical change
    {
        contract: "TimelockController",
        event: "CallScheduled",
        severity: "high",
        meaning: "a critical operation is queued; it executes after the delay",
    },
    {
        contract: "TimelockController",
        event: "CallExecuted",
        severity: "critical",
        meaning: "a critical operation executed",
    },
    {
        contract: "TimelockController",
        event: "Cancelled",
        severity: "high",
        meaning: "a queued operation was cancelled",
    },
    {
        contract: "TimelockController",
        event: "MinDelayChange",
        severity: "critical",
        meaning: "the timelock delay changed",
    },
    ...roleEvents("TimelockController"),
    // ProtocolRegistry: the operator every module trusts
    {
        contract: "ProtocolRegistry",
        event: "OperatorUpdated",
        severity: "critical",
        meaning: "the operator address changed (timelock)",
    },
    {
        contract: "ProtocolRegistry",
        event: "ParaswapV6Updated",
        severity: "critical",
        meaning: "the swap router changed (timelock)",
    },
    {
        contract: "ProtocolRegistry",
        event: "FluidVaultResolverUpdated",
        severity: "high",
        meaning: "the Fluid resolver changed",
    },
    { contract: "ProtocolRegistry", event: "TokenWhitelisted", severity: "info", meaning: "a token was whitelisted" },
    {
        contract: "ProtocolRegistry",
        event: "TokenRemovedFromWhitelist",
        severity: "info",
        meaning: "a token was removed from the whitelist",
    },
    ...roleEvents("ProtocolRegistry"),
    // SafeDebtManager
    {
        contract: "SafeDebtManager",
        event: "ProtocolHandlerUpdated",
        severity: "critical",
        meaning: "debt handler code registered for a protocol",
    },
    {
        contract: "SafeDebtManager",
        event: "ProtocolFeeSet",
        severity: "critical",
        meaning: "the debt-swap fee changed",
    },
    {
        contract: "SafeDebtManager",
        event: "FeeBeneficiarySet",
        severity: "critical",
        meaning: "debt-swap fees now go to another address",
    },
    {
        contract: "SafeDebtManager",
        event: "EmergencyWithdrawn",
        severity: "critical",
        meaning: "tokens were swept out of the debt manager",
    },
    {
        contract: "SafeDebtManager",
        event: "EmergencyETHWithdrawn",
        severity: "critical",
        meaning: "ETH was swept out of the debt manager",
    },
    {
        contract: "SafeDebtManager",
        event: "OwnershipTransferred",
        severity: "critical",
        meaning: "the debt manager owner changed",
    },
    { contract: "SafeDebtManager", event: "Paused", severity: "critical", meaning: "debt swaps are stopped" },
    {
        contract: "SafeDebtManager",
        event: "ProtocolStatusChanged",
        severity: "high",
        meaning: "a debt protocol was enabled or disabled",
    },
    { contract: "SafeDebtManager", event: "Unpaused", severity: "high", meaning: "debt swaps resumed" },
];

/** Position and user activity: expected in normal operation, never an alert. */
export const ACTIVITY_EVENTS: Record<ContractName, string[]> = {
    SafeYieldManager: [
        "PositionOpened",
        "PositionClosed",
        "PositionWithdrawn",
        "PositionSwitched",
        "FeesCollected",
        "RestakeSkipped",
        "StakedRewardCollected",
        "SwapSkippedBelowFloor",
        "SwitchResidueSettled",
    ],
    TimelockController: ["CallSalt"],
    ProtocolRegistry: [],
    SafeDebtManager: ["DebtSwapped", "DebtPositionExited"],
};

const SEVERITY_RANK: Record<Severity, number> = { info: 0, high: 1, critical: 2 };

type LogReader = {
    getLogs(filter: { address: string[]; fromBlock: number; toBlock: number }): Promise<ReadonlyArray<Log>>;
};

export async function interfacesFor(artifacts: Artifacts): Promise<Record<ContractName, Interface>> {
    const entries = await Promise.all(
        WATCHED_CONTRACTS.map(async (name) => [name, new Interface((await artifacts.readArtifact(name)).abi)] as const),
    );
    return Object.fromEntries(entries) as Record<ContractName, Interface>;
}

function stringify(value: unknown): string {
    if (typeof value === "bigint") return value.toString();
    if (Array.isArray(value)) return `[${value.map(stringify).join(", ")}]`;
    return String(value);
}

export function decodeAdminLogs(
    logs: ReadonlyArray<Log>,
    watched: Record<string, ContractName>,
    interfaces: Record<ContractName, Interface>,
): Alert[] {
    const alerts: Alert[] = [];
    for (const log of logs) {
        const contract = watched[log.address.toLowerCase()];
        if (!contract) continue;
        const parsed = interfaces[contract].parseLog({ topics: [...log.topics], data: log.data });
        if (!parsed) continue;
        const entry = CATALOGUE.find((e) => e.contract === contract && e.event === parsed.name);
        if (!entry) continue;
        const args: Record<string, string> = {};
        parsed.fragment.inputs.forEach((input, i) => {
            args[input.name || `arg${i}`] = stringify(parsed.args[i]);
        });
        alerts.push({
            severity: entry.severity,
            contract,
            address: log.address,
            event: parsed.name,
            meaning: entry.meaning,
            args,
            blockNumber: log.blockNumber,
            txHash: log.transactionHash,
        });
    }
    return alerts;
}

/** One pass over [fromBlock, toBlock], in chunks the public RPCs accept. */
export async function pollOnce(
    provider: LogReader,
    watched: Record<string, ContractName>,
    interfaces: Record<ContractName, Interface>,
    fromBlock: number,
    toBlock: number,
    chunk = 2_000,
): Promise<Alert[]> {
    const address = Object.keys(watched);
    const alerts: Alert[] = [];
    for (let start = fromBlock; start <= toBlock; start += chunk) {
        const end = Math.min(start + chunk - 1, toBlock);
        alerts.push(
            ...decodeAdminLogs(
                await provider.getLogs({ address, fromBlock: start, toBlock: end }),
                watched,
                interfaces,
            ),
        );
    }
    return alerts;
}

export function formatAlert(alert: Alert, explorer = "https://basescan.org"): string {
    const args = Object.entries(alert.args)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
    return `[${alert.severity.toUpperCase()}] ${alert.contract}.${alert.event} — ${alert.meaning} | ${args} | block ${alert.blockNumber} ${explorer}/tx/${alert.txHash}`;
}

function watchedFromManifest(file: string): Record<string, ContractName> {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const contracts: Record<string, string> = parsed.contracts ?? parsed;
    const watched: Record<string, ContractName> = {};
    for (const [key, address] of Object.entries(contracts)) {
        const name = key.split("#").pop() as ContractName;
        if (WATCHED_CONTRACTS.includes(name)) watched[address.toLowerCase()] = name;
    }
    return watched;
}

async function notify(webhook: string, text: string): Promise<void> {
    const response = await fetch(webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
    });
    if (!response.ok) console.error(`webhook returned ${response.status}`);
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const provider = hre.ethers.provider;
    const watched = watchedFromManifest(path.resolve(env.MANIFEST || "deployments/base.json"));
    const interfaces = await interfacesFor(hre.artifacts);
    const stateFile = path.resolve(env.STATE_FILE || ".watch-admin-events.json");
    const minRank = SEVERITY_RANK[(env.MIN_SEVERITY as Severity) || "info"] ?? 0;
    const explorer = env.EXPLORER_URL || "https://basescan.org";
    const interval = Number(env.POLL_INTERVAL_MS || "60000");

    let last: number = fs.existsSync(stateFile)
        ? JSON.parse(fs.readFileSync(stateFile, "utf8")).lastBlock
        : Number(env.START_BLOCK || (await provider.getBlockNumber())) - 1;
    console.log(`Watching ${Object.keys(watched).length} contracts from block ${last + 1}:`);
    for (const [address, name] of Object.entries(watched)) console.log(`  ${name.padEnd(20)} ${address}`);

    for (;;) {
        const head = await provider.getBlockNumber();
        if (head > last) {
            const alerts = await pollOnce(provider, watched, interfaces, last + 1, head);
            for (const alert of alerts) {
                if (SEVERITY_RANK[alert.severity] < minRank) continue;
                const line = formatAlert(alert, explorer);
                console.log(line);
                if (env.ALERT_WEBHOOK_URL) await notify(env.ALERT_WEBHOOK_URL, line);
            }
            last = head;
            fs.writeFileSync(stateFile, JSON.stringify({ lastBlock: last, updatedAt: new Date().toISOString() }));
        }
        if (env.ONCE === "true") return;
        await new Promise((resolve) => setTimeout(resolve, interval));
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
