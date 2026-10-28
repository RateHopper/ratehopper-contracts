import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { OSERO_REFERRAL_CODE } from "../../contractAddresses";
import {
    AMOUNT,
    FORK_BLOCK,
    HOUR,
    PSM3_ADDR,
    SKY_PARAM,
    SUSDS_ADDR,
    Stack,
    USDC_ADDR,
    deployStack,
    feed,
    psm3,
    resetFork,
    ssr,
    susds,
    usdc,
} from "../helpers/savingsForkStack";
import {
    MAX_DISAGREEMENT_BPS,
    MAX_FEED_AGE,
    MAX_RATE,
    MAX_TOLERANCE_BPS,
    PERF_FEE_BPS,
    SKY,
    TOLERANCE,
    USDC,
    closeParams,
    openParams,
    sharesFor,
    slotValue,
    switchParams,
    timelockCall,
    tokenIdOf,
    usdcFor,
    withdrawParams,
} from "../helpers/savingsHarness";

// ─────────────────────────────────────────────────────────────────────────
//  Base-fork integration for SkySavingsYieldHandler against the REAL
//  Spark PSM3, sUSDS, Chainlink sUSDS/USDS feed and SSR oracle. The mock
//  suites prove the handler's rules against mocks that mirror the venue;
//  this suite proves the venue addresses, the PSM3 swapExactIn calldata
//  (referral code included), the feed's decimals and heartbeat, the
//  Chainlink/SSR agreement and the compatibility of the oracle floor with
//  what PSM3 actually pays all hold on chain.
// ─────────────────────────────────────────────────────────────────────────


const open = (f: Stack, safeAddr: string, overrides: Record<string, any> = {}) =>
    f.manager.connect(f.operator).open(SKY, openParams(safeAddr, SKY_PARAM, { usdcAmount: AMOUNT, ...overrides }));
const close = (f: Stack, safeAddr: string, overrides: Record<string, any> = {}) =>
    f.manager.connect(f.operator).close(SKY, closeParams(safeAddr, tokenIdOf(safeAddr), overrides));
const sharesOf = async (f: Stack, safeAddr: string) =>
    slotValue(f.managerAddr, await f.handler.savingsSharesSlot(tokenIdOf(safeAddr)));
const totalShares = async (f: Stack) => slotValue(f.managerAddr, await f.handler.savingsTotalSharesSlot());
const touchedPsm3 = (receipt: any) =>
    receipt.logs.some((log: any) => log.address.toLowerCase() === PSM3_ADDR.toLowerCase());
const quoteAt = (receipt: any, assetIn: string, assetOut: string, amountIn: bigint): Promise<bigint> =>
    psm3.previewSwapExactIn(assetIn, assetOut, amountIn, { blockTag: receipt.blockNumber });
const feeOn = (value: bigint, basis: bigint) => (value > basis ? ((value - basis) * PERF_FEE_BPS) / 10_000n : 0n);

function logArgs(contract: any, receipt: any, name: string) {
    for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== String(contract.target).toLowerCase()) continue;
        const parsed = contract.interface.parseLog(log);
        if (parsed?.name === name) return parsed.args;
    }
    throw new Error(`${name} was not emitted`);
}

describe("SafeYieldManager + Sky savings - integration (Base fork)", function () {
    this.timeout(300_000);

    before(async function () {
        await resetFork(FORK_BLOCK);
    });

    after(async function () {
        await resetFork(process.env.BASE_FORK_BLOCK_NUMBER ? Number(process.env.BASE_FORK_BLOCK_NUMBER) : undefined);
    });

    it("prices sUSDS from a fresh 18-decimal Chainlink round the live SSR oracle agrees with, inside PSM3's own quote", async function () {
        const f = await loadFixture(deployStack);
        expect(await feed.decimals()).to.equal(18);
        const [, answer, , updatedAt] = await feed.latestRoundData();
        expect((await time.latest()) - Number(updatedAt)).to.be.lessThan(MAX_FEED_AGE);

        const rate = await f.provider.rate(SUSDS_ADDR);
        expect(rate).to.equal(answer);
        expect(rate).to.be.gte(10n ** 18n);
        expect(rate).to.be.lte(MAX_RATE);
        const ssrRate = (await ssr.getConversionRate()) / 10n ** 9n;
        const disagreement = rate > ssrRate ? rate - ssrRate : ssrRate - rate;
        expect(disagreement * 10_000n).to.be.lte(ssrRate * BigInt(MAX_DISAGREEMENT_BPS));

        const quoted = await psm3.previewSwapExactIn(USDC_ADDR, SUSDS_ADDR, AMOUNT);
        const expected = sharesFor(AMOUNT, rate);
        const gap = quoted > expected ? quoted - expected : expected - quoted;
        expect(gap * 10_000n).to.be.lte(expected * BigInt(TOLERANCE));

        expect(await usdc.balanceOf(await psm3.pocket())).to.be.greaterThan(AMOUNT);
        expect(await f.handler.PSM3()).to.equal(PSM3_ADDR);
        expect(await f.handler.SUSDS()).to.equal(SUSDS_ADDR);
        expect(await f.handler.REFERRAL_CODE()).to.equal(OSERO_REFERRAL_CODE);
    });

    it("deposits the Safe's USDC into sUSDS through the real PSM3 with the Osero referral code and redeems it back", async function () {
        const f = await loadFixture(deployStack);
        const { manager, managerEvents, handlerAddr, treasury, safeAddr, managerAddr } = f;
        const tokenId = tokenIdOf(safeAddr);
        const rate = await f.provider.rate(SUSDS_ADDR);
        const usdcStart = await usdc.balanceOf(safeAddr);
        const treasuryStart = await usdc.balanceOf(treasury.address);

        const openReceipt = await (await open(f, safeAddr)).wait();
        const shares = await susds.balanceOf(safeAddr);
        expect(shares).to.equal(await quoteAt(openReceipt, USDC_ADDR, SUSDS_ADDR, AMOUNT));
        expect(shares).to.be.gte((sharesFor(AMOUNT, rate) * BigInt(10_000 - TOLERANCE)) / 10_000n);
        expect(await usdc.balanceOf(safeAddr)).to.equal(usdcStart - AMOUNT);
        expect(await usdc.allowance(safeAddr, PSM3_ADDR)).to.equal(0);
        const swapIn = logArgs(psm3, openReceipt, "Swap");
        expect([
            swapIn.assetIn,
            swapIn.assetOut,
            swapIn.receiver,
            swapIn.amountIn,
            swapIn.amountOut,
            swapIn.referralCode,
        ]).to.deep.equal([USDC_ADDR, SUSDS_ADDR, safeAddr, AMOUNT, shares, OSERO_REFERRAL_CODE]);
        const deposited = logArgs(managerEvents, openReceipt, "SavingsDeposited");
        expect([deposited.usdcIn, deposited.sharesOut, deposited.rate]).to.deep.equal([AMOUNT, shares, rate]);
        const opened = logArgs(manager, openReceipt, "PositionOpened");
        expect([opened.tokenId, opened.usdcInput, opened.used0, opened.used1, opened.currentValueUsd6]).to.deep.equal([
            tokenId,
            AMOUNT,
            AMOUNT,
            shares,
            AMOUNT,
        ]);
        expect(await manager.residualBasisUsd6Of(SKY, tokenId)).to.equal(AMOUNT);
        expect(await manager.positionHandlerOf(SKY, tokenId)).to.equal(handlerAddr);
        expect(await sharesOf(f, safeAddr)).to.equal(shares);
        expect(await totalShares(f)).to.equal(shares);

        const closeReceipt = await (await close(f, safeAddr)).wait();
        const quotedUsdc = await quoteAt(closeReceipt, SUSDS_ADDR, USDC_ADDR, shares);
        const closed = logArgs(manager, closeReceipt, "PositionClosed");
        expect(closed.basisUsd6).to.equal(AMOUNT);
        expect(closed.currentValueUsd6).to.equal(quotedUsdc);
        expect(quotedUsdc).to.be.gte((usdcFor(shares, rate) * BigInt(10_000 - TOLERANCE)) / 10_000n);
        expect(closed.feeUsd6).to.equal(feeOn(quotedUsdc, AMOUNT));
        expect(closed.exitBps).to.equal(10_000);
        const swapOut = logArgs(psm3, closeReceipt, "Swap");
        expect([
            swapOut.assetIn,
            swapOut.assetOut,
            swapOut.receiver,
            swapOut.amountIn,
            swapOut.amountOut,
            swapOut.referralCode,
        ]).to.deep.equal([SUSDS_ADDR, USDC_ADDR, safeAddr, shares, quotedUsdc, OSERO_REFERRAL_CODE]);
        expect(await susds.balanceOf(safeAddr)).to.equal(0);
        expect(await susds.allowance(safeAddr, PSM3_ADDR)).to.equal(0);
        expect(await usdc.balanceOf(safeAddr)).to.equal(usdcStart - AMOUNT + quotedUsdc - closed.feeUsd6);
        expect((await usdc.balanceOf(treasury.address)) - treasuryStart).to.equal(closed.feeUsd6);
        expect(await manager.residualBasisUsd6Of(SKY, tokenId)).to.equal(0);
        expect(await manager.positionHandlerOf(SKY, tokenId)).to.equal(ethers.ZeroAddress);
        expect(await sharesOf(f, safeAddr)).to.equal(0);
        expect(await totalShares(f)).to.equal(0);
        expect(await usdc.balanceOf(managerAddr)).to.equal(0);
        expect(await susds.balanceOf(managerAddr)).to.equal(0);
    });

    it("charges the performance fee on the yield the live SSR oracle accrues", async function () {
        const f = await loadFixture(deployStack);
        const { manager, treasury, safeAddr } = f;
        await (await open(f, safeAddr)).wait();
        const shares = await susds.balanceOf(safeAddr);
        const usdcBefore = await usdc.balanceOf(safeAddr);
        const treasuryBefore = await usdc.balanceOf(treasury.address);
        const ssrBefore = await ssr.getConversionRate();
        const [, , , updatedAt] = await feed.latestRoundData();
        expect((await time.latest()) - Number(updatedAt) + 12 * HOUR).to.be.lessThan(MAX_FEED_AGE);
        await time.increase(12 * HOUR);
        expect(await ssr.getConversionRate()).to.be.greaterThan(ssrBefore);

        const receipt = await (await close(f, safeAddr)).wait();
        const closed = logArgs(manager, receipt, "PositionClosed");
        const value: bigint = closed.currentValueUsd6;
        expect(value).to.equal(await quoteAt(receipt, SUSDS_ADDR, USDC_ADDR, shares));
        expect(value).to.be.greaterThan(AMOUNT);
        const fee = feeOn(value, AMOUNT);
        expect(fee).to.be.greaterThan(0);
        expect(closed.feeUsd6).to.equal(fee);
        expect((await usdc.balanceOf(treasury.address)) - treasuryBefore).to.equal(fee);
        expect((await usdc.balanceOf(safeAddr)) - usdcBefore).to.equal(value - fee);
    });

    it("partially closes on the live venue and prorates shares and basis", async function () {
        const f = await loadFixture(deployStack);
        const { manager, safeAddr } = f;
        const tokenId = tokenIdOf(safeAddr);
        await (await open(f, safeAddr)).wait();
        const shares = await susds.balanceOf(safeAddr);
        const toRedeem = (shares * 2_500n) / 10_000n;

        const receipt = await (await close(f, safeAddr, { exitBps: 2_500 })).wait();
        const closed = logArgs(manager, receipt, "PositionClosed");
        expect(closed.basisUsd6).to.equal(AMOUNT / 4n);
        expect(closed.currentValueUsd6).to.equal(await quoteAt(receipt, SUSDS_ADDR, USDC_ADDR, toRedeem));
        expect(closed.exitBps).to.equal(2_500);
        expect(await susds.balanceOf(safeAddr)).to.equal(shares - toRedeem);
        expect(await sharesOf(f, safeAddr)).to.equal(shares - toRedeem);
        expect(await totalShares(f)).to.equal(shares - toRedeem);
        expect(await manager.residualBasisUsd6Of(SKY, tokenId)).to.equal(AMOUNT - AMOUNT / 4n);

        await (await close(f, safeAddr)).wait();
        expect(await susds.balanceOf(safeAddr)).to.equal(0);
        expect(await manager.residualBasisUsd6Of(SKY, tokenId)).to.equal(0);
        expect(await sharesOf(f, safeAddr)).to.equal(0);
    });

    it("forwards the oracle floor and the caller floor to PSM3's minAmountOut on both legs", async function () {
        const f = await loadFixture(deployStack);
        const { manager, timelock, safeAddr } = f;

        // Chainlink 40 bps BELOW the live SSR rate: the deposit floor demands more
        // shares than PSM3 pays; the redeem floor sits below what it pays.
        const low = await f.deployOffsetBuild(-40);
        await (await timelockCall(timelock, manager, "setYieldHandler", [SKY, await low.getAddress()])).wait();
        await (await manager.connect(f.pauser).setProtocolEnabledForOpen(SKY, true)).wait();
        await expect(open(f, safeAddr, { slippageBps: 1 })).to.be.revertedWith("PSM3/amountOut-too-low");
        await (await open(f, safeAddr, { slippageBps: MAX_TOLERANCE_BPS })).wait();
        await expect(close(f, safeAddr, { minUsdcOut: AMOUNT * 2n })).to.be.revertedWith("PSM3/amountOut-too-low");
        await (await close(f, safeAddr, { slippageBps: 1 })).wait();
        expect(await susds.balanceOf(safeAddr)).to.equal(0);

        // Chainlink 40 bps ABOVE the live SSR rate: deposits pass at any tolerance,
        // the redeem floor is above what PSM3 pays until the tolerance covers it.
        const high = await f.deployOffsetBuild(40);
        await (await timelockCall(timelock, manager, "setYieldHandler", [SKY, await high.getAddress()])).wait();
        await (await manager.connect(f.pauser).setProtocolEnabledForOpen(SKY, true)).wait();
        await (await open(f, safeAddr, { slippageBps: 1 })).wait();
        await expect(close(f, safeAddr, { slippageBps: 1 })).to.be.revertedWith("PSM3/amountOut-too-low");
        await (await close(f, safeAddr, { slippageBps: MAX_TOLERANCE_BPS })).wait();
        expect(await susds.balanceOf(safeAddr)).to.equal(0);
    });

    it("fails closed on open and close once the live round is older than 36h, but still releases in kind", async function () {
        const f = await loadFixture(deployStack);
        const { manager, managerEvents, provider, safeAddr, safe2Addr } = f;
        const tokenId = tokenIdOf(safeAddr);
        await (await open(f, safeAddr)).wait();
        const shares = await susds.balanceOf(safeAddr);

        await time.increase(MAX_FEED_AGE + 1);
        const [, , , updatedAt] = await feed.latestRoundData();
        await expect(provider.rate(SUSDS_ADDR))
            .to.be.revertedWithCustomError(provider, "StaleRate")
            .withArgs(updatedAt);
        await expect(open(f, safe2Addr)).to.be.revertedWithCustomError(provider, "StaleRate");
        await expect(close(f, safeAddr)).to.be.revertedWithCustomError(provider, "StaleRate");

        const receipt = await (
            await manager.connect(f.operator).withdraw(SKY, withdrawParams(safeAddr, tokenId))
        ).wait();
        expect(logArgs(managerEvents, receipt, "SavingsReleased").shares).to.equal(shares);
        const withdrawn = logArgs(manager, receipt, "PositionWithdrawn");
        expect([withdrawn.releasedBasisUsd6, withdrawn.amount0, withdrawn.amount1]).to.deep.equal([AMOUNT, 0n, shares]);
        expect(touchedPsm3(receipt)).to.equal(false);
        expect(await susds.balanceOf(safeAddr)).to.equal(shares);
        expect(await manager.residualBasisUsd6Of(SKY, tokenId)).to.equal(0);
        expect(await sharesOf(f, safeAddr)).to.equal(0);
        expect(await totalShares(f)).to.equal(0);
    });

    it("caps the book against the live PSM3 pocket", async function () {
        const f = await loadFixture(deployStack);
        const { manager, timelock, safeAddr } = f;
        const pocket = await usdc.balanceOf(await psm3.pocket());
        const thin = await f.deployBuild(1);
        await (await timelockCall(timelock, manager, "setYieldHandler", [SKY, await thin.getAddress()])).wait();
        await (await manager.connect(f.pauser).setProtocolEnabledForOpen(SKY, true)).wait();
        const cap = pocket / 10_000n;
        await expect(open(f, safeAddr, { usdcAmount: cap + 1n }))
            .to.be.revertedWithCustomError(thin, "ExposureCapExceeded")
            .withArgs(cap + 1n, pocket);
        await (await open(f, safeAddr, { usdcAmount: cap })).wait();
        expect(await manager.residualBasisUsd6Of(SKY, tokenIdOf(safeAddr))).to.equal(cap);
    });

    it("rolls a live position onto a new build through switchPosition(3, 3) without touching PSM3, then the new build redeems", async function () {
        const f = await loadFixture(deployStack);
        const { manager, managerEvents, timelock, safeAddr } = f;
        const tokenId = tokenIdOf(safeAddr);
        await (await open(f, safeAddr)).wait();
        const shares = await susds.balanceOf(safeAddr);
        const build2 = await f.deployBuild();
        const build2Addr = await build2.getAddress();
        await (await timelockCall(timelock, manager, "setYieldHandler", [SKY, build2Addr])).wait();
        await (await manager.connect(f.pauser).setProtocolEnabledForOpen(SKY, true)).wait();
        const usdcBefore = await usdc.balanceOf(safeAddr);
        const venueSharesBefore = await susds.balanceOf(PSM3_ADDR);

        const receipt = await (
            await manager.connect(f.operator).switchPosition(SKY, SKY, switchParams(safeAddr, tokenId, SKY_PARAM))
        ).wait();
        const switched = logArgs(manager, receipt, "PositionSwitched");
        expect([
            switched.oldTokenId,
            switched.newTokenId,
            switched.carriedBasisUsd6,
            switched.withdrawn0,
            switched.withdrawn1,
            switched.used0,
            switched.used1,
        ]).to.deep.equal([tokenId, tokenId, AMOUNT, 0n, shares, 0n, shares]);
        expect(logArgs(managerEvents, receipt, "SavingsReleased").shares).to.equal(shares);
        expect(logArgs(managerEvents, receipt, "SavingsAdopted").shares).to.equal(shares);
        expect(touchedPsm3(receipt)).to.equal(false);
        expect(await susds.balanceOf(safeAddr)).to.equal(shares);
        expect(await susds.balanceOf(PSM3_ADDR)).to.equal(venueSharesBefore);
        expect(await usdc.balanceOf(safeAddr)).to.equal(usdcBefore);
        expect(await manager.positionHandlerOf(SKY, tokenId)).to.equal(build2Addr);
        expect(await manager.residualBasisUsd6Of(SKY, tokenId)).to.equal(AMOUNT);
        expect(await sharesOf(f, safeAddr)).to.equal(shares);
        expect(await totalShares(f)).to.equal(shares);

        const closeReceipt = await (await close(f, safeAddr)).wait();
        const closed = logArgs(manager, closeReceipt, "PositionClosed");
        expect(closed.basisUsd6).to.equal(AMOUNT);
        expect(await susds.balanceOf(safeAddr)).to.equal(0);
        expect(await usdc.balanceOf(safeAddr)).to.equal(usdcBefore + closed.currentValueUsd6 - closed.feeUsd6);
    });
});
