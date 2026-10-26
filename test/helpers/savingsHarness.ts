import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture, time, impersonateAccount, setBalance } from "@nomicfoundation/hardhat-network-helpers";
import {
    YieldProtocol,
    OSERO_REFERRAL_CODE,
    encodeSkySavingsPoolParam,
    encodeUniV3PoolParam,
} from "../../contractAddresses";
import { ZERO_LEG, leg } from "../helpers/utils";

// ─────────────────────────────────────────────────────────────────────────
//  Shared harness for the savings handler suites: the mock stack for
//  both sources (Sky over PSM3 + ChainlinkSsrRateProvider, and the mock
//  source over a trivial venue), param builders, slot math and the source
//  descriptors the parametrized cases iterate over.
// ─────────────────────────────────────────────────────────────────────────

export const ZERO = "0x0000000000000000000000000000000000000000";
export const abi = ethers.AbiCoder.defaultAbiCoder();
export const YIELD_SLOT = 0x53ba738b9a2829dfda910cf4e864fcd3f84e03854b49244f3d159a473ee6a400n;
// YieldLayout field offsets (see YieldStorage.sol)
export const YIELD_FIELD = { residualBasis: 1n, allowedPoolKey: 2n, positionHandler: 5n, carry: 8n };
export const DEADLINE = ethers.MaxUint256;
export const TOLERANCE = 20;
export const PERF_FEE_BPS = 1000n; // 10%
export const COLLECT_FEE_BPS = 250n;
export const MAX_FEE_BPS = 2000;
export const Q96 = 1n << 96n;
export const TWAP_WINDOW = 1800;
export const TWAP_CARDINALITY = 60;

export const UNISWAP_V3 = YieldProtocol.UNISWAP_V3;
export const SKY = YieldProtocol.SKY_SAVINGS;
export const MOCK = 250;

export const ONE = 10n ** 18n;
export const RATE = 1_100_000_000_000_000_000n; // 1.1e18
export const RATE27 = RATE * 10n ** 9n;
export const MAX_FEED_AGE = 129_600;
export const MAX_DISAGREEMENT_BPS = 50;
export const MAX_RATE = 2n * ONE;
export const MAX_TOLERANCE_BPS = 50;
export const MAX_EXPOSURE_BPS = 10_000;

export const USDC = (n: number | bigint) => BigInt(n) * 10n ** 6n;
export const DEPOSIT = USDC(1_000_000);
export const WETH_OUT = 2_000_000n;

export const sharesFor = (usdc6: bigint, rate: bigint) => (usdc6 * 10n ** 30n) / rate;
export const usdcFor = (shares: bigint, rate: bigint) => (shares * rate) / 10n ** 30n;
export const tokenIdOf = (safeAddr: string) => BigInt(safeAddr);
export const bps = (x: bigint, delta: number) => (x * BigInt(10_000 + delta)) / 10_000n;
export const encodeParam = (venue: string, share: string) => abi.encode(["address", "address"], [venue, share]);

export function timelockCall(timelock: any, manager: any, functionName: string, args: any[]) {
    return timelock.execute(manager.target, manager.interface.encodeFunctionData(functionName, args));
}

export function openParams(safeAddr: string, poolParam: string, overrides: Record<string, any> = {}) {
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
        poolParam: poolParam,
        stake: false,
        ...overrides,
    };
}

export function closeParams(safeAddr: string, tokenId: bigint | number, overrides: Record<string, any> = {}) {
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

export function withdrawParams(safeAddr: string, tokenId: bigint | number, overrides: Record<string, any> = {}) {
    return {
        onBehalfOf: safeAddr,
        tokenId,
        decreaseAmount0Min: 0,
        decreaseAmount1Min: 0,
        deadline: DEADLINE,
        ...overrides,
    };
}

export function switchParams(safeAddr: string, tokenId: bigint | number, poolParam: string, overrides: Record<string, any> = {}) {
    return {
        onBehalfOf: safeAddr,
        tokenId,
        decreaseAmount0Min: 0,
        decreaseAmount1Min: 0,
        tickLower: 0,
        tickUpper: 0,
        mintAmount0Min: 0,
        mintAmount1Min: 0,
        poolParam: poolParam,
        deadline: DEADLINE,
        ...overrides,
    };
}

export function collectParams(safeAddr: string, tokenId: bigint | number) {
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

export function inKindParams(safeAddr: string, poolParam: string, token0: string, token1: string, amount0: bigint, amount1: bigint) {
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
        poolParam: poolParam,
        deadline: DEADLINE,
    };
}

export function v3OpenParams(f: Harness, safeAddr: string) {
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
        poolParam: f.feeTier,
        stake: false,
    };
}

export function mapSlot(key: bigint, base: bigint): string {
    return ethers.keccak256(abi.encode(["uint256", "uint256"], [key, base]));
}

export function yieldSlot(field: bigint, protocol: number, tokenId: bigint): string {
    return mapSlot(tokenId, BigInt(mapSlot(BigInt(protocol), YIELD_SLOT + field)));
}

export async function slotValue(contractAddr: string, slot: string): Promise<bigint> {
    return BigInt(await ethers.provider.send("eth_getStorageAt", [contractAddr, slot, "latest"]));
}

export async function setSlot(contractAddr: string, slot: string, value: bigint) {
    await network.provider.send("hardhat_setStorageAt", [contractAddr, slot, ethers.toBeHex(value, 32)]);
}

export async function safeSigner(safeAddr: string) {
    await impersonateAccount(safeAddr);
    await setBalance(safeAddr, 10n ** 18n);
    return ethers.getSigner(safeAddr);
}

export async function deploySavingsHarness() {
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
    const skyParam = encodeSkySavingsPoolParam(psm3Addr, susdsAddr);
    const Handler = await ethers.getContractFactory("SkySavingsYieldHandler");
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
    const MockProvider = await ethers.getContractFactory("MockSavingsRateProvider");
    const mockProvider = await MockProvider.deploy(mockShareAddr);
    await mockProvider.waitForDeployment();
    await (await mockProvider.set(RATE)).wait();
    const Venue = await ethers.getContractFactory("MockSavingsVenue");
    const mockVenue = await Venue.deploy(usdcAddr, mockShareAddr);
    await mockVenue.waitForDeployment();
    const mockVenueAddr = await mockVenue.getAddress();
    await (await mockVenue.setRate(RATE)).wait();
    await (await usdc.mint(mockVenueAddr, USDC(10_000_000))).wait();
    const mockParam = encodeParam(mockVenueAddr, mockShareAddr);
    const MockSource = await ethers.getContractFactory("MockSavingsSource");
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
    const managerEvents = await ethers.getContractAt("SkySavingsYieldHandler", managerAddr);

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

export type Harness = Awaited<ReturnType<typeof deploySavingsHarness>>;

export type SourceSpec = {
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
    deployBuild: (f: Harness, exposureBps?: number) => Promise<string>;
    steps: { deposit: number; redeem: number };
    tooLow: { deposit: string; redeem: string };
};

export const SKY_SRC: SourceSpec = {
    name: "SkySavingsYieldHandler (protocol 3)",
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
    deployBuild: async (f, exposureBps = MAX_EXPOSURE_BPS) => {
        const build = await f.Handler.deploy(
            f.usdcAddr,
            f.providerAddr,
            MAX_TOLERANCE_BPS,
            exposureBps,
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

export const MOCK_SRC: SourceSpec = {
    name: "MockSavingsSource (protocol 250)",
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
    deployBuild: async (f, exposureBps = MAX_EXPOSURE_BPS) => {
        const build = await f.MockSource.deploy(
            f.usdcAddr,
            await f.mockProvider.getAddress(),
            MAX_TOLERANCE_BPS,
            exposureBps,
            f.mockVenueAddr,
            f.mockShareAddr,
        );
        await build.waitForDeployment();
        return build.getAddress();
    },
    steps: { deposit: 91, redeem: 94 },
    tooLow: { deposit: "venue/too-few-shares", redeem: "venue/too-little-usdc" },
};

export const SOURCES = [SKY_SRC, MOCK_SRC];

export async function registerSource(f: Harness, src: SourceSpec, handlerAddr = src.handlerAddr(f)) {
    await (await timelockCall(f.timelock, f.manager, "setYieldHandler", [src.protocol, handlerAddr])).wait();
    await (await f.manager.connect(f.pauser).setProtocolEnabledForClose(src.protocol, true)).wait();
    await (await f.manager.connect(f.pauser).setProtocolEnabledForOpen(src.protocol, true)).wait();
    await (await f.manager.connect(f.deployer).setPoolParamAllowed(src.protocol, src.param(f), true)).wait();
}

export async function deployRegistered() {
    const f = await deploySavingsHarness();
    for (const src of SOURCES) await registerSource(f, src);
    return f;
}

export function open(f: Harness, src: SourceSpec, safeAddr = f.safeAddr, overrides: Record<string, any> = {}) {
    return f.manager.connect(f.operatorEOA).open(src.protocol, openParams(safeAddr, src.param(f), overrides));
}

export function close(f: Harness, src: SourceSpec, safeAddr = f.safeAddr, overrides: Record<string, any> = {}) {
    return f.manager
        .connect(f.operatorEOA)
        .close(src.protocol, closeParams(safeAddr, tokenIdOf(safeAddr), overrides));
}

export function withdraw(f: Harness, src: SourceSpec, safeAddr = f.safeAddr, overrides: Record<string, any> = {}) {
    return f.manager
        .connect(f.operatorEOA)
        .withdraw(src.protocol, withdrawParams(safeAddr, tokenIdOf(safeAddr), overrides));
}

export function roll(f: Harness, src: SourceSpec, safeAddr = f.safeAddr) {
    return f.manager
        .connect(f.operatorEOA)
        .switchPosition(src.protocol, src.protocol, switchParams(safeAddr, tokenIdOf(safeAddr), src.param(f)));
}

export async function sharesOf(f: Harness, src: SourceSpec, safeAddr = f.safeAddr) {
    return slotValue(f.managerAddr, await src.handler(f).savingsSharesSlot(tokenIdOf(safeAddr)));
}

export async function totalShares(f: Harness, src: SourceSpec) {
    return slotValue(f.managerAddr, await src.handler(f).savingsTotalSharesSlot());
}

export async function expectZeroResidue(f: Harness) {
    expect(await f.usdc.balanceOf(f.managerAddr)).to.equal(0);
    expect(await f.susds.balanceOf(f.managerAddr)).to.equal(0);
    expect(await f.mockShare.balanceOf(f.managerAddr)).to.equal(0);
}
