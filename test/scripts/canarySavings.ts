import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { FORK_BLOCK, Stack, deployStack, resetFork } from "../helpers/savingsForkStack";
import { SKY } from "../helpers/savingsHarness";
import { readCanaryConfig, runCanary, evaluateOpen, evaluateClose, Snapshot } from "../../scripts/canarySavings";

// ─────────────────────────────────────────────────────────────────────────
//  The first-deploy canary is a wiring test, not a code test: it drives one
//  small open and close through the deployed manager, the registry operator
//  and the real venue, and judges the result from balances and records
//  rather than from the transaction succeeding.
// ─────────────────────────────────────────────────────────────────────────

const envFor = (f: Stack, over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    ...process.env,
    CALLER: "operator",
    DRY_RUN: "false",
    SAFE_ADDRESS: f.safeAddr,
    MANAGER_ADDRESS: f.managerAddr,
    USDC_AMOUNT: "1",
    CANARY_TOLERANCE_BPS: "",
    ...over,
});

const senderFor = (f: Stack) => {
    const sent: string[] = [];
    const sender = async (_cfg: unknown, built: { target: string; data: string }) => {
        const tx = await f.operator.sendTransaction({ to: built.target, data: built.data });
        sent.push(tx.hash);
        return tx.hash;
    };
    return { sender, sent };
};

const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
    safeUsdc: 0n,
    safeSusds: 0n,
    basis: 0n,
    tracked: 0n,
    pinned: ethers.ZeroAddress,
    ...over,
});

describe("scripts/canarySavings", function () {
    describe("evaluation", function () {
        const amount = 1_000_000n;
        const shares = 909_090_909_090_909_090n;
        const rate = 1_100_000_000_000_000_000n;

        it("accepts an open whose record, balances and oracle value all line up", function () {
            const checks = evaluateOpen({
                before: snapshot({ safeUsdc: 5_000_000n }),
                after: snapshot({
                    safeUsdc: 4_000_000n,
                    safeSusds: shares,
                    basis: amount,
                    tracked: shares,
                    pinned: "0x1",
                }),
                amount,
                rate,
                events: ["PositionOpened", "SavingsDeposited"],
                toleranceBps: 50,
            });
            expect(checks.filter((c) => !c.ok)).to.deep.equal([]);
        });

        it("rejects an open whose basis or share delta disagree with the record", function () {
            const checks = evaluateOpen({
                before: snapshot({ safeUsdc: 5_000_000n }),
                after: snapshot({
                    safeUsdc: 4_000_000n,
                    safeSusds: shares - 1n,
                    basis: amount + 1n,
                    tracked: shares,
                    pinned: "0x1",
                }),
                amount,
                rate,
                events: ["PositionOpened"],
                toleranceBps: 50,
            });
            expect(checks.filter((c) => !c.ok).map((c) => c.name)).to.deep.equal([
                "SavingsDeposited emitted",
                "basis equals the deposit",
                "shares received equal the record",
            ]);
        });

        it("rejects a close that returns less USDC than the tolerance allows or leaves a record behind", function () {
            const checks = evaluateClose({
                before: snapshot({
                    safeUsdc: 4_000_000n,
                    safeSusds: shares,
                    basis: amount,
                    tracked: shares,
                    pinned: "0x1",
                }),
                after: snapshot({
                    safeUsdc: 4_000_000n + 990_000n,
                    safeSusds: 0n,
                    basis: 0n,
                    tracked: 1n,
                    pinned: ethers.ZeroAddress,
                }),
                amount,
                events: ["PositionClosed", "SavingsRedeemed"],
                toleranceBps: 50,
            });
            expect(checks.filter((c) => !c.ok).map((c) => c.name)).to.deep.equal([
                "record cleared",
                "USDC returned within tolerance",
            ]);
        });
    });

    describe("on the Base fork", function () {
        this.timeout(300_000);

        before(async function () {
            await resetFork(FORK_BLOCK);
        });

        after(async function () {
            await resetFork(
                process.env.BASE_FORK_BLOCK_NUMBER ? Number(process.env.BASE_FORK_BLOCK_NUMBER) : undefined,
            );
        });

        it("passes every check through a real open and close against the forked PSM3", async function () {
            const f = await loadFixture(deployStack);
            const { sender, sent } = senderFor(f);
            const result = await runCanary(readCanaryConfig(envFor(f)), sender);
            expect(result.checks.filter((c) => !c.ok)).to.deep.equal([]);
            expect(result.ok).to.equal(true);
            expect(sent).to.have.length(2);
            expect(await f.manager.positionHandlerOf(SKY, BigInt(f.safeAddr))).to.equal(ethers.ZeroAddress);
        });

        it("stops at preflight and sends nothing while opens are disabled", async function () {
            const f = await loadFixture(deployStack);
            await (await f.manager.connect(f.pauser).setProtocolEnabledForOpen(SKY, false)).wait();
            const { sender, sent } = senderFor(f);
            const result = await runCanary(readCanaryConfig(envFor(f)), sender);
            expect(result.ok).to.equal(false);
            expect(sent).to.have.length(0);
            expect(result.checks.find((c) => c.name === "opens enabled")!.ok).to.equal(false);
        });
    });
});
