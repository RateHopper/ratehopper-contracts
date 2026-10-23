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
//  Mock-driven suite for the idle savings handlers behind the untouched
//  SafeYieldManager. The shared cases run twice: against
//  SkyIdleSavingsYieldHandler (protocol 3, PSM3 + Chainlink/SSR provider)
//  and against MockIdleSavingsSource (protocol 250, a trivial venue + a
//  mock provider), which proves BaseIdleSavingsHandler is generic. Covers
//  registration through the timelock the way a new id lands on the deployed
//  manager, the deposit / redeem lifecycle, the exposure rail, the in-kind
//  exit, the same-id handler rollover through switchLp, and the storage
//  namespace that keeps the handler's records apart from YieldLayout. Sky
//  oracle guards and mock short-pay cases follow in their own blocks.
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
const MOCK = 250;

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

const sharesFor = (usdc6: bigint, rate: bigint) => (usdc6 * 10n ** 30n) / rate;
const usdcFor = (shares: bigint, rate: bigint) => (shares * rate) / 10n ** 30n;
const tokenIdOf = (safeAddr: string) => BigInt(safeAddr);
const bps = (x: bigint, delta: number) => (x * BigInt(10_000 + delta)) / 10_000n;
const encodeParam = (venue: string, share: string) => abi.encode(["address", "address"], [venue, share]);

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

function inKindParams(safeAddr: string, poolParam: string, token0: string, token1: string, amount0: bigint, amount1: bigint) {
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
        lpPoolParam: poolParam,
        deadline: DEADLINE,
    };
}

function v3OpenParams(f: Harness, safeAddr: string) {
    return {
        onBehalfOf: safeAddr,
        usdcAmount: 1_000_000n,
        tickLower: -100,
        tickUpper: 100,
        mintAmount0Min: 0,
        mintAmount1Min: 0,
        swap0: leg(WETH_OUT, f.feeTier),
        swap1: ZERO_LEG,
        slippageBps: 100,
        deadline: DEADLINE,
        lpPoolParam: f.feeTier,
        stake: false,
    };
}

function mapSlot(key: bigint, base: bigint): string {
    return ethers.keccak256(abi.encode(["uint256", "uint256"], [key, base]));
}

function yieldSlot(field: bigint, protocol: number, tokenId: bigint): string {
    return mapSlot(tokenId, BigInt(mapSlot(BigInt(protocol), YIELD_SLOT + field)));
}

async function slotValue(contractAddr: string, slot: string): Promise<bigint> {
    return BigInt(await ethers.provider.send("eth_getStorageAt", [contractAddr, slot, "latest"]));
}

async function setSlot(contractAddr: string, slot: string, value: bigint) {
    await network.provider.send("hardhat_setStorageAt", [contractAddr, slot, ethers.toBeHex(value, 32)]);
}

async function safeSigner(safeAddr: string) {
    await impersonateAccount(safeAddr);
    await setBalance(safeAddr, 10n ** 18n);
    return ethers.getSigner(safeAddr);
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
    const mockShare = await ERC.deploy("Mock Share", "MSH", 18);
    await mockShare.waitForDeployment();
    const mockShareAddr = await mockShare.getAddress();

    const feeTier = encodeUniV3PoolParam(wethAddr, usdcAddr, 500);

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

    // Sky stack
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
    const skyParam = encodeSkyIdleSavingsPoolParam(psm3Addr, susdsAddr);
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

    // Mock source stack
    const MockProvider = await ethers.getContractFactory("MockIdleSavingsRateProvider");
    const mockProvider = await MockProvider.deploy(mockShareAddr);
    await mockProvider.waitForDeployment();
    await (await mockProvider.set(RATE)).wait();
    const Venue = await ethers.getContractFactory("MockIdleSavingsVenue");
    const mockVenue = await Venue.deploy(usdcAddr, mockShareAddr);
    await mockVenue.waitForDeployment();
    const mockVenueAddr = await mockVenue.getAddress();
    await (await mockVenue.setRate(RATE)).wait();
    await (await usdc.mint(mockVenueAddr, USDC(10_000_000))).wait();
    const mockParam = encodeParam(mockVenueAddr, mockShareAddr);
    const MockSource = await ethers.getContractFactory("MockIdleSavingsSource");
    const mockSource = await MockSource.deploy(
        usdcAddr,
        await mockProvider.getAddress(),
        MAX_TOLERANCE_BPS,
        MAX_EXPOSURE_BPS,
        mockVenueAddr,
        mockShareAddr,
    );
    await mockSource.waitForDeployment();
    const mockSourceAddr = await mockSource.getAddress();

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
    for (const t of [wethAddr, usdcAddr, susdsAddr, mockShareAddr]) await (await reg.setWhitelisted(t, true)).wait();

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
        [[feeTier]],
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
    // Handler events are emitted from the manager's address (delegatecall);
    // both sources share the base's event ABI.
    const managerEvents = await ethers.getContractAt("SkyIdleSavingsYieldHandler", managerAddr);

    await (await usdc.mint(safeAddr, USDC(2_000_000))).wait();
    await (await usdc.mint(safe2Addr, USDC(2_000_000))).wait();
    for (const target of [uniRouter, uniNpm]) {
        await (await weth.mint(await target.getAddress(), 10n ** 24n)).wait();
        await (await usdc.mint(await target.getAddress(), 10n ** 18n)).wait();
    }
    await (await uniRouter.setOutput(WETH_OUT)).wait();

    return {
        feeTier,
        skyParam,
        mockParam,
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
        mockShare,
        mockShareAddr,
        uniPool,
        uniNpm,
        uniRouter,
        uniHandler,
        ssr,
        feed,
        provider,
        providerAddr,
        psm3,
        psm3Addr,
        handler,
        handlerAddr,
        Handler,
        mockProvider,
        mockVenue,
        mockVenueAddr,
        mockSource,
        mockSourceAddr,
        MockSource,
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

type SourceSpec = {
    name: string;
    protocol: number;
    param: (f: Harness) => string;
    handler: (f: Harness) => any;
    handlerAddr: (f: Harness) => string;
    shareToken: (f: Harness) => any;
    shareTokenAddr: (f: Harness) => string;
    venueAddr: (f: Harness) => string;
    setRate: (f: Harness, rate18: bigint) => Promise<void>;
    breakPricing: (f: Harness) => Promise<void>;
    breakVenue: (f: Harness) => Promise<void>;
    deployBuild: (f: Harness) => Promise<string>;
    steps: { deposit: number; redeem: number };
    tooLow: { deposit: string; redeem: string };
};

const SKY_SRC: SourceSpec = {
    name: "SkyIdleSavingsYieldHandler (protocol 3)",
    protocol: SKY,
    param: (f) => f.skyParam,
    handler: (f) => f.handler,
    handlerAddr: (f) => f.handlerAddr,
    shareToken: (f) => f.susds,
    shareTokenAddr: (f) => f.susdsAddr,
    venueAddr: (f) => f.psm3Addr,
    setRate: async (f, rate18) => {
        await (await f.ssr.set(rate18 * 10n ** 9n)).wait();
        await (await f.feed.set(rate18, await time.latest())).wait();
    },
    breakPricing: async (f) => {
        await (await f.feed.setReverting(true)).wait();
        await (await f.ssr.setReverting(true)).wait();
    },
    breakVenue: async (f) => void (await (await f.psm3.setReverting(true)).wait()),
    deployBuild: async (f) => {
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
    },
    steps: { deposit: 81, redeem: 84 },
    tooLow: { deposit: "PSM3/amountOut-too-low", redeem: "PSM3/amountOut-too-low" },
};

const MOCK_SRC: SourceSpec = {
    name: "MockIdleSavingsSource (protocol 250)",
    protocol: MOCK,
    param: (f) => f.mockParam,
    handler: (f) => f.mockSource,
    handlerAddr: (f) => f.mockSourceAddr,
    shareToken: (f) => f.mockShare,
    shareTokenAddr: (f) => f.mockShareAddr,
    venueAddr: (f) => f.mockVenueAddr,
    setRate: async (f, rate18) => {
        await (await f.mockProvider.set(rate18)).wait();
        await (await f.mockVenue.setRate(rate18)).wait();
    },
    breakPricing: async (f) => void (await (await f.mockProvider.setReverting(true)).wait()),
    breakVenue: async (f) => void (await (await f.mockVenue.setReverting(true)).wait()),
    deployBuild: async (f) => {
        const build = await f.MockSource.deploy(
            f.usdcAddr,
            await f.mockProvider.getAddress(),
            MAX_TOLERANCE_BPS,
            MAX_EXPOSURE_BPS,
            f.mockVenueAddr,
            f.mockShareAddr,
        );
        await build.waitForDeployment();
        return build.getAddress();
    },
    steps: { deposit: 91, redeem: 94 },
    tooLow: { deposit: "venue/too-few-shares", redeem: "venue/too-little-usdc" },
};

const SOURCES = [SKY_SRC, MOCK_SRC];

async function registerSource(f: Harness, src: SourceSpec, handlerAddr = src.handlerAddr(f)) {
    await (await timelockCall(f.timelock, f.manager, "setYieldHandler", [src.protocol, handlerAddr])).wait();
    await (await f.manager.connect(f.pauser).setProtocolEnabledForClose(src.protocol, true)).wait();
    await (await f.manager.connect(f.pauser).setProtocolEnabledForOpen(src.protocol, true)).wait();
    await (await f.manager.connect(f.deployer).setPoolParamAllowed(src.protocol, src.param(f), true)).wait();
}

async function deployRegistered() {
    const f = await deployIdleSavingsHarness();
    for (const src of SOURCES) await registerSource(f, src);
    return f;
}

function open(f: Harness, src: SourceSpec, safeAddr = f.safeAddr, overrides: Record<string, any> = {}) {
    return f.manager.connect(f.operatorEOA).openLp(src.protocol, openParams(safeAddr, src.param(f), overrides));
}

function close(f: Harness, src: SourceSpec, safeAddr = f.safeAddr, overrides: Record<string, any> = {}) {
    return f.manager
        .connect(f.operatorEOA)
        .closeLp(src.protocol, closeParams(safeAddr, tokenIdOf(safeAddr), overrides));
}

function withdraw(f: Harness, src: SourceSpec, safeAddr = f.safeAddr, overrides: Record<string, any> = {}) {
    return f.manager
        .connect(f.operatorEOA)
        .withdrawLp(src.protocol, withdrawParams(safeAddr, tokenIdOf(safeAddr), overrides));
}

function roll(f: Harness, src: SourceSpec, safeAddr = f.safeAddr) {
    return f.manager
        .connect(f.operatorEOA)
        .switchLp(src.protocol, src.protocol, switchParams(safeAddr, tokenIdOf(safeAddr), src.param(f)));
}

async function sharesOf(f: Harness, src: SourceSpec, safeAddr = f.safeAddr) {
    return slotValue(f.managerAddr, await src.handler(f).idleSavingsSharesSlot(tokenIdOf(safeAddr)));
}

async function totalShares(f: Harness, src: SourceSpec) {
    return slotValue(f.managerAddr, await src.handler(f).idleSavingsTotalSharesSlot());
}

async function expectZeroResidue(f: Harness) {
    expect(await f.usdc.balanceOf(f.managerAddr)).to.equal(0);
    expect(await f.susds.balanceOf(f.managerAddr)).to.equal(0);
    expect(await f.mockShare.balanceOf(f.managerAddr)).to.equal(0);
}

describe("SafeYieldManager + idle savings handlers", function () {
    for (const src of SOURCES) {
        describe(src.name, function () {
            describe("registration", function () {
                it("registers through the timelock and rejects a PROTOCOL mismatch", async function () {
                    const f = await loadFixture(deployIdleSavingsHarness);
                    const { manager, timelock } = f;
                    const handlerAddr = src.handlerAddr(f);
                    expect(await src.handler(f).PROTOCOL()).to.equal(src.protocol);
                    await expect(timelockCall(timelock, manager, "setYieldHandler", [src.protocol + 1, handlerAddr]))
                        .to.be.revertedWithCustomError(manager, "HandlerProtocolMismatch")
                        .withArgs(src.protocol + 1, src.protocol);
                    await expect(timelockCall(timelock, manager, "setYieldHandler", [src.protocol, handlerAddr]))
                        .to.emit(manager, "YieldHandlerUpdated")
                        .withArgs(src.protocol, ZERO, handlerAddr);
                    expect(await manager.yieldHandlers(src.protocol)).to.equal(handlerAddr);
                });

                it("starts a new id with both switches off", async function () {
                    const f = await loadFixture(deployIdleSavingsHarness);
                    const { manager, timelock, deployer, pauser } = f;
                    await expect(
                        manager.connect(deployer).setPoolParamAllowed(src.protocol, src.param(f), true),
                    ).to.be.revertedWithCustomError(manager, "HandlerNotSet");
                    await (await timelockCall(timelock, manager, "setYieldHandler", [src.protocol, src.handlerAddr(f)])).wait();
                    expect(await manager.protocolEnabledForOpen(src.protocol)).to.equal(false);
                    expect(await manager.protocolEnabledForClose(src.protocol)).to.equal(false);
                    await (await manager.connect(deployer).setPoolParamAllowed(src.protocol, src.param(f), true)).wait();
                    await expect(open(f, src)).to.be.revertedWithCustomError(manager, "ProtocolDisabled");

                    await (await manager.connect(pauser).setProtocolEnabledForOpen(src.protocol, true)).wait();
                    await (await open(f, src)).wait();
                    await expect(close(f, src)).to.be.revertedWithCustomError(manager, "ProtocolDisabled");
                    await expect(withdraw(f, src)).to.be.revertedWithCustomError(manager, "ProtocolDisabled");
                });

                it("keeps the switches as they are when a replacement build is registered", async function () {
                    const f = await loadFixture(deployRegistered);
                    const { manager, timelock, pauser } = f;
                    await (await timelockCall(timelock, manager, "setYieldHandler", [src.protocol, await src.deployBuild(f)])).wait();
                    expect(await manager.protocolEnabledForOpen(src.protocol)).to.equal(true);
                    expect(await manager.protocolEnabledForClose(src.protocol)).to.equal(true);

                    await (await manager.connect(pauser).setProtocolEnabledForOpen(src.protocol, false)).wait();
                    await (await timelockCall(timelock, manager, "setYieldHandler", [src.protocol, src.handlerAddr(f)])).wait();
                    expect(await manager.protocolEnabledForOpen(src.protocol)).to.equal(false);
                    expect(await manager.protocolEnabledForClose(src.protocol)).to.equal(true);
                });
            });

            describe("allow-list", function () {
                it("allow-lists the pool param without any price reference", async function () {
                    const f = await loadFixture(deployRegistered);
                    const { manager, usdcAddr } = f;
                    const handler = src.handler(f);
                    expect(await manager.isPoolParamAllowed(src.protocol, src.param(f))).to.equal(true);
                    expect((await manager.twapConfigOf(src.shareTokenAddr(f))).pool).to.equal(ZERO);
                    expect(await handler.poolTokens(src.param(f))).to.deep.equal([usdcAddr, usdcAddr]);
                    expect(await handler.poolTokens("0x")).to.deep.equal([usdcAddr, usdcAddr]);
                    expect(await handler.poolParamHasHooks(src.param(f))).to.equal(false);
                });

                it("rejects a pool param with a wrong venue or share token even when allow-listed", async function () {
                    const f = await loadFixture(deployRegistered);
                    const { manager, deployer, stranger, usdcAddr } = f;
                    const wrongVenue = encodeParam(stranger.address, src.shareTokenAddr(f));
                    const wrongShare = encodeParam(src.venueAddr(f), usdcAddr);
                    await (await manager.connect(deployer).setPoolParamAllowed(src.protocol, wrongVenue, true)).wait();
                    await (await manager.connect(deployer).setPoolParamAllowed(src.protocol, wrongShare, true)).wait();
                    await expect(open(f, src, f.safeAddr, { lpPoolParam: wrongVenue })).to.be.revertedWithCustomError(
                        src.handler(f),
                        "WrongPoolParam",
                    );
                    await expect(open(f, src, f.safeAddr, { lpPoolParam: wrongShare })).to.be.revertedWithCustomError(
                        src.handler(f),
                        "WrongPoolParam",
                    );
                });

                it("rejects the right pool param once it is de-listed", async function () {
                    const f = await loadFixture(deployRegistered);
                    await (await f.manager.connect(f.deployer).setPoolParamAllowed(src.protocol, src.param(f), false)).wait();
                    await expect(open(f, src)).to.be.revertedWithCustomError(src.handler(f), "PoolParamNotAllowed");
                });
            });

            describe("deposit", function () {
                it("moves USDC into the share token and records basis, shares and events", async function () {
                    const f = await loadFixture(deployRegistered);
                    const { manager, managerEvents, usdc, safeAddr } = f;
                    const tokenId = tokenIdOf(safeAddr);
                    const shares = sharesFor(DEPOSIT, RATE);
                    const usdcBefore = await usdc.balanceOf(safeAddr);

                    const tx = open(f, src);
                    await expect(tx)
                        .to.emit(manager, "PositionOpened")
                        .withArgs(safeAddr, src.protocol, tokenId, DEPOSIT, DEPOSIT, shares, DEPOSIT);
                    await expect(tx)
                        .to.emit(managerEvents, "IdleSavingsDeposited")
                        .withArgs(safeAddr, tokenId, DEPOSIT, shares, RATE);

                    expect(await usdc.balanceOf(safeAddr)).to.equal(usdcBefore - DEPOSIT);
                    expect(await src.shareToken(f).balanceOf(safeAddr)).to.equal(shares);
                    expect(await usdc.allowance(safeAddr, src.venueAddr(f))).to.equal(0);
                    expect(await manager.residualBasisUsd6Of(src.protocol, tokenId)).to.equal(DEPOSIT);
                    expect(await manager.positionHandlerOf(src.protocol, tokenId)).to.equal(src.handlerAddr(f));
                    expect(await sharesOf(f, src)).to.equal(shares);
                    expect(await totalShares(f, src)).to.equal(shares);
                    await expectZeroResidue(f);
                });

                it("reverts SwapFailed when the Safe receives fewer shares than the floor", async function () {
                    const f = await loadFixture(deployRegistered);
                    // Mode 3: the Safe reports success without executing, so no shares arrive.
                    await (await f.safe.setFail(src.venueAddr(f), 3)).wait();
                    await (await f.safe.setFailData("0x")).wait();
                    await expect(open(f, src)).to.be.revertedWithCustomError(src.handler(f), "SwapFailed");
                });

                it("bounds slippageBps to [1, MAX_TOLERANCE_BPS] on open and close", async function () {
                    const f = await loadFixture(deployRegistered);
                    const handler = src.handler(f);
                    await expect(open(f, src, f.safeAddr, { slippageBps: 0 })).to.be.revertedWithCustomError(handler, "SlippageTooLow");
                    await expect(open(f, src, f.safeAddr, { slippageBps: MAX_TOLERANCE_BPS + 1 })).to.be.revertedWithCustomError(
                        handler,
                        "SlippageAboveMax",
                    );
                    await (await open(f, src, f.safeAddr, { slippageBps: MAX_TOLERANCE_BPS })).wait();
                    await expect(close(f, src, f.safeAddr, { slippageBps: 0 })).to.be.revertedWithCustomError(handler, "SlippageTooLow");
                    await expect(close(f, src, f.safeAddr, { slippageBps: MAX_TOLERANCE_BPS + 1 })).to.be.revertedWithCustomError(
                        handler,
                        "SlippageAboveMax",
                    );
                    await (await close(f, src, f.safeAddr, { slippageBps: MAX_TOLERANCE_BPS })).wait();
                });

                it("needs a tolerance at least equal to a price lag below the venue rate on deposit", async function () {
                    const f = await loadFixture(deployRegistered);
                    if (src === SKY_SRC) await (await f.feed.set(bps(RATE, -30), await time.latest())).wait();
                    else await (await f.mockProvider.set(bps(RATE, -30))).wait();
                    await expect(open(f, src, f.safeAddr, { slippageBps: 20 })).to.be.revertedWith(src.tooLow.deposit);
                    await (await open(f, src, f.safeAddr, { slippageBps: 40 })).wait();
                    await expectZeroResidue(f);
                });

                it("needs a tolerance at least equal to a price lead above the venue rate on redeem", async function () {
                    const f = await loadFixture(deployRegistered);
                    await (await open(f, src)).wait();
                    if (src === SKY_SRC) await (await f.feed.set(bps(RATE, 30), await time.latest())).wait();
                    else await (await f.mockProvider.set(bps(RATE, 30))).wait();
                    await expect(close(f, src, f.safeAddr, { slippageBps: 20 })).to.be.revertedWith(src.tooLow.redeem);
                    await (await close(f, src, f.safeAddr, { slippageBps: 40 })).wait();
                    await expectZeroResidue(f);
                });
            });

            describe("no top-up", function () {
                it("rejects a second deposit while the position is open and changes nothing", async function () {
                    const f = await loadFixture(deployRegistered);
                    const { usdc, safeAddr } = f;
                    await (await open(f, src)).wait();
                    const usdcBefore = await usdc.balanceOf(safeAddr);
                    const sharesBefore = await src.shareToken(f).balanceOf(safeAddr);
                    const total = await totalShares(f, src);
                    await expect(open(f, src, safeAddr, { usdcAmount: USDC(10) })).to.be.revertedWithCustomError(
                        src.handler(f),
                        "PositionAlreadyOpen",
                    );
                    expect(await usdc.balanceOf(safeAddr)).to.equal(usdcBefore);
                    expect(await src.shareToken(f).balanceOf(safeAddr)).to.equal(sharesBefore);
                    expect(await totalShares(f, src)).to.equal(total);
                });

                it("accepts a fresh deposit after a full close with a fresh basis and shares record", async function () {
                    const f = await loadFixture(deployRegistered);
                    const { manager, safeAddr } = f;
                    await (await open(f, src)).wait();
                    await (await close(f, src)).wait();
                    expect(await manager.positionHandlerOf(src.protocol, tokenIdOf(safeAddr))).to.equal(ZERO);
                    expect(await sharesOf(f, src)).to.equal(0);
                    expect(await totalShares(f, src)).to.equal(0);

                    const second = USDC(250_000);
                    await (await open(f, src, safeAddr, { usdcAmount: second })).wait();
                    expect(await manager.residualBasisUsd6Of(src.protocol, tokenIdOf(safeAddr))).to.equal(second);
                    expect(await sharesOf(f, src)).to.equal(sharesFor(second, RATE));
                    expect(await totalShares(f, src)).to.equal(sharesFor(second, RATE));
                    await expectZeroResidue(f);
                });

                it("reverts StaleSharesRecord when a shares record survives without a pin", async function () {
                    const f = await loadFixture(deployRegistered);
                    await setSlot(f.managerAddr, await src.handler(f).idleSavingsSharesSlot(tokenIdOf(f.safeAddr)), 1n);
                    await expect(open(f, src)).to.be.revertedWithCustomError(src.handler(f), "StaleSharesRecord");
                });
            });

            describe("exposure rail", function () {
                it("rejects a deposit that would push the tracked book above the venue's liquidity", async function () {
                    const f = await loadFixture(deployRegistered);
                    const { usdc, safe2Addr } = f;
                    await (await open(f, src)).wait();
                    const available = await usdc.balanceOf(src.venueAddr(f));
                    const tracked = usdcFor(await totalShares(f, src), RATE);
                    const amount = available - tracked + 1n;
                    await expect(open(f, src, safe2Addr, { usdcAmount: amount }))
                        .to.be.revertedWithCustomError(src.handler(f), "ExposureCapExceeded")
                        .withArgs(tracked + amount, available);
                });

                it("accepts a deposit exactly at the cap and rejects one unit more", async function () {
                    const f = await loadFixture(deployRegistered);
                    const { usdc, safe2Addr } = f;
                    await (await open(f, src)).wait();
                    const tracked = usdcFor(await totalShares(f, src), RATE);
                    const amount = USDC(500_000);
                    const available = await usdc.balanceOf(src.venueAddr(f));
                    await (await usdc.burn(src.venueAddr(f), available - (tracked + amount))).wait();
                    await expect(open(f, src, safe2Addr, { usdcAmount: amount + 1n }))
                        .to.be.revertedWithCustomError(src.handler(f), "ExposureCapExceeded")
                        .withArgs(tracked + amount + 1n, tracked + amount);
                    await (await open(f, src, safe2Addr, { usdcAmount: amount })).wait();
                    await expectZeroResidue(f);
                });

                it("returns headroom after a partial close once the venue is refilled", async function () {
                    const f = await loadFixture(deployRegistered);
                    const { usdc, safe2Addr } = f;
                    const venue = src.venueAddr(f);
                    await (await open(f, src)).wait();
                    const tracked = usdcFor(await totalShares(f, src), RATE);
                    await (await usdc.burn(venue, (await usdc.balanceOf(venue)) - tracked)).wait();
                    await expect(open(f, src, safe2Addr, { usdcAmount: USDC(10) })).to.be.revertedWithCustomError(
                        src.handler(f),
                        "ExposureCapExceeded",
                    );
                    const before = await usdc.balanceOf(venue);
                    await (await close(f, src, f.safeAddr, { exitBps: 5_000 })).wait();
                    await (await usdc.mint(venue, before - (await usdc.balanceOf(venue)))).wait();
                    await (await open(f, src, safe2Addr, { usdcAmount: USDC(10) })).wait();
                    await expectZeroResidue(f);
                });
            });

            describe("close", function () {
                it("fully closes after the rate rose and charges the performance fee on the profit", async function () {
                    const f = await loadFixture(deployRegistered);
                    const { manager, managerEvents, usdc, treasury, safeAddr } = f;
                    const tokenId = tokenIdOf(safeAddr);
                    await (await open(f, src)).wait();
                    const shares = sharesFor(DEPOSIT, RATE);
                    const newRate = 1_120_000_000_000_000_000n;
                    await src.setRate(f, newRate);
                    const value = usdcFor(shares, newRate);
                    const fee = ((value - DEPOSIT) * PERF_FEE_BPS) / 10_000n;
                    expect(value).to.be.greaterThan(DEPOSIT);
                    const usdcBefore = await usdc.balanceOf(safeAddr);

                    const tx = close(f, src);
                    await expect(tx)
                        .to.emit(manager, "PositionClosed")
                        .withArgs(safeAddr, src.protocol, tokenId, DEPOSIT, value, fee, 10_000, 0);
                    await expect(tx)
                        .to.emit(managerEvents, "IdleSavingsRedeemed")
                        .withArgs(safeAddr, tokenId, shares, value, newRate, 10_000);

                    expect(await usdc.balanceOf(treasury.address)).to.equal(fee);
                    expect(await usdc.balanceOf(safeAddr)).to.equal(usdcBefore + value - fee);
                    expect(await manager.residualBasisUsd6Of(src.protocol, tokenId)).to.equal(0);
                    expect(await manager.positionHandlerOf(src.protocol, tokenId)).to.equal(ZERO);
                    expect(await sharesOf(f, src)).to.equal(0);
                    expect(await totalShares(f, src)).to.equal(0);
                    expect(await src.shareToken(f).allowance(safeAddr, src.venueAddr(f))).to.equal(0);
                    await expectZeroResidue(f);
                });

                it("partially closes and prorates shares, basis and carry", async function () {
                    const f = await loadFixture(deployRegistered);
                    const { manager, managerAddr, managerEvents, safeAddr } = f;
                    const tokenId = tokenIdOf(safeAddr);
                    await (await open(f, src)).wait();
                    const shares = sharesFor(DEPOSIT, RATE);
                    const carry = 1_000n;
                    await setSlot(managerAddr, yieldSlot(YIELD_FIELD.carry, src.protocol, tokenId), carry);

                    const toRedeem = (shares * 2_500n) / 10_000n;
                    const value = usdcFor(toRedeem, RATE);
                    const basisForExit = (DEPOSIT * 2_500n) / 10_000n;
                    const carryForExit = (carry * 2_500n) / 10_000n;
                    const realized = value + carryForExit;
                    const fee = realized > basisForExit ? ((realized - basisForExit) * PERF_FEE_BPS) / 10_000n : 0n;

                    const tx = close(f, src, safeAddr, { exitBps: 2_500 });
                    await expect(tx)
                        .to.emit(manager, "PositionClosed")
                        .withArgs(safeAddr, src.protocol, tokenId, basisForExit, value, fee, 2_500, carryForExit);
                    await expect(tx)
                        .to.emit(managerEvents, "IdleSavingsRedeemed")
                        .withArgs(safeAddr, tokenId, toRedeem, value, RATE, 2_500);
                    expect(await manager.residualBasisUsd6Of(src.protocol, tokenId)).to.equal(DEPOSIT - basisForExit);
                    expect(await manager.carryProfitUsd6Of(src.protocol, tokenId)).to.equal(carry - carryForExit);
                    expect(await sharesOf(f, src)).to.equal(shares - toRedeem);
                    expect(await totalShares(f, src)).to.equal(shares - toRedeem);

                    await (await close(f, src)).wait();
                    expect(await sharesOf(f, src)).to.equal(0);
                    expect(await totalShares(f, src)).to.equal(0);
                    expect(await manager.positionHandlerOf(src.protocol, tokenId)).to.equal(ZERO);
                    await expectZeroResidue(f);
                });

                it("reverts InvalidExitBps when a basis decrement would stand without shares leaving", async function () {
                    const f = await loadFixture(deployRegistered);
                    await (await open(f, src)).wait();
                    await setSlot(f.managerAddr, await src.handler(f).idleSavingsSharesSlot(tokenIdOf(f.safeAddr)), 1n);
                    await expect(close(f, src, f.safeAddr, { exitBps: 1 })).to.be.revertedWithCustomError(
                        src.handler(f),
                        "InvalidExitBps",
                    );
                });

                it("redeems what is left after the Safe moved shares out around the module", async function () {
                    const f = await loadFixture(deployRegistered);
                    const { manager, managerEvents, stranger, safeAddr } = f;
                    const share = src.shareToken(f);
                    const tokenId = tokenIdOf(safeAddr);
                    await (await open(f, src)).wait();
                    const shares = sharesFor(DEPOSIT, RATE);
                    const half = shares / 2n;
                    await (await share.connect(await safeSigner(safeAddr)).transfer(stranger.address, half)).wait();

                    const value = usdcFor(shares - half, RATE);
                    const tx = close(f, src);
                    await expect(tx)
                        .to.emit(managerEvents, "IdleSavingsSharesShortfall")
                        .withArgs(safeAddr, tokenId, shares, shares - half);
                    await expect(tx)
                        .to.emit(manager, "PositionClosed")
                        .withArgs(safeAddr, src.protocol, tokenId, DEPOSIT, value, 0, 10_000, 0);
                    expect(await share.balanceOf(safeAddr)).to.equal(0);
                    expect(await share.balanceOf(stranger.address)).to.equal(half);
                    expect(await sharesOf(f, src)).to.equal(0);
                    expect(await totalShares(f, src)).to.equal(0);
                    await expectZeroResidue(f);
                });

                it("bubbles the venue's USDC revert and leaves storage untouched", async function () {
                    const f = await loadFixture(deployRegistered);
                    const { manager, usdc, safe, safeAddr, safe2Addr } = f;
                    const venue = src.venueAddr(f);
                    await (await open(f, src)).wait();
                    const shares = await sharesOf(f, src);
                    await (await usdc.burn(venue, await usdc.balanceOf(venue))).wait();
                    await expect(close(f, src)).to.be.revertedWith("ERC20: transfer amount exceeds balance");
                    expect(await sharesOf(f, src)).to.equal(shares);
                    expect(await totalShares(f, src)).to.equal(shares);
                    expect(await manager.positionHandlerOf(src.protocol, tokenIdOf(safeAddr))).to.equal(src.handlerAddr(f));
                    expect(await manager.residualBasisUsd6Of(src.protocol, tokenIdOf(safeAddr))).to.equal(DEPOSIT);

                    await (await safe.setFail(venue, 1)).wait();
                    await expect(close(f, src))
                        .to.be.revertedWithCustomError(src.handler(f), "ModuleCallFailed")
                        .withArgs(src.steps.redeem);
                    await (await usdc.mint(venue, USDC(10_000_000))).wait();
                    await (await f.safe2.setFail(venue, 1)).wait();
                    await expect(open(f, src, safe2Addr))
                        .to.be.revertedWithCustomError(src.handler(f), "ModuleCallFailed")
                        .withArgs(src.steps.deposit);
                });
            });

            describe("withdrawLp", function () {
                it("releases the record with no module call and leaves the shares on the Safe", async function () {
                    const f = await loadFixture(deployRegistered);
                    const { manager, managerAddr, managerEvents, usdc, safe, safeAddr, usdcAddr } = f;
                    const share = src.shareToken(f);
                    const tokenId = tokenIdOf(safeAddr);
                    await (await open(f, src)).wait();
                    const shares = sharesFor(DEPOSIT, RATE);
                    const carry = 777n;
                    await setSlot(managerAddr, yieldSlot(YIELD_FIELD.carry, src.protocol, tokenId), carry);
                    const usdcBefore = await usdc.balanceOf(safeAddr);
                    for (const target of [src.venueAddr(f), usdcAddr, src.shareTokenAddr(f)]) {
                        await (await safe.setFail(target, 1)).wait();
                    }

                    const tx = withdraw(f, src);
                    await expect(tx).to.emit(managerEvents, "IdleSavingsReleased").withArgs(safeAddr, tokenId, shares);
                    await expect(tx)
                        .to.emit(manager, "PositionWithdrawn")
                        .withArgs(safeAddr, src.protocol, tokenId, DEPOSIT, carry, 0, shares);
                    expect(await share.balanceOf(safeAddr)).to.equal(shares);
                    expect(await usdc.balanceOf(safeAddr)).to.equal(usdcBefore);
                    expect(await sharesOf(f, src)).to.equal(0);
                    expect(await totalShares(f, src)).to.equal(0);
                    expect(await manager.positionHandlerOf(src.protocol, tokenId)).to.equal(ZERO);
                    expect(await manager.residualBasisUsd6Of(src.protocol, tokenId)).to.equal(0);
                    expect(await manager.carryProfitUsd6Of(src.protocol, tokenId)).to.equal(0);
                    await expectZeroResidue(f);
                });
            });

            describe("reverts", function () {
                it("rejects staking, collect and direct entry", async function () {
                    const f = await loadFixture(deployRegistered);
                    const { manager, operatorEOA, safeAddr, usdcAddr } = f;
                    const handler = src.handler(f);
                    const tokenId = tokenIdOf(safeAddr);
                    await expect(open(f, src, safeAddr, { stake: true })).to.be.revertedWithCustomError(
                        handler,
                        "StakingNotSupported",
                    );
                    await (await open(f, src)).wait();
                    await expect(
                        manager.connect(operatorEOA).collectLp(src.protocol, collectParams(safeAddr, tokenId)),
                    ).to.be.revertedWithCustomError(handler, "CollectNotSupported");

                    await expect(handler.openLp(openParams(safeAddr, src.param(f)))).to.be.revertedWithCustomError(
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
                        handler.openLpInKind(inKindParams(safeAddr, src.param(f), usdcAddr, src.shareTokenAddr(f), 0n, 1n)),
                    ).to.be.revertedWithCustomError(handler, "OnlyDelegatecall");
                    await expect(handler.collectLp(collectParams(safeAddr, tokenId))).to.be.revertedWithCustomError(
                        handler,
                        "OnlyDelegatecall",
                    );
                });

                it("never redeems or releases one Safe's shares against another Safe's record", async function () {
                    const f = await loadFixture(deployRegistered);
                    const { manager, operatorEOA, safeAddr, safe2Addr } = f;
                    await (await open(f, src)).wait();
                    await (await open(f, src, safe2Addr)).wait();
                    await expect(
                        manager.connect(operatorEOA).closeLp(src.protocol, closeParams(safeAddr, tokenIdOf(safe2Addr))),
                    ).to.be.revertedWithCustomError(src.handler(f), "WrongPosition");
                    await expect(
                        manager.connect(operatorEOA).withdrawLp(src.protocol, withdrawParams(safeAddr, tokenIdOf(safe2Addr))),
                    ).to.be.revertedWithCustomError(src.handler(f), "WrongPosition");
                });

                it("rejects an approval the token does not confirm", async function () {
                    const f = await loadFixture(deployRegistered);
                    const { safe, usdcAddr } = f;
                    const shareAddr = src.shareTokenAddr(f);
                    await (await safe.setFailData(ethers.ZeroHash)).wait();
                    await (await safe.setFail(usdcAddr, 3)).wait();
                    await expect(open(f, src))
                        .to.be.revertedWithCustomError(src.handler(f), "TokenApprovalFailed")
                        .withArgs(usdcAddr);
                    await (await safe.setFail(usdcAddr, 0)).wait();
                    await (await open(f, src)).wait();
                    await (await safe.setFail(shareAddr, 3)).wait();
                    await expect(close(f, src))
                        .to.be.revertedWithCustomError(src.handler(f), "TokenApprovalFailed")
                        .withArgs(shareAddr);
                });
            });

            describe("pause", function () {
                it("blocks opens while close and withdraw keep working", async function () {
                    const f = await loadFixture(deployRegistered);
                    const { manager, pauser, safe2Addr } = f;
                    await (await open(f, src)).wait();
                    await (await open(f, src, safe2Addr)).wait();
                    await (await manager.connect(pauser).pause()).wait();
                    await expect(open(f, src)).to.be.revertedWithCustomError(manager, "EnforcedPause");
                    await (await close(f, src)).wait();
                    await (await withdraw(f, src, safe2Addr)).wait();
                    await expectZeroResidue(f);
                });
            });

            describe("switchLp", function () {
                it("rejects an in-kind switch between an LP position and the source in either direction", async function () {
                    const f = await loadFixture(deployRegistered);
                    const { manager, uniHandler, operatorEOA, safeAddr } = f;
                    await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, v3OpenParams(f, safeAddr))).wait();
                    await expect(
                        manager.connect(operatorEOA).switchLp(UNISWAP_V3, src.protocol, switchParams(safeAddr, 1, src.param(f))),
                    ).to.be.revertedWithCustomError(src.handler(f), "InKindNotSupported");

                    await (await open(f, src)).wait();
                    await expect(
                        manager
                            .connect(operatorEOA)
                            .switchLp(src.protocol, UNISWAP_V3, switchParams(safeAddr, tokenIdOf(safeAddr), f.feeTier)),
                    ).to.be.revertedWithCustomError(uniHandler, "WrongTokenPair");
                });

                it("rolls a position to a new build under the same id without moving tokens", async function () {
                    const f = await loadFixture(deployRegistered);
                    const { manager, managerAddr, managerEvents, timelock, usdc, treasury, safeAddr } = f;
                    const share = src.shareToken(f);
                    const tokenId = tokenIdOf(safeAddr);
                    await (await open(f, src)).wait();
                    const shares = sharesFor(DEPOSIT, RATE);
                    const carry = 500n;
                    await setSlot(managerAddr, yieldSlot(YIELD_FIELD.carry, src.protocol, tokenId), carry);
                    const build2 = await src.deployBuild(f);
                    await (await timelockCall(timelock, manager, "setYieldHandler", [src.protocol, build2])).wait();
                    const usdcBefore = await usdc.balanceOf(safeAddr);
                    const venueShareBefore = await share.balanceOf(src.venueAddr(f));

                    const tx = roll(f, src);
                    await expect(tx).to.emit(managerEvents, "IdleSavingsReleased").withArgs(safeAddr, tokenId, shares);
                    await expect(tx).to.emit(managerEvents, "IdleSavingsAdopted").withArgs(safeAddr, tokenId, shares);
                    await expect(tx)
                        .to.emit(manager, "PositionSwitched")
                        .withArgs(safeAddr, src.protocol, src.protocol, tokenId, tokenId, DEPOSIT, 0, shares, 0, shares);
                    await expect(tx)
                        .to.emit(manager, "SwitchResidueSettled")
                        .withArgs(safeAddr, src.protocol, tokenId, 0, 0, 0, DEPOSIT, carry);

                    expect(await share.balanceOf(safeAddr)).to.equal(shares);
                    expect(await share.balanceOf(src.venueAddr(f))).to.equal(venueShareBefore);
                    expect(await usdc.balanceOf(safeAddr)).to.equal(usdcBefore);
                    expect(await manager.positionHandlerOf(src.protocol, tokenId)).to.equal(build2);
                    expect(await manager.residualBasisUsd6Of(src.protocol, tokenId)).to.equal(DEPOSIT);
                    expect(await manager.carryProfitUsd6Of(src.protocol, tokenId)).to.equal(carry);
                    expect(await sharesOf(f, src)).to.equal(shares);
                    expect(await totalShares(f, src)).to.equal(shares);

                    const value = usdcFor(shares, RATE);
                    const realized = value + carry;
                    const fee = realized > DEPOSIT ? ((realized - DEPOSIT) * PERF_FEE_BPS) / 10_000n : 0n;
                    await expect(close(f, src))
                        .to.emit(manager, "PositionClosed")
                        .withArgs(safeAddr, src.protocol, tokenId, DEPOSIT, value, fee, 10_000, carry);
                    expect(await usdc.balanceOf(treasury.address)).to.equal(fee);
                    expect(await sharesOf(f, src)).to.equal(0);
                    expect(await totalShares(f, src)).to.equal(0);
                    await expectZeroResidue(f);
                });

                it("rolls over while pricing and the venue are both down", async function () {
                    const f = await loadFixture(deployRegistered);
                    const { manager, timelock, safeAddr } = f;
                    await (await open(f, src)).wait();
                    const build2 = await src.deployBuild(f);
                    await (await timelockCall(timelock, manager, "setYieldHandler", [src.protocol, build2])).wait();
                    await src.breakPricing(f);
                    await src.breakVenue(f);
                    await (await roll(f, src)).wait();
                    expect(await manager.positionHandlerOf(src.protocol, tokenIdOf(safeAddr))).to.equal(build2);
                    await (await withdraw(f, src)).wait();
                    await expectZeroResidue(f);
                });

                it("refuses a rollover when the Safe holds fewer shares than were released", async function () {
                    const f = await loadFixture(deployRegistered);
                    const { manager, timelock, stranger, safeAddr } = f;
                    await (await open(f, src)).wait();
                    await (await src.shareToken(f).connect(await safeSigner(safeAddr)).transfer(stranger.address, 1n)).wait();
                    await (await timelockCall(timelock, manager, "setYieldHandler", [src.protocol, await src.deployBuild(f)])).wait();
                    await expect(roll(f, src)).to.be.revertedWithCustomError(src.handler(f), "SharesNotOnSafe");
                });

                it("refuses a rollover when paused, when either switch is off, or when the param is de-listed", async function () {
                    const f = await loadFixture(deployRegistered);
                    const { manager, timelock, pauser, deployer } = f;
                    await (await open(f, src)).wait();
                    await (await timelockCall(timelock, manager, "setYieldHandler", [src.protocol, await src.deployBuild(f)])).wait();

                    await (await manager.connect(pauser).pause()).wait();
                    await expect(roll(f, src)).to.be.revertedWithCustomError(manager, "EnforcedPause");
                    await (await manager.connect(pauser).unpause()).wait();

                    await (await manager.connect(pauser).setProtocolEnabledForClose(src.protocol, false)).wait();
                    await expect(roll(f, src)).to.be.revertedWithCustomError(manager, "ProtocolDisabled");
                    await (await manager.connect(pauser).setProtocolEnabledForClose(src.protocol, true)).wait();

                    await (await manager.connect(pauser).setProtocolEnabledForOpen(src.protocol, false)).wait();
                    await expect(roll(f, src)).to.be.revertedWithCustomError(manager, "ProtocolDisabled");
                    await (await manager.connect(pauser).setProtocolEnabledForOpen(src.protocol, true)).wait();

                    await (await manager.connect(deployer).setPoolParamAllowed(src.protocol, src.param(f), false)).wait();
                    await expect(roll(f, src)).to.be.revertedWithCustomError(src.handler(f), "PoolParamNotAllowed");
                    await (await manager.connect(deployer).setPoolParamAllowed(src.protocol, src.param(f), true)).wait();
                    await (await roll(f, src)).wait();
                    await expectZeroResidue(f);
                });

                it("reverts TwapNotConfigured when a new build adopts fewer shares than were released", async function () {
                    const f = await loadFixture(deployRegistered);
                    const { manager, timelock, usdcAddr } = f;
                    await (await open(f, src)).wait();
                    const Under = await ethers.getContractFactory("MockUnderAdoptingYieldHandler");
                    const under = await Under.deploy(src.protocol, usdcAddr);
                    await under.waitForDeployment();
                    await (await timelockCall(timelock, manager, "setYieldHandler", [src.protocol, await under.getAddress()])).wait();
                    await expect(roll(f, src))
                        .to.be.revertedWithCustomError(manager, "TwapNotConfigured")
                        .withArgs(src.shareTokenAddr(f));
                });
            });

            describe("storage namespace", function () {
                it("derives the ERC-7201 slot and leaves YieldLayout untouched except the pin and basis", async function () {
                    const f = await loadFixture(deployRegistered);
                    const { managerAddr, safeAddr } = f;
                    const handler = src.handler(f);
                    const tokenId = tokenIdOf(safeAddr);
                    const namespaceId = BigInt(ethers.keccak256(ethers.toUtf8Bytes("ratehopper.storage.idleSavings"))) - 1n;
                    const base = BigInt(ethers.keccak256(abi.encode(["uint256"], [namespaceId]))) & ~0xffn;
                    expect(base).to.not.equal(YIELD_SLOT);
                    expect(await handler.idleSavingsSharesSlot(tokenId)).to.equal(
                        mapSlot(tokenId, BigInt(mapSlot(BigInt(src.protocol), base))),
                    );
                    expect(await handler.idleSavingsTotalSharesSlot()).to.equal(mapSlot(BigInt(src.protocol), base + 1n));

                    const watched: Record<string, string> = { scalar: ethers.toBeHex(YIELD_SLOT, 32) };
                    for (const protocol of [0, 1, 2, SKY, MOCK]) {
                        for (const id of [1n, tokenId]) {
                            watched[`basis:${protocol}:${id}`] = yieldSlot(YIELD_FIELD.residualBasis, protocol, id);
                            watched[`pin:${protocol}:${id}`] = yieldSlot(YIELD_FIELD.positionHandler, protocol, id);
                            watched[`carry:${protocol}:${id}`] = yieldSlot(YIELD_FIELD.carry, protocol, id);
                        }
                    }
                    const allowedBase = YIELD_SLOT + YIELD_FIELD.allowedPoolKey;
                    for (const s of SOURCES) {
                        watched[`allowed:${s.protocol}`] = mapSlot(
                            BigInt(ethers.keccak256(s.param(f))),
                            BigInt(mapSlot(BigInt(s.protocol), allowedBase)),
                        );
                    }
                    watched["allowed:0"] = mapSlot(BigInt(ethers.keccak256(f.feeTier)), BigInt(mapSlot(0n, allowedBase)));
                    const before: Record<string, bigint> = {};
                    for (const [k, slot] of Object.entries(watched)) before[k] = await slotValue(managerAddr, slot);
                    expect(before[`allowed:${src.protocol}`]).to.equal(1n);

                    await (await open(f, src)).wait();
                    for (const [k, slot] of Object.entries(watched)) {
                        const after = await slotValue(managerAddr, slot);
                        if (k === `basis:${src.protocol}:${tokenId}` || k === `pin:${src.protocol}:${tokenId}`) {
                            expect(after, k).to.not.equal(before[k]);
                        } else expect(after, k).to.equal(before[k]);
                    }
                    expect(await sharesOf(f, src)).to.equal(sharesFor(DEPOSIT, RATE));
                });
            });

            describe("exit liveness", function () {
                it("keeps withdrawLp alive through every failure except the close switch", async function () {
                    const f = await loadFixture(deployRegistered);
                    const { manager, pauser, usdc, safeAddr, safe2Addr } = f;
                    await (await open(f, src)).wait();
                    await (await open(f, src, safe2Addr)).wait();
                    await src.breakPricing(f);
                    await src.breakVenue(f);
                    await (await usdc.burn(src.venueAddr(f), await usdc.balanceOf(src.venueAddr(f)))).wait();
                    await (await manager.connect(pauser).pause()).wait();
                    await (await withdraw(f, src)).wait();
                    expect(await src.shareToken(f).balanceOf(safeAddr)).to.equal(sharesFor(DEPOSIT, RATE));

                    await (await manager.connect(pauser).setProtocolEnabledForClose(src.protocol, false)).wait();
                    await expect(withdraw(f, src, safe2Addr)).to.be.revertedWithCustomError(manager, "ProtocolDisabled");
                    await (await manager.connect(pauser).setProtocolEnabledForClose(src.protocol, true)).wait();
                    await (await withdraw(f, src, safe2Addr)).wait();
                    await expectZeroResidue(f);
                });
            });
        });
    }

    describe("Sky specifics", function () {
        const src = SKY_SRC;

        it("carries the Osero referral code on the PSM3 Swap event", async function () {
            const f = await loadFixture(deployRegistered);
            const { psm3, safeAddr, usdcAddr, susdsAddr } = f;
            const shares = sharesFor(DEPOSIT, RATE);
            await expect(open(f, src))
                .to.emit(psm3, "Swap")
                .withArgs(usdcAddr, susdsAddr, safeAddr, safeAddr, DEPOSIT, shares, OSERO_REFERRAL_CODE);
            await expect(close(f, src))
                .to.emit(psm3, "Swap")
                .withArgs(susdsAddr, usdcAddr, safeAddr, safeAddr, shares, usdcFor(shares, RATE), OSERO_REFERRAL_CODE);
        });

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
                await (await open(f, src)).wait();
                await state.apply(f);
                const expectRevert = (tx: Promise<any>) =>
                    state.error
                        ? expect(tx).to.be.revertedWithCustomError(provider, state.error)
                        : expect(tx).to.be.revertedWith(state.reason!);
                await expectRevert(close(f, src));
                await expectRevert(open(f, src, safe2Addr));
                const shares = await susds.balanceOf(safeAddr);
                await (await withdraw(f, src)).wait();
                expect(await susds.balanceOf(safeAddr)).to.equal(shares);
                expect(await sharesOf(f, src)).to.equal(0);
                await expectZeroResidue(f);
            });
        }

        it("passes a 49 bps disagreement in either direction on open and close", async function () {
            for (const delta of [49, -49]) {
                const f = await loadFixture(deployRegistered);
                await (await f.feed.set(bps(RATE, delta), await time.latest())).wait();
                await (await open(f, src, f.safeAddr, { slippageBps: MAX_TOLERANCE_BPS })).wait();
                await (await close(f, src, f.safeAddr, { slippageBps: MAX_TOLERANCE_BPS })).wait();
                await expectZeroResidue(f);
            }
        });
    });

    describe("mock source specifics", function () {
        const src = MOCK_SRC;

        it("rejects a short-paying venue below the floor on the measured delta", async function () {
            const f = await loadFixture(deployRegistered);
            await (await open(f, src)).wait();
            await (await f.mockVenue.setShortPay(USDC(10_000))).wait();
            await expect(close(f, src)).to.be.revertedWithCustomError(src.handler(f), "MinUsdcOutNotMet");
        });

        it("reports a short-pay inside the tolerance as the measured delta", async function () {
            const f = await loadFixture(deployRegistered);
            const { manager, safeAddr } = f;
            await (await open(f, src)).wait();
            const shortPay = USDC(100);
            await (await f.mockVenue.setShortPay(shortPay)).wait();
            const value = usdcFor(sharesFor(DEPOSIT, RATE), RATE) - shortPay;
            await expect(close(f, src))
                .to.emit(manager, "PositionClosed")
                .withArgs(safeAddr, src.protocol, tokenIdOf(safeAddr), DEPOSIT, value, 0, 10_000, 0);
        });

        it("enforces the caller's minUsdcOut above the oracle floor", async function () {
            const f = await loadFixture(deployRegistered);
            await (await open(f, src)).wait();
            const expected = usdcFor(sharesFor(DEPOSIT, RATE), RATE);
            await expect(close(f, src, f.safeAddr, { minUsdcOut: expected + 1n })).to.be.revertedWith(src.tooLow.redeem);
            await (await f.mockVenue.setShortPay(1n)).wait();
            await expect(close(f, src, f.safeAddr, { minUsdcOut: expected })).to.be.revertedWithCustomError(
                src.handler(f),
                "MinUsdcOutNotMet",
            );
        });

        it("rejects a deposit whose share floor rounds to zero", async function () {
            const f = await loadFixture(deployRegistered);
            await (await f.mockProvider.set(10n ** 40n)).wait();
            await expect(open(f, src, f.safeAddr, { usdcAmount: USDC(1) })).to.be.revertedWithCustomError(
                src.handler(f),
                "InvalidSwapAmountOutMin",
            );
        });
    });
});
