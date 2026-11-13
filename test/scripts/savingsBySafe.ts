import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { SPARK_SSR_ORACLE_ADDRESS } from "../../contractAddresses";
import {
    AMOUNT,
    FORK_BLOCK,
    PSM3_ADDR,
    SKY_PARAM,
    SUSDS_ADDR,
    Stack,
    deployStack,
    psm3,
    resetFork,
    susds,
} from "../helpers/savingsForkStack";
import {
    MAX_DISAGREEMENT_BPS,
    MAX_EXPOSURE_BPS,
    MAX_FEED_AGE,
    MAX_RATE,
    SKY,
    openParams,
    timelockCall,
    tokenIdOf,
} from "../helpers/savingsHarness";
import { buildAction, printStatus, readConfig, reportReceipt } from "../../scripts/savingsBySafe";

// ─────────────────────────────────────────────────────────────────────────
//  The recovery script must encode `withdraw` and `redeem-direct` from the
//  reads they need and nothing else: a stale or reverting rate provider, an
//  unreachable PSM3 or a broken replacement build registered after the
//  position opened are the incidents the commands exist for. Diagnostics
//  never abort a command and never turn a confirmed transaction into a
//  failed run.
// ─────────────────────────────────────────────────────────────────────────

/** Runtime code that reverts on every call: PUSH1 0, PUSH1 0, REVERT. */
const REVERTING_CODE = "0x60006000fd";
const USDC_AMOUNT = "1000";

const envFor = (f: Stack, action: string, over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    ...process.env,
    ACTION: action,
    CALLER: "safe",
    DRY_RUN: "true",
    SAFE_ADDRESS: f.safeAddr,
    MANAGER_ADDRESS: f.managerAddr,
    USDC_AMOUNT,
    MIN_USDC_OUT: "",
    EXIT_BPS: "",
    SLIPPAGE_BPS: "",
    ...over,
});
const build = (f: Stack, action: string, over: Record<string, string> = {}) => buildAction(readConfig(envFor(f, action, over)));
const open = (f: Stack) =>
    f.manager.connect(f.operator).open(SKY, openParams(f.safeAddr, SKY_PARAM, { usdcAmount: AMOUNT }));
const breakVenue = () => network.provider.send("hardhat_setCode", [PSM3_ADDR, REVERTING_CODE]);
const decodeManager = (f: Stack, data: string) => f.manager.interface.parseTransaction({ data })!;
const PSM3_SWAP = new ethers.Interface([
    "function swapExactIn(address,address,uint256,uint256,address,uint256) returns (uint256)",
]);
const decodePsm3 = (data: string) => PSM3_SWAP.parseTransaction({ data })!;

/** A build registered as the current one whose provider then starts reverting on every rate read
 *  (the feed is healthy while the provider and the build are deployed: both constructors read it). */
async function registerBrokenReplacement(f: Stack) {
    const Feed = await ethers.getContractFactory("MockAggregatorV3");
    const brokenFeed = await Feed.deploy();
    await brokenFeed.waitForDeployment();
    await (await brokenFeed.set(await f.provider.rate(SUSDS_ADDR), await time.latest())).wait();
    const Provider = await ethers.getContractFactory("ChainlinkSsrRateProvider");
    const brokenProvider = await Provider.deploy(
        await brokenFeed.getAddress(),
        SPARK_SSR_ORACLE_ADDRESS,
        SUSDS_ADDR,
        MAX_FEED_AGE,
        MAX_DISAGREEMENT_BPS,
        MAX_RATE,
    );
    await brokenProvider.waitForDeployment();
    const replacement = await f.deployBuild(MAX_EXPOSURE_BPS, await brokenProvider.getAddress());
    const replacementAddr = await replacement.getAddress();
    await (await timelockCall(f.timelock, f.manager, "setYieldHandler", [SKY, replacementAddr])).wait();
    await (await brokenFeed.setReverting(true)).wait();
    return { replacementAddr, brokenProvider };
}

describe("scripts/savingsBySafe - recovery actions never depend on diagnostics (Base fork)", function () {
    this.timeout(300_000);

    before(async function () {
        await resetFork(FORK_BLOCK);
    });

    after(async function () {
        await resetFork(process.env.BASE_FORK_BLOCK_NUMBER ? Number(process.env.BASE_FORK_BLOCK_NUMBER) : undefined);
    });

    it("open and close dry runs encode the manager calls with the configured tolerance, amount and exit share", async function () {
        const f = await loadFixture(deployStack);
        const opened = decodeManager(f, (await build(f, "open", { SLIPPAGE_BPS: "30" })).data);
        expect(opened.name).to.equal("open");
        expect(opened.args[0]).to.equal(BigInt(SKY));
        expect(opened.args[1].usdcAmount).to.equal(ethers.parseUnits(USDC_AMOUNT, 6));
        expect(opened.args[1].slippageBps).to.equal(30n);
        expect(opened.args[1].poolParam).to.equal(SKY_PARAM);

        await (await open(f)).wait();
        const closed = decodeManager(f, (await build(f, "close", { EXIT_BPS: "5000", MIN_USDC_OUT: "400" })).data);
        expect(closed.name).to.equal("close");
        expect(closed.args[1].tokenId).to.equal(tokenIdOf(f.safeAddr));
        expect(closed.args[1].exitBps).to.equal(5000n);
        expect(closed.args[1].minUsdcOut).to.equal(ethers.parseUnits("400", 6));
        await expect(build(f, "open")).to.be.rejectedWith(/already has an open savings position/);
    });

    it("withdraw and redeem-direct encode while the rate provider is stale, and status reports the rate as unavailable", async function () {
        const f = await loadFixture(deployStack);
        await (await open(f)).wait();
        const shares: bigint = await susds.balanceOf(f.safeAddr);
        await time.increase(MAX_FEED_AGE + 1);
        await expect(f.provider.rate(SUSDS_ADDR)).to.be.revertedWithCustomError(f.provider, "StaleRate");

        const withdrawn = decodeManager(f, (await build(f, "withdraw")).data);
        expect(withdrawn.name).to.equal("withdraw");
        expect(withdrawn.args[1].tokenId).to.equal(tokenIdOf(f.safeAddr));

        const redeem = await build(f, "redeem-direct");
        expect(redeem.target.toLowerCase()).to.equal(SUSDS_ADDR.toLowerCase());
        expect(redeem.extra.map((tx) => tx.to.toLowerCase())).to.deep.equal([
            PSM3_ADDR.toLowerCase(),
            SUSDS_ADDR.toLowerCase(),
        ]);
        const swap = decodePsm3(redeem.extra[0].data);
        expect(swap.name).to.equal("swapExactIn");
        expect(swap.args[2]).to.equal(shares);
        const quoted: bigint = await psm3.previewSwapExactIn(SUSDS_ADDR, await f.manager.USDC(), shares);
        expect(swap.args[3]).to.equal((quoted * 9_980n) / 10_000n);
        expect(swap.args[4].toLowerCase()).to.equal(f.safeAddr.toLowerCase());

        await printStatus(readConfig(envFor(f, "status")));
        await expect(build(f, "open")).to.be.rejected;
    });

    it("withdraw encodes while PSM3 is unreachable; redeem-direct then takes the owner's MIN_USDC_OUT", async function () {
        const f = await loadFixture(deployStack);
        await (await open(f)).wait();
        const shares: bigint = await susds.balanceOf(f.safeAddr);
        await breakVenue();
        await expect(psm3.pocket()).to.be.reverted;

        expect(decodeManager(f, (await build(f, "withdraw")).data).name).to.equal("withdraw");
        await expect(build(f, "redeem-direct")).to.be.rejectedWith(/MIN_USDC_OUT/);
        const redeem = await build(f, "redeem-direct", { MIN_USDC_OUT: "990" });
        const swap = decodePsm3(redeem.extra[0].data);
        expect(swap.args[2]).to.equal(shares);
        expect(swap.args[3]).to.equal(ethers.parseUnits("990", 6));

        await printStatus(readConfig(envFor(f, "status")));
    });

    it("close and withdraw read the position through the pinned build when the registered replacement's provider is broken", async function () {
        const f = await loadFixture(deployStack);
        await (await open(f)).wait();
        const shares: bigint = await susds.balanceOf(f.safeAddr);
        const { replacementAddr, brokenProvider } = await registerBrokenReplacement(f);
        expect(await f.manager.yieldHandlers(SKY)).to.equal(replacementAddr);
        expect(await f.manager.positionHandlerOf(SKY, tokenIdOf(f.safeAddr))).to.equal(f.handlerAddr);
        await expect(brokenProvider.rate(SUSDS_ADDR)).to.be.reverted;

        const closed = decodeManager(f, (await build(f, "close")).data);
        expect(closed.name).to.equal("close");
        expect(closed.args[1].exitBps).to.equal(10_000n);
        expect(decodeManager(f, (await build(f, "withdraw")).data).name).to.equal("withdraw");
        expect(shares).to.be.greaterThan(0n);

        await printStatus(readConfig(envFor(f, "status")));
        // Registration turns opens off; with the pauser's activation a new open prices through the
        // broken replacement, and that is what must fail it (not the switch).
        await (await f.manager.connect(f.pauser).setProtocolEnabledForOpen(SKY, true)).wait();
        const refused = await build(f, "open", { SAFE_ADDRESS: f.safe2Addr }).then(
            () => null,
            (error: Error) => error,
        );
        expect(refused).to.be.instanceOf(Error);
        expect(refused!.message).to.not.match(/disabled for open|already has an open/);
        expect(decodeManager(f, (await build(f, "withdraw")).data).name).to.equal("withdraw");
    });

    it("a confirmed transaction's report survives failing diagnostics", async function () {
        const f = await loadFixture(deployStack);
        const receipt = await (await open(f)).wait();
        await breakVenue();
        await reportReceipt(readConfig(envFor(f, "open")), receipt!);
    });
});
