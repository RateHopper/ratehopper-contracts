import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import {
    Harness,
    PERF_FEE_BPS,
    RATE,
    SKY,
    SKY_SRC,
    USDC,
    YIELD_FIELD,
    YIELD_SLOT,
    bps,
    closeParams,
    deployRegistered,
    mapSlot,
    open,
    safeSigner,
    sharesOf,
    slotValue,
    tokenIdOf,
    totalShares,
    withdraw,
    yieldSlot,
} from "../helpers/idleSavingsHarness";

// ─────────────────────────────────────────────────────────────────────────
//  Invariant suite for the Sky idle savings handler: a seeded random walk
//  of opens, closes with random exitBps, in-kind withdrawals, feed and SSR
//  moves inside and outside the tolerance, pocket drains and refills, and
//  Safe-side share transfers around the module, across three Safes. Every
//  action may revert; the properties below must hold after every step.
// ─────────────────────────────────────────────────────────────────────────

const STEPS = Number(process.env.IDLE_INVARIANT_STEPS ?? 200);
const SEED = Number(process.env.IDLE_INVARIANT_SEED ?? 1);
const EXIT_BPS = [1, 250, 2_500, 5_000, 9_999, 10_000];

function mulberry32(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

describe("idle savings invariants (Sky)", function () {
    it(`holds every property over ${STEPS} random steps (seed ${SEED})`, async function () {
        const f: Harness = await loadFixture(deployRegistered);
        const src = SKY_SRC;
        const { manager, usdc, susds, psm3Addr, stranger } = f;
        const Safe = await ethers.getContractFactory("MockSafeHarness");
        const safe3 = await Safe.deploy();
        await safe3.waitForDeployment();
        const safe3Addr = await safe3.getAddress();
        await (await usdc.mint(safe3Addr, USDC(2_000_000))).wait();
        const safes = [f.safeAddr, f.safe2Addr, safe3Addr];

        const rnd = mulberry32(SEED);
        const pick = (n: number) => Math.floor(rnd() * n);
        const basis: Record<string, bigint> = Object.fromEntries(safes.map((s) => [s, 0n]));
        const leakedSinceSync: Record<string, bigint> = Object.fromEntries(safes.map((s) => [s, 0n]));
        let ssrRate = RATE;
        let feedRate = RATE;
        const refreshFeed = async () => void (await (await f.feed.set(feedRate, await time.latest())).wait());

        const protectedSlots: Record<string, string> = {
            scalar: ethers.toBeHex(YIELD_SLOT, 32),
            basis01: yieldSlot(YIELD_FIELD.residualBasis, 0, 1n),
            pin01: yieldSlot(YIELD_FIELD.positionHandler, 0, 1n),
            carry01: yieldSlot(YIELD_FIELD.carry, 0, 1n),
            allowed0: mapSlot(BigInt(ethers.keccak256(f.feeTier)), BigInt(mapSlot(0n, YIELD_SLOT + YIELD_FIELD.allowedPoolKey))),
        };
        const protectedBefore: Record<string, bigint> = {};
        for (const [k, slot] of Object.entries(protectedSlots)) protectedBefore[k] = await slotValue(f.managerAddr, slot);

        const actions: Array<{ name: string; run: () => Promise<void> }> = [
            {
                name: "open",
                run: async () => {
                    const s = safes[pick(safes.length)];
                    const amount = USDC(10 + pick(300_000));
                    await (await open(f, src, s, { usdcAmount: amount, slippageBps: 50 })).wait();
                    basis[s] = amount;
                    leakedSinceSync[s] = 0n;
                },
            },
            {
                name: "close",
                run: async () => {
                    const s = safes[pick(safes.length)];
                    const exitBps = EXIT_BPS[pick(EXIT_BPS.length)];
                    const receipt = await (
                        await manager
                            .connect(f.operatorEOA)
                            .closeLp(SKY, closeParams(s, tokenIdOf(s), { exitBps, slippageBps: 50 }))
                    ).wait();
                    const closed = receipt!.logs
                        .map((l: any) => {
                            try {
                                return manager.interface.parseLog(l);
                            } catch {
                                return null;
                            }
                        })
                        .find((l: any) => l && l.name === "PositionClosed")!;
                    const [, , , basisForExit, value, fee, , carryForExit] = closed.args;
                    const realized = value + carryForExit;
                    const expectedFee = realized > basisForExit ? ((realized - basisForExit) * PERF_FEE_BPS) / 10_000n : 0n;
                    expect(fee).to.equal(expectedFee);
                    basis[s] = exitBps === 10_000 ? 0n : basis[s] - basisForExit;
                    leakedSinceSync[s] = 0n;
                },
            },
            {
                name: "withdraw",
                run: async () => {
                    const s = safes[pick(safes.length)];
                    await (await withdraw(f, src, s)).wait();
                    basis[s] = 0n;
                    leakedSinceSync[s] = 0n;
                },
            },
            {
                name: "feed drift",
                run: async () => {
                    feedRate = bps(ssrRate, pick(91) - 45);
                    await refreshFeed();
                },
            },
            {
                name: "feed far",
                run: async () => {
                    feedRate = bps(ssrRate, rnd() < 0.5 ? 60 : -60);
                    await refreshFeed();
                },
            },
            {
                name: "ssr accrue",
                run: async () => {
                    ssrRate = bps(ssrRate, 10);
                    feedRate = ssrRate;
                    await (await f.ssr.set(ssrRate * 10n ** 9n)).wait();
                    await refreshFeed();
                },
            },
            {
                name: "pocket burn",
                run: async () => {
                    const bal = await usdc.balanceOf(psm3Addr);
                    await (await usdc.burn(psm3Addr, (bal * BigInt(pick(100))) / 100n)).wait();
                },
            },
            {
                name: "pocket refill",
                run: async () => void (await (await usdc.mint(psm3Addr, USDC(1_000_000))).wait()),
            },
            {
                name: "shares leak",
                run: async () => {
                    const s = safes[pick(safes.length)];
                    const amount = ((await susds.balanceOf(s)) * BigInt(pick(50))) / 100n;
                    if (amount === 0n) return;
                    await (await susds.connect(await safeSigner(s)).transfer(stranger.address, amount)).wait();
                    leakedSinceSync[s] += amount;
                },
            },
        ];

        const outcomes: Record<string, { ok: number; reverted: number }> = Object.fromEntries(
            actions.map((a) => [a.name, { ok: 0, reverted: 0 }]),
        );

        async function checkInvariants(step: number) {
            let sum = 0n;
            for (const s of safes) {
                const record = await sharesOf(f, src, s);
                sum += record;
                const balance = await susds.balanceOf(s);
                expect(balance + leakedSinceSync[s], `step ${step}: ${s} shares below record`).to.be.greaterThanOrEqual(record);
                expect(await usdc.allowance(s, psm3Addr), `step ${step}: USDC allowance`).to.equal(0);
                expect(await susds.allowance(s, psm3Addr), `step ${step}: sUSDS allowance`).to.equal(0);
                expect(await manager.residualBasisUsd6Of(SKY, tokenIdOf(s)), `step ${step}: basis of ${s}`).to.equal(basis[s]);
            }
            expect(await totalShares(f, src), `step ${step}: total shares`).to.equal(sum);
            expect(await usdc.balanceOf(f.managerAddr), `step ${step}: manager USDC`).to.equal(0);
            expect(await susds.balanceOf(f.managerAddr), `step ${step}: manager sUSDS`).to.equal(0);
            for (const [k, slot] of Object.entries(protectedSlots)) {
                expect(await slotValue(f.managerAddr, slot), `step ${step}: protocol 0 slot ${k}`).to.equal(protectedBefore[k]);
            }
        }

        for (let step = 0; step < STEPS; step++) {
            const action = actions[pick(actions.length)];
            try {
                await action.run();
                outcomes[action.name].ok += 1;
            } catch (e: any) {
                if (e instanceof Error && /AssertionError/.test(e.name)) throw e;
                outcomes[action.name].reverted += 1;
            }
            await checkInvariants(step);
        }

        expect(outcomes.open.ok, "opens").to.be.greaterThan(5);
        expect(outcomes.close.ok, "closes").to.be.greaterThan(3);
        expect(outcomes.withdraw.ok, "withdrawals").to.be.greaterThan(1);
    });
});
