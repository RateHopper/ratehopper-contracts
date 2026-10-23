import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

// ─────────────────────────────────────────────────────────────────────────
//  Unit suite for ChainlinkSsrRateProvider: the sUSDS price source behind
//  the idle savings handler. Every revert path, the 36h staleness boundary,
//  the 50 bps oracle-disagreement boundary, and the deprecated-field rules
//  (answeredInRound and roundId are ignored; only updatedAt governs age).
// ─────────────────────────────────────────────────────────────────────────

const ZERO = "0x0000000000000000000000000000000000000000";
const RATE = 1_100_000_000_000_000_000n; // 1.1e18
const RATE27 = RATE * 10n ** 9n;
const MAX_FEED_AGE = 36 * 3600;
const MAX_DISAGREEMENT_BPS = 50;
const MAX_RATE = 2n * 10n ** 18n;
const ONE_DAY = 86_400;

function bps(rate: bigint, delta: number): bigint {
    return (rate * BigInt(10_000 + delta)) / 10_000n;
}

async function deployProviderHarness() {
    const ERC = await ethers.getContractFactory("MockERC20");
    const susds = await ERC.deploy("Savings USDS", "sUSDS", 18);
    await susds.waitForDeployment();
    const other = await ERC.deploy("Other", "OTH", 18);
    await other.waitForDeployment();

    const Feed = await ethers.getContractFactory("MockAggregatorV3");
    const feed = await Feed.deploy();
    await feed.waitForDeployment();
    await (await feed.set(RATE, await time.latest())).wait();

    const Ssr = await ethers.getContractFactory("MockSSRRateProvider");
    const ssr = await Ssr.deploy();
    await ssr.waitForDeployment();
    await (await ssr.set(RATE27)).wait();

    const Provider = await ethers.getContractFactory("ChainlinkSsrRateProvider");
    const provider = await Provider.deploy(
        await feed.getAddress(),
        await ssr.getAddress(),
        await susds.getAddress(),
        MAX_FEED_AGE,
        MAX_DISAGREEMENT_BPS,
        MAX_RATE,
    );
    await provider.waitForDeployment();

    const Probe = await ethers.getContractFactory("MockRateProbe");
    const probe = await Probe.deploy();
    await probe.waitForDeployment();

    return {
        susds,
        susdsAddr: await susds.getAddress(),
        otherAddr: await other.getAddress(),
        feed,
        feedAddr: await feed.getAddress(),
        ssr,
        ssrAddr: await ssr.getAddress(),
        provider,
        Provider,
        probe,
    };
}

describe("ChainlinkSsrRateProvider", function () {
    describe("constructor", function () {
        it("pins the feed, the oracle, the share token and the bounds", async function () {
            const { provider, feedAddr, ssrAddr, susdsAddr } = await loadFixture(deployProviderHarness);
            expect(await provider.FEED()).to.equal(feedAddr);
            expect(await provider.SSR_ORACLE()).to.equal(ssrAddr);
            expect(await provider.SHARE_TOKEN()).to.equal(susdsAddr);
            expect(await provider.shareToken()).to.equal(susdsAddr);
            expect(await provider.MAX_FEED_AGE()).to.equal(MAX_FEED_AGE);
            expect(await provider.MAX_DISAGREEMENT_BPS()).to.equal(MAX_DISAGREEMENT_BPS);
            expect(await provider.MAX_RATE()).to.equal(MAX_RATE);
        });

        it("rejects zero addresses", async function () {
            const { Provider, provider, feedAddr, ssrAddr, susdsAddr } = await loadFixture(deployProviderHarness);
            await expect(
                Provider.deploy(ZERO, ssrAddr, susdsAddr, MAX_FEED_AGE, MAX_DISAGREEMENT_BPS, MAX_RATE),
            ).to.be.revertedWithCustomError(provider, "ZeroAddress");
            await expect(
                Provider.deploy(feedAddr, ZERO, susdsAddr, MAX_FEED_AGE, MAX_DISAGREEMENT_BPS, MAX_RATE),
            ).to.be.revertedWithCustomError(provider, "ZeroAddress");
            await expect(
                Provider.deploy(feedAddr, ssrAddr, ZERO, MAX_FEED_AGE, MAX_DISAGREEMENT_BPS, MAX_RATE),
            ).to.be.revertedWithCustomError(provider, "ZeroAddress");
        });

        it("rejects a feed that is not 18 decimals", async function () {
            const { Provider, provider, feed, feedAddr, ssrAddr, susdsAddr } = await loadFixture(deployProviderHarness);
            await (await feed.setDecimals(8)).wait();
            await expect(Provider.deploy(feedAddr, ssrAddr, susdsAddr, MAX_FEED_AGE, MAX_DISAGREEMENT_BPS, MAX_RATE))
                .to.be.revertedWithCustomError(provider, "WrongFeedDecimals")
                .withArgs(8);
        });

        it("rejects out-of-range bounds and accepts the edges", async function () {
            const { Provider, provider, feedAddr, ssrAddr, susdsAddr } = await loadFixture(deployProviderHarness);
            await expect(
                Provider.deploy(feedAddr, ssrAddr, susdsAddr, ONE_DAY - 1, MAX_DISAGREEMENT_BPS, MAX_RATE),
            ).to.be.revertedWithCustomError(provider, "InvalidConfig");
            await expect(Provider.deploy(feedAddr, ssrAddr, susdsAddr, MAX_FEED_AGE, 0, MAX_RATE)).to.be.revertedWithCustomError(
                provider,
                "InvalidConfig",
            );
            await expect(
                Provider.deploy(feedAddr, ssrAddr, susdsAddr, MAX_FEED_AGE, 301, MAX_RATE),
            ).to.be.revertedWithCustomError(provider, "InvalidConfig");
            await expect(
                Provider.deploy(feedAddr, ssrAddr, susdsAddr, MAX_FEED_AGE, MAX_DISAGREEMENT_BPS, 10n ** 18n),
            ).to.be.revertedWithCustomError(provider, "InvalidConfig");
            const edge = await Provider.deploy(feedAddr, ssrAddr, susdsAddr, ONE_DAY, 300, 10n ** 18n + 1n);
            await edge.waitForDeployment();
            expect(await edge.MAX_DISAGREEMENT_BPS()).to.equal(300);
        });
    });

    describe("rate", function () {
        it("returns the Chainlink answer when both oracles agree", async function () {
            const { provider, susdsAddr } = await loadFixture(deployProviderHarness);
            expect(await provider.rate(susdsAddr)).to.equal(RATE);
        });

        it("reverts WrongShareToken for any other token", async function () {
            const { provider, otherAddr } = await loadFixture(deployProviderHarness);
            await expect(provider.rate(otherAddr))
                .to.be.revertedWithCustomError(provider, "WrongShareToken")
                .withArgs(otherAddr);
        });

        it("reverts InvalidRate on a zero or negative answer", async function () {
            const { provider, feed, susdsAddr } = await loadFixture(deployProviderHarness);
            await (await feed.set(0, await time.latest())).wait();
            await expect(provider.rate(susdsAddr)).to.be.revertedWithCustomError(provider, "InvalidRate");
            await (await feed.set(-1, await time.latest())).wait();
            await expect(provider.rate(susdsAddr)).to.be.revertedWithCustomError(provider, "InvalidRate");
        });

        it("is stale at 36h + 1s and fresh at exactly 36h", async function () {
            const { provider, feed, probe, susdsAddr } = await loadFixture(deployProviderHarness);
            const updatedAt = (await time.latest()) + 10;
            await (await feed.set(RATE, updatedAt)).wait();

            await time.setNextBlockTimestamp(updatedAt + MAX_FEED_AGE);
            await expect(probe.read(await provider.getAddress(), susdsAddr))
                .to.emit(probe, "Rate")
                .withArgs(RATE);

            await time.setNextBlockTimestamp(updatedAt + MAX_FEED_AGE + 1);
            await expect(probe.read(await provider.getAddress(), susdsAddr))
                .to.be.revertedWithCustomError(provider, "StaleRate")
                .withArgs(updatedAt);
        });

        it("treats a future updatedAt as stale instead of underflowing", async function () {
            const { provider, feed, susdsAddr } = await loadFixture(deployProviderHarness);
            const future = (await time.latest()) + 100_000;
            await (await feed.set(RATE, future)).wait();
            await expect(provider.rate(susdsAddr)).to.be.revertedWithCustomError(provider, "StaleRate").withArgs(future);
        });

        it("treats updatedAt == 0 as stale", async function () {
            const { provider, feed, susdsAddr } = await loadFixture(deployProviderHarness);
            await (await feed.set(RATE, 0)).wait();
            await expect(provider.rate(susdsAddr)).to.be.revertedWithCustomError(provider, "StaleRate").withArgs(0);
        });

        it("reverts RateOutOfBounds below 1e18 and above MAX_RATE", async function () {
            const { provider, feed, susdsAddr } = await loadFixture(deployProviderHarness);
            const low = 10n ** 18n - 1n;
            await (await feed.set(low, await time.latest())).wait();
            await expect(provider.rate(susdsAddr))
                .to.be.revertedWithCustomError(provider, "RateOutOfBounds")
                .withArgs(low);
            const high = MAX_RATE + 1n;
            await (await feed.set(high, await time.latest())).wait();
            await expect(provider.rate(susdsAddr))
                .to.be.revertedWithCustomError(provider, "RateOutOfBounds")
                .withArgs(high);
            await (await feed.set(MAX_RATE, await time.latest())).wait();
            await (await (await ethers.getContractAt("MockSSRRateProvider", await provider.SSR_ORACLE())).set(
                MAX_RATE * 10n ** 9n,
            )).wait();
            expect(await provider.rate(susdsAddr)).to.equal(MAX_RATE);
        });

        it("reverts InvalidRate when the SSR oracle answers zero", async function () {
            const { provider, ssr, susdsAddr } = await loadFixture(deployProviderHarness);
            await (await ssr.set(0)).wait();
            await expect(provider.rate(susdsAddr)).to.be.revertedWithCustomError(provider, "InvalidRate");
        });

        it("vetoes a 51 bps disagreement in either direction and passes 49 and 50", async function () {
            const { provider, feed, susdsAddr } = await loadFixture(deployProviderHarness);
            const ssrRate = RATE;
            for (const delta of [51, -51]) {
                const chainlink = bps(ssrRate, delta);
                await (await feed.set(chainlink, await time.latest())).wait();
                await expect(provider.rate(susdsAddr))
                    .to.be.revertedWithCustomError(provider, "OracleDisagreement")
                    .withArgs(chainlink, ssrRate);
            }
            for (const delta of [49, -49, 50, -50]) {
                const chainlink = bps(ssrRate, delta);
                await (await feed.set(chainlink, await time.latest())).wait();
                expect(await provider.rate(susdsAddr)).to.equal(chainlink);
            }
        });

        it("fails closed when the feed or the SSR oracle reverts", async function () {
            const { provider, feed, ssr, susdsAddr } = await loadFixture(deployProviderHarness);
            await (await feed.setReverting(true)).wait();
            await expect(provider.rate(susdsAddr)).to.be.revertedWith("feed down");
            await (await feed.setReverting(false)).wait();
            await (await ssr.setReverting(true)).wait();
            await expect(provider.rate(susdsAddr)).to.be.revertedWith("ssr down");
        });

        it("ignores answeredInRound and accepts roundId zero", async function () {
            const { provider, feed, susdsAddr } = await loadFixture(deployProviderHarness);
            await (await feed.setRound(10, 9)).wait();
            expect(await provider.rate(susdsAddr)).to.equal(RATE);
            await (await feed.setRound(0, 0)).wait();
            expect(await provider.rate(susdsAddr)).to.equal(RATE);
        });
    });
});
