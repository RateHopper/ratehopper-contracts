import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture, time, impersonateAccount, setBalance } from "@nomicfoundation/hardhat-network-helpers";
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
const abi = ethers.AbiCoder.defaultAbiCoder();
const YIELD_SLOT = 0x53ba738b9a2829dfda910cf4e864fcd3f84e03854b49244f3d159a473ee6a400n;
// YieldLayout field offsets (see YieldStorage.sol)
const YIELD_FIELD = { residualBasis: 1n, allowedPoolKey: 2n, positionHandler: 5n, carry: 8n };
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

function mapSlot(key: bigint, base: bigint): string {
    return ethers.keccak256(abi.encode(["uint256", "uint256"], [key, base]));
}

function yieldSlot(field: bigint, protocol: number, tokenId: bigint): string {
    return mapSlot(tokenId, BigInt(mapSlot(BigInt(protocol), YIELD_SLOT + field)));
}

async function setSlot(contractAddr: string, slot: string, value: bigint) {
    await network.provider.send("hardhat_setStorageAt", [contractAddr, slot, ethers.toBeHex(value, 32)]);
}

async function safeSigner(safeAddr: string) {
    await impersonateAccount(safeAddr);
    await setBalance(safeAddr, 10n ** 18n);
    return ethers.getSigner(safeAddr);
}

function collectParams(safeAddr: string, tokenId: bigint | number) {
    return {
        onBehalfOf: safeAddr,
        tokenId,
        swapFeesToUsdc: false,
        swap0: ZERO_LEG,
        swap1: ZERO_LEG,
        swapRewardToUsdc: false,
        rewardSwap: ZERO_LEG,
        slippageBps: TOLERANCE,
        deadline: DEADLINE,
    };
}

function inKindParams(safeAddr: string, token0: string, token1: string, amount0: bigint, amount1: bigint) {
    return {
        onBehalfOf: safeAddr,
        token0,
        token1,
        amount0,
        amount1,
        tickLower: 0,
        tickUpper: 0,
        mintAmount0Min: 0,
        mintAmount1Min: 0,
        lpPoolParam: SKY_PARAM,
        deadline: DEADLINE,
    };
}

function v3OpenParams(safeAddr: string) {
    return {
        onBehalfOf: safeAddr,
        usdcAmount: 1_000_000n,
        tickLower: -100,
        tickUpper: 100,
        mintAmount0Min: 0,
        mintAmount1Min: 0,
        swap0: leg(WETH_OUT, FEE_TIER),
        swap1: ZERO_LEG,
        slippageBps: 100,
        deadline: DEADLINE,
        lpPoolParam: FEE_TIER,
        stake: false,
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

async function deployBuild(f: Harness): Promise<string> {
    const build = await f.Handler.deploy(
        f.usdcAddr,
        f.providerAddr,
        MAX_TOLERANCE_BPS,
        MAX_EXPOSURE_BPS,
        f.psm3Addr,
        f.susdsAddr,
        OSERO_REFERRAL_CODE,
    );
    await build.waitForDeployment();
    return build.getAddress();
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

    describe("tolerance", function () {
        it("bounds slippageBps to [1, MAX_TOLERANCE_BPS] on open and close", async function () {
            const f = await loadFixture(deployRegistered);
            const { handler } = f;
            await expect(open(f, f.safeAddr, { slippageBps: 0 })).to.be.revertedWithCustomError(handler, "SlippageTooLow");
            await expect(open(f, f.safeAddr, { slippageBps: MAX_TOLERANCE_BPS + 1 })).to.be.revertedWithCustomError(
                handler,
                "SlippageAboveMax",
            );
            await (await open(f, f.safeAddr, { slippageBps: MAX_TOLERANCE_BPS })).wait();
            await expect(close(f, f.safeAddr, { slippageBps: 0 })).to.be.revertedWithCustomError(handler, "SlippageTooLow");
            await expect(close(f, f.safeAddr, { slippageBps: MAX_TOLERANCE_BPS + 1 })).to.be.revertedWithCustomError(
                handler,
                "SlippageAboveMax",
            );
            await (await close(f, f.safeAddr, { slippageBps: MAX_TOLERANCE_BPS })).wait();
        });

        it("needs a tolerance at least equal to a Chainlink lag below the PSM3 rate on deposit", async function () {
            const f = await loadFixture(deployRegistered);
            await (await f.feed.set(bps(RATE, -30), await time.latest())).wait();
            await expect(open(f, f.safeAddr, { slippageBps: 20 })).to.be.revertedWith("PSM3/amountOut-too-low");
            await (await open(f, f.safeAddr, { slippageBps: 40 })).wait();
            await expectZeroResidue(f);
        });

        it("needs a tolerance at least equal to a Chainlink lead above the PSM3 rate on redeem", async function () {
            const f = await loadFixture(deployRegistered);
            await (await open(f)).wait();
            await (await f.feed.set(bps(RATE, 30), await time.latest())).wait();
            await expect(close(f, f.safeAddr, { slippageBps: 20 })).to.be.revertedWith("PSM3/amountOut-too-low");
            await (await close(f, f.safeAddr, { slippageBps: 40 })).wait();
            await expectZeroResidue(f);
        });
    });

    describe("feed guards", function () {
        const states: Array<{ name: string; error: string | null; reason?: string; apply: (f: Harness) => Promise<void> }> = [
            { name: "zero answer", error: "InvalidRate", apply: async (f) => void (await (await f.feed.set(0, await time.latest())).wait()) },
            { name: "negative answer", error: "InvalidRate", apply: async (f) => void (await (await f.feed.set(-1, await time.latest())).wait()) },
            {
                name: "answer older than 36h",
                error: "StaleRate",
                apply: async (f) => void (await (await f.feed.set(RATE, (await time.latest()) - MAX_FEED_AGE - 100)).wait()),
            },
            { name: "rate below 1e18", error: "RateOutOfBounds", apply: async (f) => void (await (await f.feed.set(ONE - 1n, await time.latest())).wait()) },
            { name: "rate above MAX_RATE", error: "RateOutOfBounds", apply: async (f) => void (await (await f.feed.set(MAX_RATE + 1n, await time.latest())).wait()) },
            { name: "reverting feed", error: null, reason: "feed down", apply: async (f) => void (await (await f.feed.setReverting(true)).wait()) },
            { name: "Chainlink 51 bps above the SSR oracle", error: "OracleDisagreement", apply: async (f) => void (await (await f.feed.set(bps(RATE, 51), await time.latest())).wait()) },
            { name: "Chainlink 51 bps below the SSR oracle", error: "OracleDisagreement", apply: async (f) => void (await (await f.feed.set(bps(RATE, -51), await time.latest())).wait()) },
            { name: "reverting SSR oracle", error: null, reason: "ssr down", apply: async (f) => void (await (await f.ssr.setReverting(true)).wait()) },
        ];

        for (const state of states) {
            it(`fails closed on open and close but withdraws in kind with a ${state.name}`, async function () {
                const f = await loadFixture(deployRegistered);
                const { provider, susds, safeAddr, safe2Addr } = f;
                await (await open(f)).wait();
                await state.apply(f);
                const expectRevert = (tx: Promise<any>) =>
                    state.error
                        ? expect(tx).to.be.revertedWithCustomError(provider, state.error)
                        : expect(tx).to.be.revertedWith(state.reason!);
                await expectRevert(close(f));
                await expectRevert(open(f, safe2Addr));
                const shares = await susds.balanceOf(safeAddr);
                await (await withdraw(f)).wait();
                expect(await susds.balanceOf(safeAddr)).to.equal(shares);
                expect(await sharesOf(f)).to.equal(0);
                await expectZeroResidue(f);
            });
        }

        it("passes a 49 bps disagreement in either direction on open and close", async function () {
            for (const delta of [49, -49]) {
                const f = await loadFixture(deployRegistered);
                await (await f.feed.set(bps(RATE, delta), await time.latest())).wait();
                await (await open(f, f.safeAddr, { slippageBps: MAX_TOLERANCE_BPS })).wait();
                await (await close(f, f.safeAddr, { slippageBps: MAX_TOLERANCE_BPS })).wait();
                await expectZeroResidue(f);
            }
        });
    });

    describe("exposure rail", function () {
        it("rejects a deposit that would push the tracked book above the pocket", async function () {
            const f = await loadFixture(deployRegistered);
            const { handler, usdc, psm3Addr, safe2Addr } = f;
            await (await open(f)).wait();
            const available = await usdc.balanceOf(psm3Addr);
            const tracked = usdcFor(await totalShares(f), RATE);
            const amount = available - tracked + 1n;
            await expect(open(f, safe2Addr, { usdcAmount: amount }))
                .to.be.revertedWithCustomError(handler, "ExposureCapExceeded")
                .withArgs(tracked + amount, available);
        });

        it("accepts a deposit exactly at the cap and rejects one unit more", async function () {
            const f = await loadFixture(deployRegistered);
            const { handler, usdc, psm3Addr, safe2Addr } = f;
            await (await open(f)).wait();
            const tracked = usdcFor(await totalShares(f), RATE);
            const amount = USDC(500_000);
            const available = await usdc.balanceOf(psm3Addr);
            await (await usdc.burn(psm3Addr, available - (tracked + amount))).wait();
            await expect(open(f, safe2Addr, { usdcAmount: amount + 1n }))
                .to.be.revertedWithCustomError(handler, "ExposureCapExceeded")
                .withArgs(tracked + amount + 1n, tracked + amount);
            await (await open(f, safe2Addr, { usdcAmount: amount })).wait();
            await expectZeroResidue(f);
        });

        it("returns headroom after a partial close once the pocket is refilled", async function () {
            const f = await loadFixture(deployRegistered);
            const { handler, usdc, psm3Addr, safe2Addr } = f;
            await (await open(f)).wait();
            const tracked = usdcFor(await totalShares(f), RATE);
            await (await usdc.burn(psm3Addr, (await usdc.balanceOf(psm3Addr)) - tracked)).wait();
            await expect(open(f, safe2Addr, { usdcAmount: USDC(10) })).to.be.revertedWithCustomError(
                handler,
                "ExposureCapExceeded",
            );
            const pocketBefore = await usdc.balanceOf(psm3Addr);
            await (await close(f, f.safeAddr, { exitBps: 5_000 })).wait();
            await (await usdc.mint(psm3Addr, pocketBefore - (await usdc.balanceOf(psm3Addr)))).wait();
            await (await open(f, safe2Addr, { usdcAmount: USDC(10) })).wait();
            await expectZeroResidue(f);
        });
    });

    describe("close", function () {
        it("fully closes after the rate rose and charges the performance fee on the profit", async function () {
            const f = await loadFixture(deployRegistered);
            const { manager, managerEvents, usdc, treasury, safeAddr, ssr, feed } = f;
            const tokenId = tokenIdOf(safeAddr);
            await (await open(f)).wait();
            const shares = sharesFor(DEPOSIT, RATE);
            const newRate = 1_120_000_000_000_000_000n;
            await (await ssr.set(newRate * 10n ** 9n)).wait();
            await (await feed.set(newRate, await time.latest())).wait();
            const value = usdcFor(shares, newRate);
            const fee = ((value - DEPOSIT) * PERF_FEE_BPS) / 10_000n;
            expect(value).to.be.greaterThan(DEPOSIT);
            const usdcBefore = await usdc.balanceOf(safeAddr);

            const tx = close(f);
            await expect(tx)
                .to.emit(manager, "PositionClosed")
                .withArgs(safeAddr, SKY, tokenId, DEPOSIT, value, fee, 10_000, 0);
            await expect(tx)
                .to.emit(managerEvents, "IdleSavingsRedeemed")
                .withArgs(safeAddr, tokenId, shares, value, newRate, 10_000);

            expect(await usdc.balanceOf(treasury.address)).to.equal(fee);
            expect(await usdc.balanceOf(safeAddr)).to.equal(usdcBefore + value - fee);
            expect(await manager.residualBasisUsd6Of(SKY, tokenId)).to.equal(0);
            expect(await manager.positionHandlerOf(SKY, tokenId)).to.equal(ZERO);
            expect(await sharesOf(f)).to.equal(0);
            expect(await totalShares(f)).to.equal(0);
            await expectZeroResidue(f);
        });

        it("partially closes and prorates shares, basis and carry", async function () {
            const f = await loadFixture(deployRegistered);
            const { manager, managerAddr, managerEvents, safeAddr } = f;
            const tokenId = tokenIdOf(safeAddr);
            await (await open(f)).wait();
            const shares = sharesFor(DEPOSIT, RATE);
            const carry = 1_000n;
            await setSlot(managerAddr, yieldSlot(YIELD_FIELD.carry, SKY, tokenId), carry);

            const toRedeem = (shares * 2_500n) / 10_000n;
            const value = usdcFor(toRedeem, RATE);
            const basisForExit = (DEPOSIT * 2_500n) / 10_000n;
            const carryForExit = (carry * 2_500n) / 10_000n;
            const realized = value + carryForExit;
            const fee = realized > basisForExit ? ((realized - basisForExit) * PERF_FEE_BPS) / 10_000n : 0n;

            const tx = close(f, safeAddr, { exitBps: 2_500 });
            await expect(tx)
                .to.emit(manager, "PositionClosed")
                .withArgs(safeAddr, SKY, tokenId, basisForExit, value, fee, 2_500, carryForExit);
            await expect(tx)
                .to.emit(managerEvents, "IdleSavingsRedeemed")
                .withArgs(safeAddr, tokenId, toRedeem, value, RATE, 2_500);
            expect(await manager.residualBasisUsd6Of(SKY, tokenId)).to.equal(DEPOSIT - basisForExit);
            expect(await manager.carryProfitUsd6Of(SKY, tokenId)).to.equal(carry - carryForExit);
            expect(await sharesOf(f)).to.equal(shares - toRedeem);
            expect(await totalShares(f)).to.equal(shares - toRedeem);

            await (await close(f)).wait();
            expect(await sharesOf(f)).to.equal(0);
            expect(await totalShares(f)).to.equal(0);
            expect(await manager.positionHandlerOf(SKY, tokenId)).to.equal(ZERO);
            await expectZeroResidue(f);
        });

        it("reverts InvalidExitBps when a basis decrement would stand without shares leaving", async function () {
            const f = await loadFixture(deployRegistered);
            const { handler, managerAddr, safeAddr } = f;
            await (await open(f)).wait();
            await setSlot(managerAddr, await handler.idleSavingsSharesSlot(tokenIdOf(safeAddr)), 1n);
            await expect(close(f, safeAddr, { exitBps: 1 })).to.be.revertedWithCustomError(handler, "InvalidExitBps");
        });

        it("redeems what is left after the Safe moved sUSDS out around the module", async function () {
            const f = await loadFixture(deployRegistered);
            const { manager, managerEvents, susds, stranger, safeAddr } = f;
            const tokenId = tokenIdOf(safeAddr);
            await (await open(f)).wait();
            const shares = sharesFor(DEPOSIT, RATE);
            const half = shares / 2n;
            await (await susds.connect(await safeSigner(safeAddr)).transfer(stranger.address, half)).wait();

            const value = usdcFor(shares - half, RATE);
            const tx = close(f);
            await expect(tx)
                .to.emit(managerEvents, "IdleSavingsSharesShortfall")
                .withArgs(safeAddr, tokenId, shares, shares - half);
            await expect(tx)
                .to.emit(manager, "PositionClosed")
                .withArgs(safeAddr, SKY, tokenId, DEPOSIT, value, 0, 10_000, 0);
            expect(await susds.balanceOf(safeAddr)).to.equal(0);
            expect(await susds.balanceOf(stranger.address)).to.equal(half);
            expect(await sharesOf(f)).to.equal(0);
            expect(await totalShares(f)).to.equal(0);
            await expectZeroResidue(f);
        });

        it("bubbles the pocket's USDC revert and leaves storage untouched", async function () {
            const f = await loadFixture(deployRegistered);
            const { manager, handler, usdc, psm3Addr, safe, safeAddr, safe2Addr, handlerAddr } = f;
            await (await open(f)).wait();
            const shares = await sharesOf(f);
            await (await usdc.burn(psm3Addr, await usdc.balanceOf(psm3Addr))).wait();
            await expect(close(f)).to.be.revertedWith("ERC20: transfer amount exceeds balance");
            expect(await sharesOf(f)).to.equal(shares);
            expect(await totalShares(f)).to.equal(shares);
            expect(await manager.positionHandlerOf(SKY, tokenIdOf(safeAddr))).to.equal(handlerAddr);
            expect(await manager.residualBasisUsd6Of(SKY, tokenIdOf(safeAddr))).to.equal(DEPOSIT);

            await (await safe.setFail(psm3Addr, 1)).wait();
            await expect(close(f)).to.be.revertedWithCustomError(handler, "ModuleCallFailed").withArgs(84);
            await (await usdc.mint(psm3Addr, USDC(10_000_000))).wait();
            await (await f.safe2.setFail(psm3Addr, 1)).wait();
            await expect(open(f, safe2Addr)).to.be.revertedWithCustomError(handler, "ModuleCallFailed").withArgs(81);
        });
    });

    describe("withdrawLp", function () {
        it("releases the record with no module call and leaves the sUSDS on the Safe", async function () {
            const f = await loadFixture(deployRegistered);
            const { manager, managerAddr, managerEvents, psm3, usdc, susds, safe, safeAddr, psm3Addr, usdcAddr, susdsAddr } = f;
            const tokenId = tokenIdOf(safeAddr);
            await (await open(f)).wait();
            const shares = sharesFor(DEPOSIT, RATE);
            const carry = 777n;
            await setSlot(managerAddr, yieldSlot(YIELD_FIELD.carry, SKY, tokenId), carry);
            const usdcBefore = await usdc.balanceOf(safeAddr);
            for (const target of [psm3Addr, usdcAddr, susdsAddr]) await (await safe.setFail(target, 1)).wait();

            const tx = withdraw(f);
            await expect(tx).to.emit(managerEvents, "IdleSavingsReleased").withArgs(safeAddr, tokenId, shares);
            await expect(tx)
                .to.emit(manager, "PositionWithdrawn")
                .withArgs(safeAddr, SKY, tokenId, DEPOSIT, carry, 0, shares);
            await expect(tx).to.not.emit(psm3, "Swap");
            expect(await susds.balanceOf(safeAddr)).to.equal(shares);
            expect(await usdc.balanceOf(safeAddr)).to.equal(usdcBefore);
            expect(await sharesOf(f)).to.equal(0);
            expect(await totalShares(f)).to.equal(0);
            expect(await manager.positionHandlerOf(SKY, tokenId)).to.equal(ZERO);
            expect(await manager.residualBasisUsd6Of(SKY, tokenId)).to.equal(0);
            expect(await manager.carryProfitUsd6Of(SKY, tokenId)).to.equal(0);
            await expectZeroResidue(f);
        });
    });

    describe("reverts", function () {
        it("rejects staking, collect and direct entry", async function () {
            const f = await loadFixture(deployRegistered);
            const { manager, handler, operatorEOA, safeAddr, usdcAddr, susdsAddr } = f;
            const tokenId = tokenIdOf(safeAddr);
            await expect(open(f, safeAddr, { stake: true })).to.be.revertedWithCustomError(handler, "StakingNotSupported");
            await (await open(f)).wait();
            await expect(
                manager.connect(operatorEOA).collectLp(SKY, collectParams(safeAddr, tokenId)),
            ).to.be.revertedWithCustomError(handler, "CollectNotSupported");

            await expect(handler.openLp(openParams(safeAddr, SKY_PARAM))).to.be.revertedWithCustomError(
                handler,
                "OnlyDelegatecall",
            );
            await expect(handler.closeLp(closeParams(safeAddr, tokenId), 0)).to.be.revertedWithCustomError(
                handler,
                "OnlyDelegatecall",
            );
            await expect(handler.withdrawLp(withdrawParams(safeAddr, tokenId))).to.be.revertedWithCustomError(
                handler,
                "OnlyDelegatecall",
            );
            await expect(
                handler.openLpInKind(inKindParams(safeAddr, usdcAddr, susdsAddr, 0n, 1n)),
            ).to.be.revertedWithCustomError(handler, "OnlyDelegatecall");
            await expect(handler.collectLp(collectParams(safeAddr, tokenId))).to.be.revertedWithCustomError(
                handler,
                "OnlyDelegatecall",
            );
        });

        it("never redeems or releases one Safe's shares against another Safe's record", async function () {
            const f = await loadFixture(deployRegistered);
            const { manager, handler, operatorEOA, safeAddr, safe2Addr } = f;
            await (await open(f)).wait();
            await (await open(f, safe2Addr)).wait();
            await expect(
                manager.connect(operatorEOA).closeLp(SKY, closeParams(safeAddr, tokenIdOf(safe2Addr))),
            ).to.be.revertedWithCustomError(handler, "WrongPosition");
            await expect(
                manager.connect(operatorEOA).withdrawLp(SKY, withdrawParams(safeAddr, tokenIdOf(safe2Addr))),
            ).to.be.revertedWithCustomError(handler, "WrongPosition");
        });

        it("rejects an approval the token does not confirm", async function () {
            const f = await loadFixture(deployRegistered);
            const { handler, safe, usdcAddr, susdsAddr } = f;
            await (await safe.setFailData(ethers.ZeroHash)).wait();
            await (await safe.setFail(usdcAddr, 3)).wait();
            await expect(open(f)).to.be.revertedWithCustomError(handler, "TokenApprovalFailed").withArgs(usdcAddr);
            await (await safe.setFail(usdcAddr, 0)).wait();
            await (await open(f)).wait();
            await (await safe.setFail(susdsAddr, 3)).wait();
            await expect(close(f)).to.be.revertedWithCustomError(handler, "TokenApprovalFailed").withArgs(susdsAddr);
        });
    });

    describe("pause", function () {
        it("blocks opens while close and withdraw keep working", async function () {
            const f = await loadFixture(deployRegistered);
            const { manager, pauser, safe2Addr } = f;
            await (await open(f)).wait();
            await (await open(f, safe2Addr)).wait();
            await (await manager.connect(pauser).pause()).wait();
            await expect(open(f)).to.be.revertedWithCustomError(manager, "EnforcedPause");
            await (await close(f)).wait();
            await (await withdraw(f, safe2Addr)).wait();
            await expectZeroResidue(f);
        });
    });

    describe("switchLp", function () {
        it("rejects an in-kind switch between an LP position and protocol 3 in either direction", async function () {
            const f = await loadFixture(deployRegistered);
            const { manager, handler, uniHandler, operatorEOA, safeAddr } = f;
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, v3OpenParams(safeAddr))).wait();
            await expect(
                manager.connect(operatorEOA).switchLp(UNISWAP_V3, SKY, switchParams(safeAddr, 1, SKY_PARAM)),
            ).to.be.revertedWithCustomError(handler, "InKindNotSupported");

            await (await open(f)).wait();
            await expect(
                manager
                    .connect(operatorEOA)
                    .switchLp(SKY, UNISWAP_V3, switchParams(safeAddr, tokenIdOf(safeAddr), FEE_TIER)),
            ).to.be.revertedWithCustomError(uniHandler, "WrongTokenPair");
        });

        it("rolls a position to a new build under the same id without moving tokens", async function () {
            const f = await loadFixture(deployRegistered);
            const { manager, managerAddr, managerEvents, timelock, operatorEOA, psm3, usdc, susds, treasury, safeAddr } = f;
            const tokenId = tokenIdOf(safeAddr);
            await (await open(f)).wait();
            const shares = sharesFor(DEPOSIT, RATE);
            const carry = 500n;
            await setSlot(managerAddr, yieldSlot(YIELD_FIELD.carry, SKY, tokenId), carry);
            const build2 = await deployBuild(f);
            await (await timelockCall(timelock, manager, "setYieldHandler", [SKY, build2])).wait();
            const usdcBefore = await usdc.balanceOf(safeAddr);

            const tx = manager.connect(operatorEOA).switchLp(SKY, SKY, switchParams(safeAddr, tokenId, SKY_PARAM));
            await expect(tx).to.emit(managerEvents, "IdleSavingsReleased").withArgs(safeAddr, tokenId, shares);
            await expect(tx).to.emit(managerEvents, "IdleSavingsAdopted").withArgs(safeAddr, tokenId, shares);
            await expect(tx)
                .to.emit(manager, "PositionSwitched")
                .withArgs(safeAddr, SKY, SKY, tokenId, tokenId, DEPOSIT, 0, shares, 0, shares);
            await expect(tx)
                .to.emit(manager, "SwitchResidueSettled")
                .withArgs(safeAddr, SKY, tokenId, 0, 0, 0, DEPOSIT, carry);
            await expect(tx).to.not.emit(psm3, "Swap");

            expect(await susds.balanceOf(safeAddr)).to.equal(shares);
            expect(await usdc.balanceOf(safeAddr)).to.equal(usdcBefore);
            expect(await manager.positionHandlerOf(SKY, tokenId)).to.equal(build2);
            expect(await manager.residualBasisUsd6Of(SKY, tokenId)).to.equal(DEPOSIT);
            expect(await manager.carryProfitUsd6Of(SKY, tokenId)).to.equal(carry);
            expect(await sharesOf(f)).to.equal(shares);
            expect(await totalShares(f)).to.equal(shares);

            const value = usdcFor(shares, RATE);
            const realized = value + carry;
            const fee = realized > DEPOSIT ? ((realized - DEPOSIT) * PERF_FEE_BPS) / 10_000n : 0n;
            await expect(close(f))
                .to.emit(manager, "PositionClosed")
                .withArgs(safeAddr, SKY, tokenId, DEPOSIT, value, fee, 10_000, carry);
            expect(await usdc.balanceOf(treasury.address)).to.equal(fee);
            expect(await sharesOf(f)).to.equal(0);
            expect(await totalShares(f)).to.equal(0);
            await expectZeroResidue(f);
        });

        it("rolls over while the feed, the SSR oracle and PSM3 are all down", async function () {
            const f = await loadFixture(deployRegistered);
            const { manager, timelock, operatorEOA, feed, ssr, psm3, safeAddr } = f;
            await (await open(f)).wait();
            const build2 = await deployBuild(f);
            await (await timelockCall(timelock, manager, "setYieldHandler", [SKY, build2])).wait();
            await (await feed.setReverting(true)).wait();
            await (await ssr.setReverting(true)).wait();
            await (await psm3.setReverting(true)).wait();
            await (
                await manager
                    .connect(operatorEOA)
                    .switchLp(SKY, SKY, switchParams(safeAddr, tokenIdOf(safeAddr), SKY_PARAM))
            ).wait();
            expect(await manager.positionHandlerOf(SKY, tokenIdOf(safeAddr))).to.equal(build2);
            await (await withdraw(f)).wait();
            await expectZeroResidue(f);
        });

        it("refuses a rollover when the Safe holds fewer shares than were released", async function () {
            const f = await loadFixture(deployRegistered);
            const { manager, handler, timelock, operatorEOA, susds, stranger, safeAddr } = f;
            await (await open(f)).wait();
            await (await susds.connect(await safeSigner(safeAddr)).transfer(stranger.address, 1n)).wait();
            await (await timelockCall(timelock, manager, "setYieldHandler", [SKY, await deployBuild(f)])).wait();
            await expect(
                manager.connect(operatorEOA).switchLp(SKY, SKY, switchParams(safeAddr, tokenIdOf(safeAddr), SKY_PARAM)),
            ).to.be.revertedWithCustomError(handler, "SharesNotOnSafe");
        });

        it("refuses a rollover when paused, when either switch is off, or when the param is de-listed", async function () {
            const f = await loadFixture(deployRegistered);
            const { manager, handler, timelock, operatorEOA, pauser, deployer, safeAddr } = f;
            await (await open(f)).wait();
            await (await timelockCall(timelock, manager, "setYieldHandler", [SKY, await deployBuild(f)])).wait();
            const roll = () =>
                manager.connect(operatorEOA).switchLp(SKY, SKY, switchParams(safeAddr, tokenIdOf(safeAddr), SKY_PARAM));

            await (await manager.connect(pauser).pause()).wait();
            await expect(roll()).to.be.revertedWithCustomError(manager, "EnforcedPause");
            await (await manager.connect(pauser).unpause()).wait();

            await (await manager.connect(pauser).setProtocolEnabledForClose(SKY, false)).wait();
            await expect(roll()).to.be.revertedWithCustomError(manager, "ProtocolDisabled");
            await (await manager.connect(pauser).setProtocolEnabledForClose(SKY, true)).wait();

            await (await manager.connect(pauser).setProtocolEnabledForOpen(SKY, false)).wait();
            await expect(roll()).to.be.revertedWithCustomError(manager, "ProtocolDisabled");
            await (await manager.connect(pauser).setProtocolEnabledForOpen(SKY, true)).wait();

            await (await manager.connect(deployer).setPoolParamAllowed(SKY, SKY_PARAM, false)).wait();
            await expect(roll()).to.be.revertedWithCustomError(handler, "PoolParamNotAllowed");
            await (await manager.connect(deployer).setPoolParamAllowed(SKY, SKY_PARAM, true)).wait();
            await (await roll()).wait();
            await expectZeroResidue(f);
        });

        it("reverts TwapNotConfigured when a new build adopts fewer shares than were released", async function () {
            const f = await loadFixture(deployRegistered);
            const { manager, timelock, operatorEOA, usdcAddr, susdsAddr, safeAddr } = f;
            await (await open(f)).wait();
            const Under = await ethers.getContractFactory("MockUnderAdoptingYieldHandler");
            const under = await Under.deploy(SKY, usdcAddr);
            await under.waitForDeployment();
            await (await timelockCall(timelock, manager, "setYieldHandler", [SKY, await under.getAddress()])).wait();
            await expect(
                manager.connect(operatorEOA).switchLp(SKY, SKY, switchParams(safeAddr, tokenIdOf(safeAddr), SKY_PARAM)),
            )
                .to.be.revertedWithCustomError(manager, "TwapNotConfigured")
                .withArgs(susdsAddr);
        });
    });

    describe("storage namespace", function () {
        it("derives the ERC-7201 slot and leaves YieldLayout untouched except the pin and basis", async function () {
            const f = await loadFixture(deployRegistered);
            const { handler, managerAddr, safeAddr } = f;
            const tokenId = tokenIdOf(safeAddr);
            const namespaceId = BigInt(ethers.keccak256(ethers.toUtf8Bytes("ratehopper.storage.idleSavings"))) - 1n;
            const base = BigInt(ethers.keccak256(abi.encode(["uint256"], [namespaceId]))) & ~0xffn;
            expect(base).to.not.equal(YIELD_SLOT);
            expect(await handler.idleSavingsSharesSlot(tokenId)).to.equal(
                mapSlot(tokenId, BigInt(mapSlot(BigInt(SKY), base))),
            );
            expect(await handler.idleSavingsTotalSharesSlot()).to.equal(mapSlot(BigInt(SKY), base + 1n));

            const watched: Record<string, string> = { scalar: ethers.toBeHex(YIELD_SLOT, 32) };
            for (const protocol of [0, 1, 2, 3]) {
                for (const id of [1n, tokenId]) {
                    watched[`basis:${protocol}:${id}`] = yieldSlot(YIELD_FIELD.residualBasis, protocol, id);
                    watched[`pin:${protocol}:${id}`] = yieldSlot(YIELD_FIELD.positionHandler, protocol, id);
                    watched[`carry:${protocol}:${id}`] = yieldSlot(YIELD_FIELD.carry, protocol, id);
                }
            }
            const allowedBase = YIELD_SLOT + YIELD_FIELD.allowedPoolKey;
            watched["allowed:3"] = mapSlot(BigInt(ethers.keccak256(SKY_PARAM)), BigInt(mapSlot(BigInt(SKY), allowedBase)));
            watched["allowed:0"] = mapSlot(BigInt(ethers.keccak256(FEE_TIER)), BigInt(mapSlot(0n, allowedBase)));
            const before: Record<string, bigint> = {};
            for (const [k, slot] of Object.entries(watched)) before[k] = await slotValue(managerAddr, slot);
            expect(before["allowed:3"]).to.equal(1n);

            await (await open(f)).wait();
            for (const [k, slot] of Object.entries(watched)) {
                const after = await slotValue(managerAddr, slot);
                if (k === `basis:3:${tokenId}` || k === `pin:3:${tokenId}`) expect(after, k).to.not.equal(before[k]);
                else expect(after, k).to.equal(before[k]);
            }
            expect(await sharesOf(f)).to.equal(sharesFor(DEPOSIT, RATE));
        });
    });

    describe("exit liveness", function () {
        it("keeps withdrawLp alive through every failure except the close switch", async function () {
            const f = await loadFixture(deployRegistered);
            const { manager, pauser, feed, ssr, psm3, usdc, susds, psm3Addr, safeAddr, safe2Addr } = f;
            await (await open(f)).wait();
            await (await open(f, safe2Addr)).wait();
            await (await feed.setReverting(true)).wait();
            await (await ssr.setReverting(true)).wait();
            await (await psm3.setReverting(true)).wait();
            await (await usdc.burn(psm3Addr, await usdc.balanceOf(psm3Addr))).wait();
            await (await manager.connect(pauser).pause()).wait();
            await (await withdraw(f)).wait();
            expect(await susds.balanceOf(safeAddr)).to.equal(sharesFor(DEPOSIT, RATE));

            await (await manager.connect(pauser).setProtocolEnabledForClose(SKY, false)).wait();
            await expect(withdraw(f, safe2Addr)).to.be.revertedWithCustomError(manager, "ProtocolDisabled");
            await (await manager.connect(pauser).setProtocolEnabledForClose(SKY, true)).wait();
            await (await withdraw(f, safe2Addr)).wait();
            await expectZeroResidue(f);
        });
    });
});
