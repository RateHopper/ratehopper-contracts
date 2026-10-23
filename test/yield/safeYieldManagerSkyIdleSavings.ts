import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import {
    YieldProtocol,
    OSERO_REFERRAL_CODE,
    encodeSkyIdleSavingsPoolParam,
    encodeUniV3PoolParam,
} from "../../contractAddresses";
import { ZERO_LEG, leg } from "../helpers/utils";

// ─────────────────────────────────────────────────────────────────────────
//  Mock-driven suite for SkyIdleSavingsYieldHandler (protocol 3) behind the
//  untouched SafeYieldManager: registration through the timelock the way a
//  new id lands on the deployed manager, the PSM3 deposit / redeem
//  lifecycle, oracle guards, the exposure rail, the in-kind exit, the
//  same-id handler rollover through switchLp(3, 3), and the storage
//  namespace that keeps the handler's records apart from YieldLayout.
// ─────────────────────────────────────────────────────────────────────────

const ZERO = "0x0000000000000000000000000000000000000000";
const DEADLINE = ethers.MaxUint256;
const TOLERANCE = 20;
const PERF_FEE_BPS = 1000n; // 10%
const COLLECT_FEE_BPS = 250n;
const MAX_FEE_BPS = 2000;
const Q96 = 1n << 96n;
const TWAP_WINDOW = 1800;
const TWAP_CARDINALITY = 60;

const UNISWAP_V3 = YieldProtocol.UNISWAP_V3;
const SKY = YieldProtocol.SKY_IDLE_SAVINGS;

const ONE = 10n ** 18n;
const RATE = 1_100_000_000_000_000_000n; // 1.1e18
const RATE27 = RATE * 10n ** 9n;
const MAX_FEED_AGE = 129_600;
const MAX_DISAGREEMENT_BPS = 50;
const MAX_RATE = 2n * ONE;
const MAX_TOLERANCE_BPS = 50;
const MAX_EXPOSURE_BPS = 10_000;

const USDC = (n: number | bigint) => BigInt(n) * 10n ** 6n;
const DEPOSIT = USDC(1_000_000);
const WETH_OUT = 2_000_000n;

let FEE_TIER: string;
let SKY_PARAM: string;

const sharesFor = (usdc6: bigint, rate: bigint) => (usdc6 * 10n ** 30n) / rate;
const usdcFor = (shares: bigint, rate: bigint) => (shares * rate) / 10n ** 30n;
const minSharesFor = (usdc6: bigint, rate: bigint, tol: number) =>
    (sharesFor(usdc6, rate) * BigInt(10_000 - tol)) / 10_000n;
const tokenIdOf = (safeAddr: string) => BigInt(safeAddr);
const bps = (x: bigint, delta: number) => (x * BigInt(10_000 + delta)) / 10_000n;

function timelockCall(timelock: any, manager: any, functionName: string, args: any[]) {
    return timelock.execute(manager.target, manager.interface.encodeFunctionData(functionName, args));
}

function openParams(safeAddr: string, poolParam: string, overrides: Record<string, any> = {}) {
    return {
        onBehalfOf: safeAddr,
        usdcAmount: DEPOSIT,
        tickLower: 0,
        tickUpper: 0,
        mintAmount0Min: 0,
        mintAmount1Min: 0,
        swap0: ZERO_LEG,
        swap1: ZERO_LEG,
        slippageBps: TOLERANCE,
        deadline: DEADLINE,
        lpPoolParam: poolParam,
        stake: false,
        ...overrides,
    };
}

function closeParams(safeAddr: string, tokenId: bigint | number, overrides: Record<string, any> = {}) {
    return {
        onBehalfOf: safeAddr,
        tokenId,
        exitBps: 10_000,
        swap0: ZERO_LEG,
        swap1: ZERO_LEG,
        slippageBps: TOLERANCE,
        decreaseAmount0Min: 0,
        decreaseAmount1Min: 0,
        deadline: DEADLINE,
        minUsdcOut: 0,
        ...overrides,
    };
}

function withdrawParams(safeAddr: string, tokenId: bigint | number, overrides: Record<string, any> = {}) {
    return {
        onBehalfOf: safeAddr,
        tokenId,
        decreaseAmount0Min: 0,
        decreaseAmount1Min: 0,
        deadline: DEADLINE,
        ...overrides,
    };
}

function switchParams(safeAddr: string, tokenId: bigint | number, poolParam: string, overrides: Record<string, any> = {}) {
    return {
        onBehalfOf: safeAddr,
        tokenId,
        decreaseAmount0Min: 0,
        decreaseAmount1Min: 0,
        tickLower: 0,
        tickUpper: 0,
        mintAmount0Min: 0,
        mintAmount1Min: 0,
        lpPoolParam: poolParam,
        deadline: DEADLINE,
        ...overrides,
    };
}

async function slotValue(contractAddr: string, slot: string): Promise<bigint> {
    return BigInt(await ethers.provider.send("eth_getStorageAt", [contractAddr, slot, "latest"]));
}

async function deployIdleSavingsHarness() {
    const [deployer, operatorEOA, treasury, stranger, pauser] = await ethers.getSigners();

    const Usdc = await ethers.getContractFactory("MockFiatTokenUsdc");
    const usdc = await Usdc.deploy();
    await usdc.waitForDeployment();
    const usdcAddr = await usdc.getAddress();

    // WETH must sort below USDC for the V3 switch counterparty's pool; place
    // MockERC20 code at usdc - 1 like the V4 suite does.
    const ERC = await ethers.getContractFactory("MockERC20");
    const wethImpl = await ERC.deploy("Wrapped Ether", "WETH", 18);
    await wethImpl.waitForDeployment();
    const wethAddr = ethers.getAddress(ethers.toBeHex(BigInt(usdcAddr) - 1n, 20));
    await network.provider.send("hardhat_setCode", [wethAddr, await ethers.provider.getCode(wethImpl)]);
    const weth = await ethers.getContractAt("MockERC20", wethAddr);

    const susds = await ERC.deploy("Savings USDS", "sUSDS", 18);
    await susds.waitForDeployment();
    const susdsAddr = await susds.getAddress();

    FEE_TIER = encodeUniV3PoolParam(wethAddr, usdcAddr, 500);

    const UniPool = await ethers.getContractFactory("MockUniswapV3Pool");
    const uniPool = await UniPool.deploy(wethAddr, usdcAddr, Q96, 10n ** 18n);
    await uniPool.waitForDeployment();
    const uniPoolAddr = await uniPool.getAddress();
    const UniFactory = await ethers.getContractFactory("MockUniswapV3Factory");
    const uniFactory = await UniFactory.deploy();
    await uniFactory.waitForDeployment();
    await (await uniFactory.setPool(uniPoolAddr)).wait();
    const UniNPM = await ethers.getContractFactory("MockNonfungiblePositionManager");
    const uniNpm = await UniNPM.deploy();
    await uniNpm.waitForDeployment();
    const UniRouter = await ethers.getContractFactory("MockSwapRouter");
    const uniRouter = await UniRouter.deploy();
    await uniRouter.waitForDeployment();

    const Ssr = await ethers.getContractFactory("MockSSRRateProvider");
    const ssr = await Ssr.deploy();
    await ssr.waitForDeployment();
    await (await ssr.set(RATE27)).wait();
    const Feed = await ethers.getContractFactory("MockAggregatorV3");
    const feed = await Feed.deploy();
    await feed.waitForDeployment();
    await (await feed.set(RATE, await time.latest())).wait();

    const Provider = await ethers.getContractFactory("ChainlinkSsrRateProvider");
    const provider = await Provider.deploy(
        await feed.getAddress(),
        await ssr.getAddress(),
        susdsAddr,
        MAX_FEED_AGE,
        MAX_DISAGREEMENT_BPS,
        MAX_RATE,
    );
    await provider.waitForDeployment();
    const providerAddr = await provider.getAddress();

    const Psm = await ethers.getContractFactory("MockPSM3");
    const psm3 = await Psm.deploy(usdcAddr, susdsAddr, await ssr.getAddress());
    await psm3.waitForDeployment();
    const psm3Addr = await psm3.getAddress();
    await (await usdc.mint(psm3Addr, USDC(10_000_000))).wait();
    await (await susds.mint(psm3Addr, 10_000_000n * ONE)).wait();

    SKY_PARAM = encodeSkyIdleSavingsPoolParam(psm3Addr, susdsAddr);

    const Handler = await ethers.getContractFactory("SkyIdleSavingsYieldHandler");
    const handler = await Handler.deploy(
        usdcAddr,
        providerAddr,
        MAX_TOLERANCE_BPS,
        MAX_EXPOSURE_BPS,
        psm3Addr,
        susdsAddr,
        OSERO_REFERRAL_CODE,
    );
    await handler.waitForDeployment();
    const handlerAddr = await handler.getAddress();

    const Safe = await ethers.getContractFactory("MockSafeHarness");
    const safe = await Safe.deploy();
    await safe.waitForDeployment();
    const safeAddr = await safe.getAddress();
    const safe2 = await Safe.deploy();
    await safe2.waitForDeployment();
    const safe2Addr = await safe2.getAddress();

    const Reg = await ethers.getContractFactory("MockRegistry");
    const reg = await Reg.deploy();
    await reg.waitForDeployment();
    await (await reg.setOperator(operatorEOA.address)).wait();
    for (const t of [wethAddr, usdcAddr, susdsAddr]) await (await reg.setWhitelisted(t, true)).wait();

    const UniHandler = await ethers.getContractFactory("UniV3YieldHandler");
    const uniHandler = await UniHandler.deploy(
        await uniNpm.getAddress(),
        usdcAddr,
        await uniRouter.getAddress(),
        await uniFactory.getAddress(),
    );
    await uniHandler.waitForDeployment();

    const Timelock = await ethers.getContractFactory("MockTimelockController");
    const timelock = await Timelock.deploy(1);
    await timelock.waitForDeployment();

    const Manager = await ethers.getContractFactory("SafeYieldManager");
    const manager = await Manager.deploy(
        await reg.getAddress(),
        usdcAddr,
        wethAddr,
        [UNISWAP_V3],
        [await uniHandler.getAddress()],
        [[FEE_TIER]],
        [0],
        [0],
        [{ token: wethAddr, config: { pool: uniPoolAddr, window: TWAP_WINDOW, minCardinality: TWAP_CARDINALITY } }],
        treasury.address,
        Number(PERF_FEE_BPS),
        Number(COLLECT_FEE_BPS),
        MAX_FEE_BPS,
        deployer.address,
        await timelock.getAddress(),
        pauser.address,
    );
    await manager.waitForDeployment();
    const managerAddr = await manager.getAddress();
    // Handler events are emitted from the manager's address (delegatecall).
    const managerEvents = await ethers.getContractAt("SkyIdleSavingsYieldHandler", managerAddr);

    await (await usdc.mint(safeAddr, USDC(2_000_000))).wait();
    await (await usdc.mint(safe2Addr, USDC(2_000_000))).wait();
    for (const target of [uniRouter, uniNpm]) {
        await (await weth.mint(await target.getAddress(), 10n ** 24n)).wait();
        await (await usdc.mint(await target.getAddress(), 10n ** 18n)).wait();
    }
    await (await uniRouter.setOutput(WETH_OUT)).wait();

    return {
        deployer,
        operatorEOA,
        treasury,
        stranger,
        pauser,
        timelock,
        usdc,
        usdcAddr,
        weth,
        wethAddr,
        susds,
        susdsAddr,
        uniPool,
        uniNpm,
        uniRouter,
        uniHandler,
        ssr,
        feed,
        provider,
        providerAddr,
        Provider,
        psm3,
        psm3Addr,
        handler,
        handlerAddr,
        Handler,
        safe,
        safeAddr,
        safe2,
        safe2Addr,
        reg,
        manager,
        managerAddr,
        managerEvents,
    };
}

type Harness = Awaited<ReturnType<typeof deployIdleSavingsHarness>>;

async function registerIdleSavings(f: Harness, handlerAddr = f.handlerAddr, protocol = SKY, param = SKY_PARAM) {
    await (await timelockCall(f.timelock, f.manager, "setYieldHandler", [protocol, handlerAddr])).wait();
    await (await f.manager.connect(f.pauser).setProtocolEnabledForClose(protocol, true)).wait();
    await (await f.manager.connect(f.pauser).setProtocolEnabledForOpen(protocol, true)).wait();
    await (await f.manager.connect(f.deployer).setPoolParamAllowed(protocol, param, true)).wait();
}

async function deployRegistered() {
    const f = await deployIdleSavingsHarness();
    await registerIdleSavings(f);
    return f;
}

function open(f: Harness, safeAddr = f.safeAddr, overrides: Record<string, any> = {}) {
    return f.manager.connect(f.operatorEOA).openLp(SKY, openParams(safeAddr, SKY_PARAM, overrides));
}

function close(f: Harness, safeAddr = f.safeAddr, overrides: Record<string, any> = {}) {
    return f.manager.connect(f.operatorEOA).closeLp(SKY, closeParams(safeAddr, tokenIdOf(safeAddr), overrides));
}

function withdraw(f: Harness, safeAddr = f.safeAddr, overrides: Record<string, any> = {}) {
    return f.manager.connect(f.operatorEOA).withdrawLp(SKY, withdrawParams(safeAddr, tokenIdOf(safeAddr), overrides));
}

async function sharesOf(f: Harness, safeAddr = f.safeAddr) {
    return slotValue(f.managerAddr, await f.handler.idleSavingsSharesSlot(tokenIdOf(safeAddr)));
}

async function totalShares(f: Harness) {
    return slotValue(f.managerAddr, await f.handler.idleSavingsTotalSharesSlot());
}

async function expectZeroResidue(f: Harness) {
    expect(await f.usdc.balanceOf(f.managerAddr)).to.equal(0);
    expect(await f.susds.balanceOf(f.managerAddr)).to.equal(0);
}

describe("SafeYieldManager + SkyIdleSavingsYieldHandler", function () {
    describe("registration", function () {
        it("registers under id 3 through the timelock and rejects a PROTOCOL mismatch", async function () {
            const f = await loadFixture(deployIdleSavingsHarness);
            const { manager, timelock, handlerAddr, handler } = f;
            expect(await handler.PROTOCOL()).to.equal(SKY);
            await expect(timelockCall(timelock, manager, "setYieldHandler", [SKY + 1, handlerAddr]))
                .to.be.revertedWithCustomError(manager, "HandlerProtocolMismatch")
                .withArgs(SKY + 1, SKY);
            await expect(timelockCall(timelock, manager, "setYieldHandler", [SKY, handlerAddr]))
                .to.emit(manager, "YieldHandlerUpdated")
                .withArgs(SKY, ZERO, handlerAddr);
            expect(await manager.yieldHandlers(SKY)).to.equal(handlerAddr);
        });

        it("starts a new id with both switches off", async function () {
            const f = await loadFixture(deployIdleSavingsHarness);
            const { manager, timelock, handlerAddr, deployer, pauser } = f;
            await expect(
                manager.connect(deployer).setPoolParamAllowed(SKY, SKY_PARAM, true),
            ).to.be.revertedWithCustomError(manager, "HandlerNotSet");
            await (await timelockCall(timelock, manager, "setYieldHandler", [SKY, handlerAddr])).wait();
            expect(await manager.protocolEnabledForOpen(SKY)).to.equal(false);
            expect(await manager.protocolEnabledForClose(SKY)).to.equal(false);
            await (await manager.connect(deployer).setPoolParamAllowed(SKY, SKY_PARAM, true)).wait();
            await expect(open(f)).to.be.revertedWithCustomError(manager, "ProtocolDisabled");

            await (await manager.connect(pauser).setProtocolEnabledForOpen(SKY, true)).wait();
            await (await open(f)).wait();
            await expect(close(f)).to.be.revertedWithCustomError(manager, "ProtocolDisabled");
            await expect(withdraw(f)).to.be.revertedWithCustomError(manager, "ProtocolDisabled");
        });

        it("keeps the switches as they are when a replacement build is registered", async function () {
            const f = await loadFixture(deployRegistered);
            const { manager, timelock, Handler, usdcAddr, providerAddr, psm3Addr, susdsAddr, pauser } = f;
            const build2 = await Handler.deploy(
                usdcAddr,
                providerAddr,
                MAX_TOLERANCE_BPS,
                MAX_EXPOSURE_BPS,
                psm3Addr,
                susdsAddr,
                OSERO_REFERRAL_CODE,
            );
            await build2.waitForDeployment();
            await (await timelockCall(timelock, manager, "setYieldHandler", [SKY, await build2.getAddress()])).wait();
            expect(await manager.protocolEnabledForOpen(SKY)).to.equal(true);
            expect(await manager.protocolEnabledForClose(SKY)).to.equal(true);

            await (await manager.connect(pauser).setProtocolEnabledForOpen(SKY, false)).wait();
            await (await timelockCall(timelock, manager, "setYieldHandler", [SKY, f.handlerAddr])).wait();
            expect(await manager.protocolEnabledForOpen(SKY)).to.equal(false);
            expect(await manager.protocolEnabledForClose(SKY)).to.equal(true);
        });
    });

    describe("allow-list", function () {
        it("allow-lists the pool param without any price reference", async function () {
            const f = await loadFixture(deployRegistered);
            const { manager, handler, usdcAddr, susdsAddr } = f;
            expect(await manager.isPoolParamAllowed(SKY, SKY_PARAM)).to.equal(true);
            expect((await manager.twapConfigOf(susdsAddr)).pool).to.equal(ZERO);
            expect(await handler.poolTokens(SKY_PARAM)).to.deep.equal([usdcAddr, usdcAddr]);
            expect(await handler.poolTokens("0x")).to.deep.equal([usdcAddr, usdcAddr]);
            expect(await handler.poolParamHasHooks(SKY_PARAM)).to.equal(false);
        });

        it("rejects a pool param with a wrong PSM3 or sUSDS even when allow-listed", async function () {
            const f = await loadFixture(deployRegistered);
            const { manager, handler, deployer, stranger, psm3Addr, susdsAddr, usdcAddr } = f;
            const wrongVenue = encodeSkyIdleSavingsPoolParam(stranger.address, susdsAddr);
            const wrongShare = encodeSkyIdleSavingsPoolParam(psm3Addr, usdcAddr);
            await (await manager.connect(deployer).setPoolParamAllowed(SKY, wrongVenue, true)).wait();
            await (await manager.connect(deployer).setPoolParamAllowed(SKY, wrongShare, true)).wait();
            await expect(open(f, f.safeAddr, { lpPoolParam: wrongVenue })).to.be.revertedWithCustomError(
                handler,
                "WrongPoolParam",
            );
            await expect(open(f, f.safeAddr, { lpPoolParam: wrongShare })).to.be.revertedWithCustomError(
                handler,
                "WrongPoolParam",
            );
        });

        it("rejects the right pool param once it is de-listed", async function () {
            const f = await loadFixture(deployRegistered);
            const { manager, handler, deployer } = f;
            await (await manager.connect(deployer).setPoolParamAllowed(SKY, SKY_PARAM, false)).wait();
            await expect(open(f)).to.be.revertedWithCustomError(handler, "PoolParamNotAllowed");
        });
    });

    describe("deposit", function () {
        it("swaps USDC into sUSDS through PSM3 and records basis, shares and events", async function () {
            const f = await loadFixture(deployRegistered);
            const { manager, managerEvents, psm3, usdc, susds, safeAddr, handlerAddr, usdcAddr, susdsAddr, psm3Addr } = f;
            const tokenId = tokenIdOf(safeAddr);
            const shares = sharesFor(DEPOSIT, RATE);
            const usdcBefore = await usdc.balanceOf(safeAddr);

            const tx = open(f);
            await expect(tx)
                .to.emit(manager, "PositionOpened")
                .withArgs(safeAddr, SKY, tokenId, DEPOSIT, DEPOSIT, shares, DEPOSIT);
            await expect(tx).to.emit(managerEvents, "IdleSavingsDeposited").withArgs(safeAddr, tokenId, DEPOSIT, shares, RATE);
            await expect(tx)
                .to.emit(psm3, "Swap")
                .withArgs(usdcAddr, susdsAddr, safeAddr, safeAddr, DEPOSIT, shares, OSERO_REFERRAL_CODE);

            expect(await usdc.balanceOf(safeAddr)).to.equal(usdcBefore - DEPOSIT);
            expect(await susds.balanceOf(safeAddr)).to.equal(shares);
            expect(await usdc.allowance(safeAddr, psm3Addr)).to.equal(0);
            expect(await manager.residualBasisUsd6Of(SKY, tokenId)).to.equal(DEPOSIT);
            expect(await manager.positionHandlerOf(SKY, tokenId)).to.equal(handlerAddr);
            expect(await sharesOf(f)).to.equal(shares);
            expect(await totalShares(f)).to.equal(shares);
            await expectZeroResidue(f);
        });

        it("reverts SwapFailed when the Safe receives fewer shares than the floor", async function () {
            const f = await loadFixture(deployRegistered);
            const { handler, safe, psm3Addr } = f;
            // Mode 3: the Safe reports success without executing, so no shares arrive.
            await (await safe.setFail(psm3Addr, 3)).wait();
            await (await safe.setFailData("0x")).wait();
            await expect(open(f)).to.be.revertedWithCustomError(handler, "SwapFailed");
        });
    });

    describe("no top-up", function () {
        it("rejects a second deposit while the position is open and changes nothing", async function () {
            const f = await loadFixture(deployRegistered);
            const { handler, usdc, susds, safeAddr } = f;
            await (await open(f)).wait();
            const usdcBefore = await usdc.balanceOf(safeAddr);
            const susdsBefore = await susds.balanceOf(safeAddr);
            const total = await totalShares(f);
            await expect(open(f, safeAddr, { usdcAmount: USDC(10) })).to.be.revertedWithCustomError(
                handler,
                "PositionAlreadyOpen",
            );
            expect(await usdc.balanceOf(safeAddr)).to.equal(usdcBefore);
            expect(await susds.balanceOf(safeAddr)).to.equal(susdsBefore);
            expect(await totalShares(f)).to.equal(total);
        });

        it("accepts a fresh deposit after a full close with a fresh basis and shares record", async function () {
            const f = await loadFixture(deployRegistered);
            const { manager, safeAddr } = f;
            await (await open(f)).wait();
            await (await close(f)).wait();
            expect(await manager.positionHandlerOf(SKY, tokenIdOf(safeAddr))).to.equal(ZERO);
            expect(await sharesOf(f)).to.equal(0);
            expect(await totalShares(f)).to.equal(0);

            const second = USDC(250_000);
            await (await open(f, safeAddr, { usdcAmount: second })).wait();
            expect(await manager.residualBasisUsd6Of(SKY, tokenIdOf(safeAddr))).to.equal(second);
            expect(await sharesOf(f)).to.equal(sharesFor(second, RATE));
            expect(await totalShares(f)).to.equal(sharesFor(second, RATE));
            await expectZeroResidue(f);
        });

        it("reverts StaleSharesRecord when a shares record survives without a pin", async function () {
            const f = await loadFixture(deployRegistered);
            const { handler, managerAddr, safeAddr } = f;
            const slot = await handler.idleSavingsSharesSlot(tokenIdOf(safeAddr));
            await network.provider.send("hardhat_setStorageAt", [managerAddr, slot, ethers.zeroPadValue("0x01", 32)]);
            await expect(open(f)).to.be.revertedWithCustomError(handler, "StaleSharesRecord");
        });
    });
});
