import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { FORK_BLOCK, Stack, deployStack, resetFork } from "../helpers/savingsForkStack";
import { SKY } from "../helpers/savingsHarness";
import { waitForReceipt } from "../../scripts/lpSafeShared";
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

        it("treats sender failure without a hash as unknown even when no transaction was sent", async function () {
            const f = await loadFixture(deployStack);
            const result = await runCanary(readCanaryConfig(envFor(f)), async () => {
                throw new Error("rpc down");
            });
            expect(result.ok).to.equal(false);
            expect(result.stage).to.equal("open");
            expect(result.checks[result.checks.length - 1]).to.include({ name: "open confirmed", ok: false });
            expect(result.note).to.include("Open outcome unknown");
            expect(result.note).to.include("Do not retry");
            expect(await f.manager.positionHandlerOf(SKY, BigInt(f.safeAddr))).to.equal(ethers.ZeroAddress);
        });

        it("reports an uncertain close after a confirmed open", async function () {
            const f = await loadFixture(deployStack);
            let calls = 0;
            const sender = async (_cfg: unknown, built: { target: string; data: string }) => {
                calls += 1;
                if (calls === 2) throw new Error("rpc down");
                return (await f.operator.sendTransaction({ to: built.target, data: built.data })).hash;
            };
            const result = await runCanary(readCanaryConfig(envFor(f)), sender);
            expect(result.ok).to.equal(false);
            expect(result.stage).to.equal("close");
            expect(result.checks[result.checks.length - 1]).to.include({ name: "close confirmed", ok: false });
            expect(result.note).to.include("Close outcome unknown");
            expect(await f.manager.positionHandlerOf(SKY, BigInt(f.safeAddr))).to.not.equal(ethers.ZeroAddress);
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

        it("stops before sending when the manager is globally paused", async function () {
            const f = await loadFixture(deployStack);
            await f.manager.connect(f.pauser).pause();
            const { sender, sent } = senderFor(f);
            const result = await runCanary(readCanaryConfig(envFor(f)), sender);
            expect(result.stage).to.equal("preflight");
            expect(result.checks.find((c) => c.name === "manager unpaused")!.ok).to.equal(false);
            expect(sent).to.have.length(0);
        });

        it("rejects invalid tolerance before calling the sender", async function () {
            const f = await loadFixture(deployStack);
            for (const value of ["-1", "301", "10000", "1.5", "NaN", "Infinity"]) {
                expect(() => readCanaryConfig(envFor(f, { CANARY_TOLERANCE_BPS: value }))).to.throw(
                    "CANARY_TOLERANCE_BPS",
                );
            }
            const { sender, sent } = senderFor(f);
            await expect(runCanary({ ...readCanaryConfig(envFor(f)), toleranceBps: NaN }, sender)).to.be.rejected;
            expect(sent).to.have.length(0);
        });

        it("rejects zero, negative and oversized deposits before calling the sender", async function () {
            const f = await loadFixture(deployStack);
            for (const amount of ["0", "-1", "340282366920938463463374607431768211456"]) {
                expect(() => readCanaryConfig(envFor(f, { USDC_AMOUNT: amount }))).to.throw("USDC_AMOUNT");
            }
            const { sender, sent } = senderFor(f);
            await expect(runCanary({ ...readCanaryConfig(envFor(f)), usdcAmount: 0n }, sender)).to.be.rejectedWith(
                "USDC_AMOUNT",
            );
            expect(sent).to.have.length(0);
        });

        for (const lostAction of ["open", "close"]) {
            it(`reports unknown after a confirmed ${lostAction} whose broadcast response is lost`, async function () {
                const f = await loadFixture(deployStack);
                let calls = 0;
                const result = await runCanary(readCanaryConfig(envFor(f)), async (cfg, built) => {
                    calls++;
                    const tx = await f.operator.sendTransaction({ to: built.target, data: built.data });
                    await tx.wait();
                    if (cfg.action === lostAction) throw new Error("response lost after broadcast accepted");
                    return tx.hash;
                });
                expect(result.ok).to.equal(false);
                expect(result.stage).to.equal(lostAction);
                expect(result.note).to.include("outcome unknown");
                expect(result.note).not.to.include("nothing to clean up");
                expect(calls).to.equal(lostAction === "open" ? 1 : 2);
                const pin = await f.manager.positionHandlerOf(SKY, BigInt(f.safeAddr));
                expect(pin === ethers.ZeroAddress).to.equal(lostAction === "close");
                if (lostAction === "open") {
                    const retry = senderFor(f);
                    expect((await runCanary(readCanaryConfig(envFor(f)), retry.sender)).stage).to.equal("preflight");
                    expect(retry.sent).to.have.length(0);
                }
            });
        }

        it("keeps a pending open unknown after a receipt timeout and never retries it", async function () {
            const f = await loadFixture(deployStack);
            const { sender, sent } = senderFor(f);
            await network.provider.send("evm_setAutomine", [false]);
            try {
                const result = await runCanary(readCanaryConfig(envFor(f)), sender, async () => {
                    throw new Error("receipt timeout");
                });
                expect(result.note).to.include("Open outcome unknown");
                expect(result.note).to.include(sent[0]);
                expect(sent).to.have.length(1);
                expect(await f.manager.positionHandlerOf(SKY, BigInt(f.safeAddr))).to.equal(ethers.ZeroAddress);
                await network.provider.send("evm_mine");
                expect(await f.manager.positionHandlerOf(SKY, BigInt(f.safeAddr))).not.to.equal(ethers.ZeroAddress);
            } finally {
                await network.provider.send("evm_setAutomine", [true]);
            }
        });

        it("does not close automatically after an open receipt read failure", async function () {
            const f = await loadFixture(deployStack);
            const { sender, sent } = senderFor(f);
            const result = await runCanary(readCanaryConfig(envFor(f)), sender, async () => {
                throw new Error("receipt RPC unavailable");
            });
            expect(result.note).to.include("Open outcome unknown");
            expect(result.note).to.include(sent[0]);
            expect(sent).to.have.length(1);
            expect(await f.manager.positionHandlerOf(SKY, BigInt(f.safeAddr))).not.to.equal(ethers.ZeroAddress);
        });

        it("reports a known close hash as uncertain when the receipt read fails", async function () {
            const f = await loadFixture(deployStack);
            const { sender, sent } = senderFor(f);
            let receipts = 0;
            const result = await runCanary(readCanaryConfig(envFor(f)), sender, async (provider, hash) => {
                if (++receipts === 2) throw new Error("close receipt RPC unavailable");
                return waitForReceipt(provider, hash);
            });
            expect(result.stage).to.equal("close");
            expect(result.ok).to.equal(false);
            expect(result.note).to.include("Close outcome unknown");
            expect(result.note).to.include(sent[1]);
            expect(sent).to.have.length(2);
            expect(await f.manager.positionHandlerOf(SKY, BigInt(f.safeAddr))).to.equal(ethers.ZeroAddress);
        });
    });
});
