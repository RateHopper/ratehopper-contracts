import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import {
    CHAINLINK_SUSDS_USDS_FEED,
    OSERO_REFERRAL_CODE,
    SPARK_PSM3_ADDRESS,
    SPARK_SSR_ORACLE_ADDRESS,
    USDC_ADDRESS,
    WETH_ADDRESS,
    encodeSkyIdleSavingsPoolParam,
    sUSDS_ADDRESS,
} from "../../contractAddresses";
import { dealToken } from "../helpers/utils";
import { deployRealSafe, enableModuleOnSafe } from "../helpers/deployRealSafe";
import {
    COLLECT_FEE_BPS,
    MAX_DISAGREEMENT_BPS,
    MAX_EXPOSURE_BPS,
    MAX_FEE_BPS,
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
} from "../helpers/idleSavingsHarness";

// ─────────────────────────────────────────────────────────────────────────
//  Base-fork integration for SkyIdleSavingsYieldHandler against the REAL
//  Spark PSM3, sUSDS, Chainlink sUSDS/USDS feed and SSR oracle. The mock
//  suites prove the handler's rules against mocks that mirror the venue;
//  this suite proves the venue addresses, the PSM3 swapExactIn calldata
//  (referral code included), the feed's decimals and heartbeat, the
//  Chainlink/SSR agreement and the compatibility of the oracle floor with
//  what PSM3 actually pays all hold on chain.
// ─────────────────────────────────────────────────────────────────────────

const FORK_BLOCK = Number(process.env.BASE_FORK_BLOCK_NUMBER ?? 53_100_000);
const USDC_ADDR = ethers.getAddress(USDC_ADDRESS);
const SUSDS_ADDR = ethers.getAddress(sUSDS_ADDRESS);
const PSM3_ADDR = ethers.getAddress(SPARK_PSM3_ADDRESS);
const SKY_PARAM = encodeSkyIdleSavingsPoolParam(SPARK_PSM3_ADDRESS, sUSDS_ADDRESS);
const AMOUNT = USDC(1_000);
const FUNDING = USDC(10_000);
const HOUR = 3_600;

const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
];
const PSM3_ABI = [
    "function pocket() view returns (address)",
    "function previewSwapExactIn(address,address,uint256) view returns (uint256)",
    "event Swap(address indexed assetIn, address indexed assetOut, address sender, address indexed receiver, uint256 amountIn, uint256 amountOut, uint256 referralCode)",
];
const FEED_ABI = [
    "function decimals() view returns (uint8)",
    "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
];
const SSR_ABI = ["function getConversionRate() view returns (uint256)"];

const usdc = new ethers.Contract(USDC_ADDR, ERC20_ABI, ethers.provider);
const susds = new ethers.Contract(SUSDS_ADDR, ERC20_ABI, ethers.provider);
const psm3 = new ethers.Contract(PSM3_ADDR, PSM3_ABI, ethers.provider);
const feed = new ethers.Contract(CHAINLINK_SUSDS_USDS_FEED, FEED_ABI, ethers.provider);
const ssr = new ethers.Contract(SPARK_SSR_ORACLE_ADDRESS, SSR_ABI, ethers.provider);

async function deployStack() {
    const [admin, operator, treasury, pauser, owner2] = await ethers.getSigners();

    const Provider = await ethers.getContractFactory("ChainlinkSsrRateProvider");
    const provider = await Provider.deploy(
        CHAINLINK_SUSDS_USDS_FEED,
        SPARK_SSR_ORACLE_ADDRESS,
        SUSDS_ADDR,
        MAX_FEED_AGE,
        MAX_DISAGREEMENT_BPS,
        MAX_RATE,
    );
    await provider.waitForDeployment();
    const providerAddr = await provider.getAddress();

    const Handler = await ethers.getContractFactory("SkyIdleSavingsYieldHandler");
    const deployBuild = async (exposureBps = MAX_EXPOSURE_BPS) => {
        const build = await Handler.deploy(
            USDC_ADDR,
            providerAddr,
            MAX_TOLERANCE_BPS,
            exposureBps,
            PSM3_ADDR,
            SUSDS_ADDR,
            OSERO_REFERRAL_CODE,
        );
        await build.waitForDeployment();
        return build;
    };
    const handler = await deployBuild();
    const handlerAddr = await handler.getAddress();

    const Registry = await ethers.getContractFactory("MockRegistry");
    const registry = await Registry.deploy();
    await registry.waitForDeployment();
    await (await registry.setOperator(operator.address)).wait();
    await (await registry.setWhitelisted(USDC_ADDR, true)).wait();

    const Timelock = await ethers.getContractFactory("MockTimelockController");
    const timelock = await Timelock.deploy(1);
    await timelock.waitForDeployment();

    const Manager = await ethers.getContractFactory("SafeYieldManager");
    const manager = await Manager.deploy(
        await registry.getAddress(),
        USDC_ADDR,
        WETH_ADDRESS,
        [SKY],
        [handlerAddr],
        [[SKY_PARAM]],
        [0],
        [0],
        [],
        treasury.address,
        Number(PERF_FEE_BPS),
        Number(COLLECT_FEE_BPS),
        MAX_FEE_BPS,
        admin.address,
        await timelock.getAddress(),
        pauser.address,
    );
    await manager.waitForDeployment();
    const managerAddr = await manager.getAddress();
    const managerEvents = await ethers.getContractAt("SkyIdleSavingsYieldHandler", managerAddr);

    const fundSafe = async (owner: HardhatEthersSigner) => {
        const safeAddr = await deployRealSafe(owner);
        await enableModuleOnSafe(safeAddr, owner, managerAddr);
        await dealToken(USDC_ADDR, safeAddr, FUNDING);
        return safeAddr;
    };
    const safeAddr = await fundSafe(admin);
    const safe2Addr = await fundSafe(owner2);

    return {
        admin,
        operator,
        treasury,
        pauser,
        provider,
        handler,
        handlerAddr,
        deployBuild,
        registry,
        timelock,
        manager,
        managerAddr,
        managerEvents,
        safeAddr,
        safe2Addr,
    };
}

type Stack = Awaited<ReturnType<typeof deployStack>>;

const open = (f: Stack, safeAddr: string, overrides: Record<string, any> = {}) =>
    f.manager.connect(f.operator).openLp(SKY, openParams(safeAddr, SKY_PARAM, { usdcAmount: AMOUNT, ...overrides }));
const close = (f: Stack, safeAddr: string, overrides: Record<string, any> = {}) =>
    f.manager.connect(f.operator).closeLp(SKY, closeParams(safeAddr, tokenIdOf(safeAddr), overrides));
const withdraw = (f: Stack, safeAddr: string) =>
    f.manager.connect(f.operator).withdrawLp(SKY, withdrawParams(safeAddr, tokenIdOf(safeAddr)));
const roll = (f: Stack, safeAddr: string) =>
    f.manager.connect(f.operator).switchLp(SKY, SKY, switchParams(safeAddr, tokenIdOf(safeAddr), SKY_PARAM));
const sharesOf = async (f: Stack, safeAddr: string) =>
    slotValue(f.managerAddr, await f.handler.idleSavingsSharesSlot(tokenIdOf(safeAddr)));
const totalShares = async (f: Stack) => slotValue(f.managerAddr, await f.handler.idleSavingsTotalSharesSlot());
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

describe("SafeYieldManager + Sky idle savings - integration (Base fork)", function () {
    this.timeout(300_000);

    before(async function () {
        await network.provider.request({
            method: "hardhat_reset",
            params: [
                {
                    forking: {
                        jsonRpcUrl: process.env.BASE_RPC_URL || "https://mainnet.base.org",
                        blockNumber: FORK_BLOCK,
                    },
                },
            ],
        });
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
        const deposited = logArgs(managerEvents, openReceipt, "IdleSavingsDeposited");
        expect([deposited.usdcIn, deposited.sharesOut, deposited.rate]).to.deep.equal([AMOUNT, shares, rate]);
        const opened = logArgs(manager, openReceipt, "PositionOpened");
        expect([
            opened.tokenId,
            opened.usdcInput,
            opened.amount0ToLp,
            opened.amount1ToLp,
            opened.currentValueUsd6,
        ]).to.deep.equal([tokenId, AMOUNT, AMOUNT, shares, AMOUNT]);
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

    it("keeps the handler's guards and PSM3's own floor in front of the live venue", async function () {
        const f = await loadFixture(deployStack);
        const { handler, safeAddr } = f;
        await expect(open(f, safeAddr, { slippageBps: MAX_TOLERANCE_BPS + 1 })).to.be.revertedWithCustomError(
            handler,
            "SlippageAboveMax",
        );
        await expect(open(f, safeAddr, { slippageBps: 0 })).to.be.revertedWithCustomError(handler, "SlippageTooLow");
        await expect(
            open(f, safeAddr, { lpPoolParam: encodeSkyIdleSavingsPoolParam(SUSDS_ADDR, PSM3_ADDR) }),
        ).to.be.revertedWithCustomError(handler, "WrongPoolParam");
        await expect(open(f, safeAddr, { stake: true })).to.be.revertedWithCustomError(handler, "StakingNotSupported");

        await (await open(f, safeAddr)).wait();
        await expect(open(f, safeAddr)).to.be.revertedWithCustomError(handler, "PositionAlreadyOpen");
        await expect(close(f, safeAddr, { minUsdcOut: AMOUNT * 2n })).to.be.revertedWith("PSM3/amountOut-too-low");
        await expect(close(f, safeAddr, { slippageBps: MAX_TOLERANCE_BPS + 1 })).to.be.revertedWithCustomError(
            handler,
            "SlippageAboveMax",
        );
    });

    it("fails closed on open and close once the live round is older than 36h, but still releases in kind", async function () {
        const f = await loadFixture(deployStack);
        const { manager, managerEvents, provider, safeAddr, safe2Addr } = f;
        const tokenId = tokenIdOf(safeAddr);
        await (await open(f, safeAddr)).wait();
        const shares = await susds.balanceOf(safeAddr);

        await time.increase(MAX_FEED_AGE);
        const [, , , updatedAt] = await feed.latestRoundData();
        await expect(provider.rate(SUSDS_ADDR))
            .to.be.revertedWithCustomError(provider, "StaleRate")
            .withArgs(updatedAt);
        await expect(open(f, safe2Addr)).to.be.revertedWithCustomError(provider, "StaleRate");
        await expect(close(f, safeAddr)).to.be.revertedWithCustomError(provider, "StaleRate");

        const receipt = await (await withdraw(f, safeAddr)).wait();
        expect(logArgs(managerEvents, receipt, "IdleSavingsReleased").shares).to.equal(shares);
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
        const cap = pocket / 10_000n;
        await expect(open(f, safeAddr, { usdcAmount: cap + 1n }))
            .to.be.revertedWithCustomError(thin, "ExposureCapExceeded")
            .withArgs(cap + 1n, pocket);
        await (await open(f, safeAddr, { usdcAmount: cap })).wait();
        expect(await manager.residualBasisUsd6Of(SKY, tokenIdOf(safeAddr))).to.equal(cap);
    });

    it("rolls a live position onto a new build through switchLp(3, 3) without touching PSM3, then the new build redeems", async function () {
        const f = await loadFixture(deployStack);
        const { manager, managerEvents, timelock, safeAddr } = f;
        const tokenId = tokenIdOf(safeAddr);
        await (await open(f, safeAddr)).wait();
        const shares = await susds.balanceOf(safeAddr);
        const build2 = await f.deployBuild();
        const build2Addr = await build2.getAddress();
        await (await timelockCall(timelock, manager, "setYieldHandler", [SKY, build2Addr])).wait();
        const usdcBefore = await usdc.balanceOf(safeAddr);
        const venueSharesBefore = await susds.balanceOf(PSM3_ADDR);

        const receipt = await (await roll(f, safeAddr)).wait();
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
        expect(logArgs(managerEvents, receipt, "IdleSavingsReleased").shares).to.equal(shares);
        expect(logArgs(managerEvents, receipt, "IdleSavingsAdopted").shares).to.equal(shares);
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
