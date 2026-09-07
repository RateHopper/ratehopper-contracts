import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { YieldProtocol, encodeAerodromePoolParam, encodeUniV3PoolParam } from "../../contractAddresses";
import { ZERO_LEG, leg } from "../helpers/utils";

// ─────────────────────────────────────────────────────────────────────────
//  Mock-driven suite for SafeYieldManager + UniV3YieldHandler /
//  AerodromeYieldHandler (AP-4817 adapter pattern).
//
//  Reuses the mocks from RatehopperMocks.sol / RatehopperAerodromeMocks.sol
//  so both protocols' openLp / closeLp / collectLp lifecycles run through the
//  SINGLE manager module deterministically, plus manager-specific behavior:
//  handler dispatch, per-protocol basis namespacing, delegatecall-only
//  handlers, pause / per-protocol disable, and the timelocked setter surface.
// ─────────────────────────────────────────────────────────────────────────

const abi = ethers.AbiCoder.defaultAbiCoder();
const ZERO = "0x0000000000000000000000000000000000000000";
const DEADLINE = ethers.MaxUint256;
const SLIP = 100; // 1%
const PERF_FEE_BPS = 1000n; // 10%
const COLLECT_FEE_BPS = 250n; // 2.5%
const MAX_FEE_BPS = 2000;
const Q96 = 1n << 96n;

const UNISWAP_V3 = YieldProtocol.UNISWAP_V3;
const AERODROME = YieldProtocol.AERODROME;

// Pool params carry the pair: abi.encode(token0, token1, feeTier | tickSpacing).
// Assigned in deployYieldManagerHarness once the mock token addresses exist;
// loadFixture snapshots make the addresses stable across tests.
let FEE_TIER: string;
let BAD_FEE_TIER: string;
let TICK_SPACING: string;

const USDC_AMOUNT = 1_000_000n;
const HALF = USDC_AMOUNT / 2n;
const WETH_OUT = 2_000_000n; // WETH produced by the openLp swap
const TWAP_WINDOW = 1800;
const TWAP_CARDINALITY = 60;

function timelockCall(timelock: any, manager: any, functionName: string, args: any[]) {
    return timelock.execute(manager.target, manager.interface.encodeFunctionData(functionName, args));
}

function openParams(safeAddr: string, poolParam: string, overrides: Record<string, any> = {}) {
    return {
        onBehalfOf: safeAddr,
        usdcAmount: USDC_AMOUNT,
        tickLower: -100,
        tickUpper: 100,
        mintAmount0Min: 0,
        mintAmount1Min: 0,
        swap0: leg(WETH_OUT, poolParam),
        swap1: ZERO_LEG,
        slippageBps: SLIP,
        deadline: DEADLINE,
        lpPoolParam: poolParam,
        stake: false,
        ...overrides,
    };
}

function closeParams(
    safeAddr: string,
    tokenId: bigint | number,
    poolParam: string,
    overrides: Record<string, any> = {},
) {
    return {
        onBehalfOf: safeAddr,
        tokenId,
        exitBps: 10_000,
        swap0: leg(600_000n, poolParam),
        swap1: ZERO_LEG,
        slippageBps: SLIP,
        decreaseAmount0Min: 0,
        decreaseAmount1Min: 0,
        deadline: DEADLINE,
        minUsdcOut: 0,
        ...overrides,
    };
}

function collectParams(
    safeAddr: string,
    tokenId: bigint | number,
    poolParam: string,
    overrides: Record<string, any> = {},
) {
    return {
        onBehalfOf: safeAddr,
        tokenId,
        swapFeesToUsdc: false,
        swap0: leg(1, poolParam),
        swap1: ZERO_LEG,
        swapRewardToUsdc: false,
        rewardSwap: ZERO_LEG,
        slippageBps: SLIP,
        deadline: DEADLINE,
        ...overrides,
    };
}

// Deploy a MockStakePool for `clNpm` and register it on the voter as `clPool`'s
// stakePool — the shared preamble of every stakePool-staking test.
async function deployStakePool(clNpm, clPool, voter) {
    const StakePool = await ethers.getContractFactory("MockStakePool");
    const stakePool = await StakePool.deploy(await clNpm.getAddress());
    await stakePool.waitForDeployment();
    const stakePoolAddr = await stakePool.getAddress();
    await (await voter.setStakePool(await clPool.getAddress(), stakePoolAddr)).wait();
    return { stakePool, stakePoolAddr };
}

async function deployYieldManagerHarness() {
    const [deployer, operatorEOA, treasury, stranger, pauser] = await ethers.getSigners();

    const ERC = await ethers.getContractFactory("MockERC20");
    const tokenA = await ERC.deploy("Token A", "TKA", 18);
    const tokenB = await ERC.deploy("Token B", "TKB", 6);
    await tokenA.waitForDeployment();
    await tokenB.waitForDeployment();
    const addrA = (await tokenA.getAddress()).toLowerCase();
    const addrB = (await tokenB.getAddress()).toLowerCase();
    const [weth, usdc] = addrA < addrB ? [tokenA, tokenB] : [tokenB, tokenA];
    const wethAddr = await weth.getAddress();
    const usdcAddr = await usdc.getAddress();

    FEE_TIER = encodeUniV3PoolParam(wethAddr, usdcAddr, 500);
    BAD_FEE_TIER = encodeUniV3PoolParam(wethAddr, usdcAddr, 10000);
    TICK_SPACING = encodeAerodromePoolParam(wethAddr, usdcAddr, 100);

    // Uniswap V3 side
    const UniPool = await ethers.getContractFactory("MockUniswapV3Pool");
    const uniPool = await UniPool.deploy(wethAddr, usdcAddr, Q96, 10n ** 18n);
    await uniPool.waitForDeployment();
    const UniFactory = await ethers.getContractFactory("MockUniswapV3Factory");
    const uniFactory = await UniFactory.deploy();
    await uniFactory.waitForDeployment();
    const uniPoolAddr = await uniPool.getAddress();
    await (await uniFactory.setPool(uniPoolAddr)).wait();
    const UniNPM = await ethers.getContractFactory("MockNonfungiblePositionManager");
    const uniNpm = await UniNPM.deploy();
    await uniNpm.waitForDeployment();
    const UniRouter = await ethers.getContractFactory("MockSwapRouter");
    const uniRouter = await UniRouter.deploy();
    await uniRouter.waitForDeployment();

    // Aerodrome side
    const CLPool = await ethers.getContractFactory("MockCLPool");
    const clPool = await CLPool.deploy(wethAddr, usdcAddr, Q96, 10n ** 18n);
    await clPool.waitForDeployment();
    const CLFactory = await ethers.getContractFactory("MockCLFactory");
    const clFactory = await CLFactory.deploy();
    await clFactory.waitForDeployment();
    await (await clFactory.setPool(await clPool.getAddress())).wait();
    const CLNPM = await ethers.getContractFactory("MockCLNonfungiblePositionManager");
    const clNpm = await CLNPM.deploy();
    await clNpm.waitForDeployment();
    const CLRouter = await ethers.getContractFactory("MockSlipstreamSwapRouter");
    const clRouter = await CLRouter.deploy();
    await clRouter.waitForDeployment();
    const Voter = await ethers.getContractFactory("MockVoter");
    const voter = await Voter.deploy();
    await voter.waitForDeployment();

    const Safe = await ethers.getContractFactory("MockSafeHarness");
    const safe = await Safe.deploy();
    await safe.waitForDeployment();
    const safeAddr = await safe.getAddress();

    const Reg = await ethers.getContractFactory("MockRegistry");
    const reg = await Reg.deploy();
    await reg.waitForDeployment();
    await (await reg.setOperator(operatorEOA.address)).wait();
    await (await reg.setWhitelisted(wethAddr, true)).wait();
    await (await reg.setWhitelisted(usdcAddr, true)).wait();

    const UniHandler = await ethers.getContractFactory("UniV3YieldHandler");
    const uniHandler = await UniHandler.deploy(
        await uniNpm.getAddress(),
        usdcAddr,
        await uniRouter.getAddress(),
        await uniFactory.getAddress(),
    );
    await uniHandler.waitForDeployment();

    const AeroHandler = await ethers.getContractFactory("AerodromeYieldHandler");
    const aeroHandler = await AeroHandler.deploy(
        await clNpm.getAddress(),
        usdcAddr,
        await clRouter.getAddress(),
        await clFactory.getAddress(),
        await voter.getAddress(),
    );
    await aeroHandler.waitForDeployment();

    const Timelock = await ethers.getContractFactory("MockTimelockController");
    const timelock = await Timelock.deploy(1);
    await timelock.waitForDeployment();

    const Manager = await ethers.getContractFactory("SafeYieldManager");
    const manager = await Manager.deploy(
        await reg.getAddress(),
        usdcAddr,
        wethAddr,
        [UNISWAP_V3, AERODROME],
        [await uniHandler.getAddress(), await aeroHandler.getAddress()],
        [[FEE_TIER], [TICK_SPACING]],
        [0, 0],
        [0, 0],
        // Seeded at construction: the allow-listed params above are held to the
        // same reference requirement as any later addition.
        [{ token: wethAddr, config: { pool: uniPoolAddr, window: TWAP_WINDOW, minCardinality: TWAP_CARDINALITY } }],
        treasury.address,
        Number(PERF_FEE_BPS),
        Number(COLLECT_FEE_BPS),
        MAX_FEE_BPS,
        deployer.address, // initialAdmin
        await timelock.getAddress(), // timelock
        pauser.address,
    );
    await manager.waitForDeployment();

    await (await usdc.mint(safeAddr, 10n ** 12n)).wait();
    for (const target of [uniRouter, clRouter, uniNpm, clNpm]) {
        await (await weth.mint(await target.getAddress(), 10n ** 24n)).wait();
        await (await usdc.mint(await target.getAddress(), 10n ** 18n)).wait();
    }
    await (await uniRouter.setOutput(WETH_OUT)).wait();
    await (await clRouter.setOutput(WETH_OUT)).wait();

    return {
        deployer,
        operatorEOA,
        treasury,
        stranger,
        pauser,
        timelock,
        weth,
        usdc,
        wethAddr,
        usdcAddr,
        uniPool,
        uniPoolAddr,
        uniFactory,
        uniNpm,
        uniRouter,
        clPool,
        clFactory,
        clNpm,
        clRouter,
        voter,
        safe,
        safeAddr,
        reg,
        uniHandler,
        aeroHandler,
        manager,
    };
}

describe("SafeYieldManager", function () {
    describe("deployment", function () {
        it("registers handlers, enables protocols, and stores config", async function () {
            const { manager, uniHandler, aeroHandler, treasury } = await loadFixture(deployYieldManagerHarness);

            expect(await manager.yieldHandlers(UNISWAP_V3)).to.equal(await uniHandler.getAddress());
            expect(await manager.yieldHandlers(AERODROME)).to.equal(await aeroHandler.getAddress());
            expect(await manager.protocolEnabledForOpen(UNISWAP_V3)).to.equal(true);
            expect(await manager.protocolEnabledForOpen(AERODROME)).to.equal(true);
            expect(await manager.protocolEnabledForClose(UNISWAP_V3)).to.equal(true);
            expect(await manager.protocolEnabledForClose(AERODROME)).to.equal(true);
            expect(await manager.treasury()).to.equal(treasury.address);
            expect(await manager.performanceFeeBps()).to.equal(PERF_FEE_BPS);
            expect(await manager.feeCollectBps()).to.equal(COLLECT_FEE_BPS);
            expect(await manager.maxSlippageBps()).to.equal(300);
            expect(await manager.isPoolParamAllowed(UNISWAP_V3, FEE_TIER)).to.equal(true);
            expect(await manager.isPoolParamAllowed(UNISWAP_V3, BAD_FEE_TIER)).to.equal(false);
            expect(await manager.isPoolParamAllowed(AERODROME, TICK_SPACING)).to.equal(true);
        });

        it("reverts on constructor array length mismatch", async function () {
            const { manager, reg, usdcAddr, wethAddr, uniHandler, treasury, deployer, pauser, timelock, uniPoolAddr } =
                await loadFixture(deployYieldManagerHarness);
            const Manager = await ethers.getContractFactory("SafeYieldManager");
            await expect(
                Manager.deploy(
                    await reg.getAddress(),
                    usdcAddr,
                    wethAddr,
                    [UNISWAP_V3, AERODROME],
                    [await uniHandler.getAddress()],
                    [[FEE_TIER], [TICK_SPACING]],
                    [0, 0],
                    [0, 0],
                    [
                        {
                            token: wethAddr,
                            config: { pool: uniPoolAddr, window: TWAP_WINDOW, minCardinality: TWAP_CARDINALITY },
                        },
                    ],
                    treasury.address,
                    Number(PERF_FEE_BPS),
                    Number(COLLECT_FEE_BPS),
                    MAX_FEE_BPS,
                    deployer.address,
                    await timelock.getAddress(),
                    pauser.address,
                ),
            ).to.be.revertedWithCustomError(manager, "LengthMismatch");
        });

        it("rejects mismatched and non-contract handlers in the constructor", async function () {
            const {
                manager,
                reg,
                usdcAddr,
                wethAddr,
                uniHandler,
                treasury,
                deployer,
                pauser,
                stranger,
                timelock,
                uniPoolAddr,
            } = await loadFixture(deployYieldManagerHarness);
            const Manager = await ethers.getContractFactory("SafeYieldManager");
            const registryAddress = await reg.getAddress();
            const timelockAddress = await timelock.getAddress();
            const deployWithHandler = (handler: string) =>
                Manager.deploy(
                    registryAddress,
                    usdcAddr,
                    wethAddr,
                    [AERODROME],
                    [handler],
                    [[TICK_SPACING]],
                    [0],
                    [0],
                    [
                        {
                            token: wethAddr,
                            config: { pool: uniPoolAddr, window: TWAP_WINDOW, minCardinality: TWAP_CARDINALITY },
                        },
                    ],
                    treasury.address,
                    Number(PERF_FEE_BPS),
                    Number(COLLECT_FEE_BPS),
                    MAX_FEE_BPS,
                    deployer.address,
                    timelockAddress,
                    pauser.address,
                );

            await expect(deployWithHandler(await uniHandler.getAddress()))
                .to.be.revertedWithCustomError(manager, "HandlerProtocolMismatch")
                .withArgs(AERODROME, UNISWAP_V3);
            await expect(deployWithHandler(stranger.address)).to.be.revertedWithCustomError(manager, "InvalidHandler");
        });
    });

    describe("openLp", function () {
        it("opens a Uniswap V3 position through the manager module", async function () {
            const { manager, operatorEOA, safeAddr, uniNpm } = await loadFixture(deployYieldManagerHarness);

            await expect(manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER)))
                .to.emit(manager, "PositionOpened")
                .withArgs(safeAddr, UNISWAP_V3, 1n, USDC_AMOUNT, WETH_OUT, HALF, USDC_AMOUNT);

            expect(await manager.residualBasisUsd6Of(UNISWAP_V3, 1)).to.equal(USDC_AMOUNT);
            expect(await manager.positionHandlerOf(UNISWAP_V3, 1)).to.equal(await manager.yieldHandlers(UNISWAP_V3));
            expect(await uniNpm.ownerOf(1)).to.equal(safeAddr);
        });

        it("opens an Aerodrome position with a separate basis namespace", async function () {
            const { manager, operatorEOA, safeAddr, clNpm } = await loadFixture(deployYieldManagerHarness);

            await expect(manager.connect(operatorEOA).openLp(AERODROME, openParams(safeAddr, TICK_SPACING)))
                .to.emit(manager, "PositionOpened")
                .withArgs(safeAddr, AERODROME, 1n, USDC_AMOUNT, WETH_OUT, HALF, USDC_AMOUNT);

            expect(await manager.residualBasisUsd6Of(AERODROME, 1)).to.equal(USDC_AMOUNT);
            expect(await manager.residualBasisUsd6Of(UNISWAP_V3, 1)).to.equal(0);
            expect(await clNpm.ownerOf(1)).to.equal(safeAddr);
        });

        it("allows the Safe itself to call", async function () {
            const { manager, safeAddr } = await loadFixture(deployYieldManagerHarness);
            const safeSigner = await ethers.getImpersonatedSigner(safeAddr);
            await ethers.provider.send("hardhat_setBalance", [safeAddr, "0x1000000000000000000"]);

            await expect(manager.connect(safeSigner).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).to.emit(
                manager,
                "PositionOpened",
            );
        });

        it("reverts for unauthorized callers", async function () {
            const { manager, stranger, safeAddr } = await loadFixture(deployYieldManagerHarness);
            await expect(
                manager.connect(stranger).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER)),
            ).to.be.revertedWithCustomError(manager, "NotAuthorized");
        });

        it("reverts on zero onBehalfOf, zero usdcAmount, and expired deadline", async function () {
            const { manager, operatorEOA, safeAddr } = await loadFixture(deployYieldManagerHarness);
            await expect(
                manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(ZERO, FEE_TIER)),
            ).to.be.revertedWithCustomError(manager, "ZeroAddress");
            await expect(
                manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER, { usdcAmount: 0 })),
            ).to.be.revertedWithCustomError(manager, "InvalidUsdcAmount");
            await expect(
                manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER, { deadline: 1 })),
            ).to.be.revertedWithCustomError(manager, "DeadlineExpired");
        });

        it("reverts TokenNotWhitelisted when a pool token leaves the registry whitelist", async function () {
            const { manager, operatorEOA, safeAddr, reg, wethAddr, usdcAddr } =
                await loadFixture(deployYieldManagerHarness);

            await (await reg.setWhitelisted(wethAddr, false)).wait();
            await expect(manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER)))
                .to.be.revertedWithCustomError(manager, "TokenNotWhitelisted")
                .withArgs(wethAddr);

            await (await reg.setWhitelisted(wethAddr, true)).wait();
            await (await reg.setWhitelisted(usdcAddr, false)).wait();
            await expect(manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER)))
                .to.be.revertedWithCustomError(manager, "TokenNotWhitelisted")
                .withArgs(usdcAddr);

            await (await reg.setWhitelisted(usdcAddr, true)).wait();
            await expect(manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).to.emit(
                manager,
                "PositionOpened",
            );
        });

        it("enforces the pool param allow-list and admin toggling", async function () {
            const { manager, operatorEOA, deployer, safeAddr } = await loadFixture(deployYieldManagerHarness);
            await expect(
                manager
                    .connect(operatorEOA)
                    .openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER, { lpPoolParam: BAD_FEE_TIER })),
            ).to.be.revertedWithCustomError(manager, "PoolParamNotAllowed");

            await expect(manager.connect(deployer).setPoolParamAllowed(UNISWAP_V3, BAD_FEE_TIER, true))
                .to.emit(manager, "PoolParamAllowedUpdated")
                .withArgs(UNISWAP_V3, BAD_FEE_TIER, false, true);

            await expect(
                manager
                    .connect(operatorEOA)
                    .openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER, { lpPoolParam: BAD_FEE_TIER })),
            ).to.emit(manager, "PositionOpened");
        });

        it("binds slippageBps to the quoter-derived swap minimum", async function () {
            const { manager, operatorEOA, safeAddr } = await loadFixture(deployYieldManagerHarness);
            await expect(
                manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER, { slippageBps: 0 })),
            ).to.be.revertedWithCustomError(manager, "SlippageTooLow");
            await expect(
                manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER, { slippageBps: 301 })),
            ).to.be.revertedWithCustomError(manager, "SlippageAboveMax");
        });

        // The floor a caller cannot lower. The reference pool sits at tick 0,
        // so the TWAP values half the 1 USDC deposit (500_000) at 500_000 wei;
        // at SLIP = 1% the router must be handed at least 495_000 no matter
        // what the caller asked for.
        const HALF_USDC = USDC_AMOUNT / 2n;
        const TWAP_FLOOR = (HALF_USDC * (10_000n - BigInt(SLIP))) / 10_000n;

        it("raises a caller's swap minimum to the reference TWAP floor", async function () {
            const { manager, operatorEOA, safeAddr, uniRouter } = await loadFixture(deployYieldManagerHarness);
            // The old contract accepted this by checking the caller's minimum
            // against the caller's own expectation; 1 and 1 satisfied it.
            await (
                await manager.connect(operatorEOA).openLp(
                    UNISWAP_V3,
                    openParams(safeAddr, FEE_TIER, {
                        swap0: leg(1, FEE_TIER),
                    }),
                )
            ).wait();
            expect(await uniRouter.lastAmountIn()).to.equal(HALF_USDC);
            expect(await uniRouter.lastAmountOutMinimum()).to.equal(TWAP_FLOOR);
        });

        it("accepts a zero minimum for a swap whose size is unknown up front", async function () {
            const { manager, operatorEOA, safeAddr, uniRouter } = await loadFixture(deployYieldManagerHarness);
            await (
                await manager.connect(operatorEOA).openLp(
                    UNISWAP_V3,
                    openParams(safeAddr, FEE_TIER, {
                        swap0: leg(0, FEE_TIER),
                    }),
                )
            ).wait();
            expect(await uniRouter.lastAmountOutMinimum()).to.equal(TWAP_FLOOR);
        });

        it("keeps a caller minimum that is tighter than the floor", async function () {
            const { manager, operatorEOA, safeAddr, uniRouter } = await loadFixture(deployYieldManagerHarness);
            const tighter = TWAP_FLOOR * 2n;
            await (
                await manager.connect(operatorEOA).openLp(
                    UNISWAP_V3,
                    openParams(safeAddr, FEE_TIER, {
                        swap0: leg(tighter, FEE_TIER),
                    }),
                )
            ).wait();
            expect(await uniRouter.lastAmountOutMinimum()).to.equal(tighter);
        });

        it("reverts one unit below the effective floor and succeeds exactly at it", async function () {
            const { manager, operatorEOA, safeAddr, uniRouter } = await loadFixture(deployYieldManagerHarness);
            await (await uniRouter.setEnforceMinOut(true)).wait();
            await (await uniRouter.setOutput(TWAP_FLOOR - 1n)).wait();

            await expect(
                manager
                    .connect(operatorEOA)
                    .openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER, { swap0: leg(1, FEE_TIER) })),
            ).to.be.revertedWith("router: too little received");

            await (await uniRouter.setOutput(TWAP_FLOOR)).wait();
            await expect(
                manager
                    .connect(operatorEOA)
                    .openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER, { swap0: leg(1, FEE_TIER) })),
            ).to.emit(manager, "PositionOpened");
            expect(await uniRouter.lastAmountOutMinimum()).to.equal(TWAP_FLOOR);
        });

        it("enforces the same router boundary through the Aerodrome handler", async function () {
            const { manager, operatorEOA, safeAddr, clRouter } = await loadFixture(deployYieldManagerHarness);
            await (await clRouter.setEnforceMinOut(true)).wait();
            await (await clRouter.setOutput(TWAP_FLOOR - 1n)).wait();

            await expect(
                manager
                    .connect(operatorEOA)
                    .openLp(AERODROME, openParams(safeAddr, TICK_SPACING, { swap0: leg(1, TICK_SPACING) })),
            ).to.be.revertedWith("router: too little received");

            await (await clRouter.setOutput(TWAP_FLOOR)).wait();
            await expect(
                manager
                    .connect(operatorEOA)
                    .openLp(AERODROME, openParams(safeAddr, TICK_SPACING, { swap0: leg(1, TICK_SPACING) })),
            ).to.emit(manager, "PositionOpened");
        });

        it("scales the floor with slippageBps", async function () {
            const { manager, operatorEOA, safeAddr, uniRouter } = await loadFixture(deployYieldManagerHarness);
            await (
                await manager.connect(operatorEOA).openLp(
                    UNISWAP_V3,
                    openParams(safeAddr, FEE_TIER, {
                        swap0: leg(0, FEE_TIER),
                        slippageBps: 300,
                    }),
                )
            ).wait();
            expect(await uniRouter.lastAmountOutMinimum()).to.equal((HALF_USDC * 9_700n) / 10_000n);
        });

        it("refuses to swap a token with no price reference", async function () {
            const { manager, operatorEOA, safeAddr, uniPool } = await loadFixture(deployYieldManagerHarness);
            await (await uniPool.setObserveReverts(true)).wait();
            await expect(
                manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER)),
            ).to.be.revertedWith("OLD");
        });

        it("reverts SwapFailed when the swap produces no WETH", async function () {
            const { manager, operatorEOA, safeAddr, uniRouter } = await loadFixture(deployYieldManagerHarness);
            await (await uniRouter.setOutput(0)).wait();
            await expect(
                manager
                    .connect(operatorEOA)
                    .openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER, { swap0: leg(1, FEE_TIER) })),
            ).to.be.revertedWithCustomError(manager, "SwapFailed");
        });

        it("enforces the minted-liquidity floor per protocol", async function () {
            const { manager, operatorEOA, deployer, safeAddr } = await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(deployer).setMinPositionLiquidity(UNISWAP_V3, 10_000_000)).wait();
            await expect(
                manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER)),
            ).to.be.revertedWithCustomError(manager, "PositionLiquidityTooLow");
        });
    });

    describe("closeLp", function () {
        it("fully closes a Uniswap V3 position and charges the performance fee on profit", async function () {
            const { manager, operatorEOA, safeAddr, treasury, usdc, uniNpm, uniRouter } =
                await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            await (await uniRouter.setOutput(600_000n)).wait();

            const treasuryBefore = await usdc.balanceOf(treasury.address);
            await expect(manager.connect(operatorEOA).closeLp(UNISWAP_V3, closeParams(safeAddr, 1, FEE_TIER)))
                .to.emit(manager, "PositionClosed")
                .withArgs(safeAddr, UNISWAP_V3, 1n, USDC_AMOUNT, 1_100_000n, 10_000n, 10_000, 0n);

            expect((await usdc.balanceOf(treasury.address)) - treasuryBefore).to.equal(10_000n);
            expect(await manager.residualBasisUsd6Of(UNISWAP_V3, 1)).to.equal(0);
            expect(await manager.positionHandlerOf(UNISWAP_V3, 1)).to.equal(ZERO);
            expect(await uniNpm.ownerOf(1)).to.equal(ZERO);
        });

        it("closes through the handler pinned at open even after setYieldHandler", async function () {
            const {
                manager,
                operatorEOA,
                deployer,
                timelock,
                safeAddr,
                usdcAddr,
                wethAddr,
                uniNpm,
                uniRouter,
                uniFactory,
            } = await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            const pinnedHandler = await manager.positionHandlerOf(UNISWAP_V3, 1);

            const NPM2 = await ethers.getContractFactory("MockNonfungiblePositionManager");
            const uniNpm2 = await NPM2.deploy();
            await uniNpm2.waitForDeployment();
            const UniHandler = await ethers.getContractFactory("UniV3YieldHandler");
            const newHandler = await UniHandler.deploy(
                await uniNpm2.getAddress(),
                usdcAddr,
                await uniRouter.getAddress(),
                await uniFactory.getAddress(),
            );
            await newHandler.waitForDeployment();
            await (
                await timelockCall(timelock, manager, "setYieldHandler", [UNISWAP_V3, await newHandler.getAddress()])
            ).wait();

            expect(await manager.positionHandlerOf(UNISWAP_V3, 1)).to.equal(pinnedHandler);
            await (await uniRouter.setOutput(600_000n)).wait();
            await expect(manager.connect(operatorEOA).closeLp(UNISWAP_V3, closeParams(safeAddr, 1, FEE_TIER))).to.emit(
                manager,
                "PositionClosed",
            );
            expect(await uniNpm.ownerOf(1)).to.equal(ZERO);
        });

        it("fully closes an Aerodrome position", async function () {
            const { manager, operatorEOA, safeAddr, clNpm, clRouter } = await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(AERODROME, openParams(safeAddr, TICK_SPACING))).wait();
            await (await clRouter.setOutput(600_000n)).wait();

            await expect(manager.connect(operatorEOA).closeLp(AERODROME, closeParams(safeAddr, 1, TICK_SPACING)))
                .to.emit(manager, "PositionClosed")
                .withArgs(safeAddr, AERODROME, 1n, USDC_AMOUNT, 1_100_000n, 10_000n, 10_000, 0n);

            expect(await manager.residualBasisUsd6Of(AERODROME, 1)).to.equal(0);
            expect(await clNpm.ownerOf(1)).to.equal(ZERO);
        });

        it("partially closes and prorates the residual basis", async function () {
            const { manager, operatorEOA, safeAddr, uniNpm, uniRouter } = await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            await (await uniRouter.setOutput(300_000n)).wait();

            await expect(
                manager.connect(operatorEOA).closeLp(
                    UNISWAP_V3,
                    closeParams(safeAddr, 1, FEE_TIER, {
                        exitBps: 5_000,
                        swap0: leg(300_000n, FEE_TIER),
                    }),
                ),
            )
                .to.emit(manager, "PositionClosed")
                .withArgs(safeAddr, UNISWAP_V3, 1n, HALF, 550_000n, 5_000n, 5_000, 0n);

            expect(await manager.residualBasisUsd6Of(UNISWAP_V3, 1)).to.equal(HALF);
            expect(await uniNpm.ownerOf(1)).to.equal(safeAddr);
        });

        it("rejects positions opened on a different protocol (namespace isolation)", async function () {
            const { manager, operatorEOA, safeAddr } = await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();

            await expect(
                manager.connect(operatorEOA).closeLp(AERODROME, closeParams(safeAddr, 1, TICK_SPACING)),
            ).to.be.revertedWithCustomError(manager, "UnknownPosition");
        });

        it("reverts on invalid exitBps and unknown tokenIds", async function () {
            const { manager, operatorEOA, safeAddr } = await loadFixture(deployYieldManagerHarness);
            await expect(
                manager.connect(operatorEOA).closeLp(UNISWAP_V3, closeParams(safeAddr, 99, FEE_TIER)),
            ).to.be.revertedWithCustomError(manager, "UnknownPosition");
            await expect(
                manager.connect(operatorEOA).closeLp(UNISWAP_V3, closeParams(safeAddr, 1, FEE_TIER, { exitBps: 0 })),
            ).to.be.revertedWithCustomError(manager, "InvalidExitBps");
            await expect(
                manager
                    .connect(operatorEOA)
                    .closeLp(UNISWAP_V3, closeParams(safeAddr, 1, FEE_TIER, { exitBps: 10_001 })),
            ).to.be.revertedWithCustomError(manager, "InvalidExitBps");
        });

        it("enforces the caller's minUsdcOut floor", async function () {
            const { manager, operatorEOA, safeAddr, uniRouter } = await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            await (await uniRouter.setOutput(600_000n)).wait();

            await expect(
                manager
                    .connect(operatorEOA)
                    .closeLp(UNISWAP_V3, closeParams(safeAddr, 1, FEE_TIER, { minUsdcOut: 2_000_000n })),
            ).to.be.revertedWithCustomError(manager, "MinUsdcOutNotMet");
        });

        it("waives the performance fee when the transfer returns false without reverting", async function () {
            const { manager, operatorEOA, safeAddr, treasury, usdc, uniRouter } =
                await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            await (await uniRouter.setOutput(600_000n)).wait();
            await (await usdc.setFalseTransferTo(treasury.address)).wait();

            const tx = manager.connect(operatorEOA).closeLp(UNISWAP_V3, closeParams(safeAddr, 1, FEE_TIER));
            await expect(tx).to.emit(manager, "FeeTransferFailed").withArgs(safeAddr, 1n, 10_000n);
            await expect(tx)
                .to.emit(manager, "PositionClosed")
                .withArgs(safeAddr, UNISWAP_V3, 1n, USDC_AMOUNT, 1_100_000n, 0n, 10_000, 0n);
            expect(await usdc.balanceOf(treasury.address)).to.equal(0);
        });

        it("waives the performance fee when the treasury transfer fails", async function () {
            const { manager, operatorEOA, safeAddr, treasury, usdc, uniRouter } =
                await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            await (await uniRouter.setOutput(600_000n)).wait();
            await (await usdc.setRevertTransferTo(treasury.address)).wait();

            await expect(manager.connect(operatorEOA).closeLp(UNISWAP_V3, closeParams(safeAddr, 1, FEE_TIER)))
                .to.emit(manager, "FeeTransferFailed")
                .withArgs(safeAddr, 1n, 10_000n);
            expect(await usdc.balanceOf(treasury.address)).to.equal(0);
        });

        it("M-1: keeps the USDC exit working after the swap leg's pool param is de-listed", async function () {
            const { manager, operatorEOA, deployer, safeAddr, uniNpm, uniRouter } =
                await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            await (await manager.connect(deployer).setPoolParamAllowed(UNISWAP_V3, BAD_FEE_TIER, true)).wait();
            await (await manager.connect(deployer).setPoolParamAllowed(UNISWAP_V3, FEE_TIER, false)).wait();
            expect(await manager.isPoolParamAllowed(UNISWAP_V3, FEE_TIER)).to.equal(false);

            await expect(
                manager
                    .connect(operatorEOA)
                    .openLp(UNISWAP_V3, openParams(safeAddr, BAD_FEE_TIER, { swap0: leg(WETH_OUT, FEE_TIER) })),
            ).to.be.revertedWithCustomError(manager, "PoolParamNotAllowed");

            await (await uniNpm.setOwed(1, 100_000n, 0)).wait();
            await expect(
                manager
                    .connect(operatorEOA)
                    .collectLp(
                        UNISWAP_V3,
                        collectParams(safeAddr, 1, FEE_TIER, { swapFeesToUsdc: true, swap0: leg(0, FEE_TIER) }),
                    ),
            ).to.emit(manager, "FeesCollected");
            await (await uniRouter.setOutput(600_000n)).wait();
            await expect(manager.connect(operatorEOA).closeLp(UNISWAP_V3, closeParams(safeAddr, 1, FEE_TIER))).to.emit(
                manager,
                "PositionClosed",
            );
        });
    });

    describe("collectLp", function () {
        it("harvests fees, skims feeCollectBps, and forwards the rest to the Safe", async function () {
            const { manager, operatorEOA, safeAddr, treasury, weth, usdc, uniNpm } =
                await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            await (await uniNpm.setOwed(1, 100_000n, 40_000n)).wait();

            const safeWethBefore = await weth.balanceOf(safeAddr);
            const safeUsdcBefore = await usdc.balanceOf(safeAddr);

            await expect(manager.connect(operatorEOA).collectLp(UNISWAP_V3, collectParams(safeAddr, 1, FEE_TIER)))
                .to.emit(manager, "FeesCollected")
                .withArgs(
                    safeAddr,
                    UNISWAP_V3,
                    1n,
                    await weth.getAddress(),
                    100_000n,
                    2_500n,
                    await usdc.getAddress(),
                    40_000n,
                    1_000n,
                );

            expect(await weth.balanceOf(treasury.address)).to.equal(2_500n);
            expect(await usdc.balanceOf(treasury.address)).to.equal(1_000n);
            expect((await weth.balanceOf(safeAddr)) - safeWethBefore).to.equal(97_500n);
            expect((await usdc.balanceOf(safeAddr)) - safeUsdcBefore).to.equal(39_000n);
        });

        it("optionally swaps the WETH remainder to USDC", async function () {
            const { manager, operatorEOA, safeAddr, weth, uniNpm, uniRouter } =
                await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            await (await uniNpm.setOwed(1, 100_000n, 0)).wait();
            await (await uniRouter.setOutput(95_000n)).wait();

            const safeWethBefore = await weth.balanceOf(safeAddr);
            await (
                await manager.connect(operatorEOA).collectLp(
                    UNISWAP_V3,
                    collectParams(safeAddr, 1, FEE_TIER, {
                        swapFeesToUsdc: true,
                        swap0: leg(95_000n, FEE_TIER),
                    }),
                )
            ).wait();

            expect(await weth.balanceOf(safeAddr)).to.equal(safeWethBefore);
        });

        // M-01: the collect fee swap is exactly the call that used to ship with
        // `amountOutMin: 1`, because the amount collected is unknowable until
        // the collect runs. It is now floored on the amount actually harvested.
        it("floors the fee swap even though the collected amount is unknown up front", async function () {
            const { manager, operatorEOA, safeAddr, uniNpm, uniRouter } = await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            const owed0 = 100_000n;
            await (await uniNpm.setOwed(1, owed0, 0)).wait();
            await (await uniRouter.setOutput(95_000n)).wait();

            await (
                await manager.connect(operatorEOA).collectLp(
                    UNISWAP_V3,
                    collectParams(safeAddr, 1, FEE_TIER, {
                        swapFeesToUsdc: true,
                        // The 1/1 sentinel the audit named. It no longer buys
                        // the caller a floor-free swap.
                        swap0: leg(1, FEE_TIER),
                    }),
                )
            ).wait();

            // feeCollectBps is skimmed first, so the swap sees the net harvest.
            const netHarvest = owed0 - (owed0 * COLLECT_FEE_BPS) / 10_000n;
            expect(await uniRouter.lastAmountIn()).to.equal(netHarvest);
            expect(await uniRouter.lastAmountOutMinimum()).to.equal((netHarvest * (10_000n - BigInt(SLIP))) / 10_000n);
        });

        it("leaves a dynamic fee delta in kind when its independent floor rounds to zero", async function () {
            const { manager, operatorEOA, safeAddr, weth, uniNpm, uniRouter } =
                await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            await (await uniNpm.setOwed(1, 1n, 0)).wait();
            const callsBefore = await uniRouter.callCount();
            const wethBefore = await weth.balanceOf(safeAddr);

            await expect(
                manager.connect(operatorEOA).collectLp(
                    UNISWAP_V3,
                    collectParams(safeAddr, 1, FEE_TIER, {
                        swapFeesToUsdc: true,
                        swap0: leg(0, FEE_TIER),
                    }),
                ),
            ).to.emit(manager, "FeesCollected");

            expect(await uniRouter.callCount()).to.equal(callsBefore);
            expect(await weth.balanceOf(safeAddr)).to.equal(wethBefore + 1n);
        });

        it("rejects tokenIds without a stored basis", async function () {
            const { manager, operatorEOA, safeAddr, uniNpm, wethAddr, usdcAddr } =
                await loadFixture(deployYieldManagerHarness);
            await (await uniNpm.seedPosition(7, safeAddr, wethAddr, usdcAddr, 500, 1_000_000n, 0, 0)).wait();

            await expect(
                manager.connect(operatorEOA).collectLp(UNISWAP_V3, collectParams(safeAddr, 7, FEE_TIER)),
            ).to.be.revertedWithCustomError(manager, "UnknownPosition");
        });
    });

    describe("pause and protocol switches", function () {
        it("pause blocks opens but keeps exits available (exit-only mode)", async function () {
            const { manager, operatorEOA, pauser, safeAddr, uniNpm, uniRouter } =
                await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            await (await uniNpm.setOwed(1, 0, 40_000n)).wait();

            await (await manager.connect(pauser).pause()).wait();
            await expect(
                manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER)),
            ).to.be.revertedWithCustomError(manager, "EnforcedPause");

            await expect(
                manager.connect(operatorEOA).collectLp(UNISWAP_V3, collectParams(safeAddr, 1, FEE_TIER)),
            ).to.emit(manager, "FeesCollected");
            await (await uniRouter.setOutput(600_000n)).wait();
            await expect(manager.connect(operatorEOA).closeLp(UNISWAP_V3, closeParams(safeAddr, 1, FEE_TIER))).to.emit(
                manager,
                "PositionClosed",
            );

            await (await manager.connect(pauser).unpause()).wait();
            await expect(manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).to.emit(
                manager,
                "PositionOpened",
            );
        });

        it("pauser can disable opens for a single protocol without affecting exits", async function () {
            const { manager, operatorEOA, pauser, safeAddr, uniRouter } = await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();

            await expect(manager.connect(pauser).setProtocolEnabledForOpen(UNISWAP_V3, false))
                .to.emit(manager, "ProtocolStatusChanged")
                .withArgs(UNISWAP_V3, true, false);

            await expect(
                manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER)),
            ).to.be.revertedWithCustomError(manager, "ProtocolDisabled");
            await expect(manager.connect(operatorEOA).openLp(AERODROME, openParams(safeAddr, TICK_SPACING))).to.emit(
                manager,
                "PositionOpened",
            );
            await (await uniRouter.setOutput(600_000n)).wait();
            await expect(manager.connect(operatorEOA).closeLp(UNISWAP_V3, closeParams(safeAddr, 1, FEE_TIER))).to.emit(
                manager,
                "PositionClosed",
            );
        });

        it("pauser can disable exits for a single protocol", async function () {
            const { manager, operatorEOA, pauser, safeAddr } = await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();

            await expect(manager.connect(pauser).setProtocolEnabledForClose(UNISWAP_V3, false))
                .to.emit(manager, "ProtocolStatusChanged")
                .withArgs(UNISWAP_V3, false, false);

            await expect(
                manager.connect(operatorEOA).closeLp(UNISWAP_V3, closeParams(safeAddr, 1, FEE_TIER)),
            ).to.be.revertedWithCustomError(manager, "ProtocolDisabled");
            await expect(
                manager.connect(operatorEOA).collectLp(UNISWAP_V3, collectParams(safeAddr, 1, FEE_TIER)),
            ).to.be.revertedWithCustomError(manager, "ProtocolDisabled");

            await (await manager.connect(pauser).setProtocolEnabledForClose(UNISWAP_V3, true)).wait();
            await expect(
                manager.connect(operatorEOA).collectLp(UNISWAP_V3, collectParams(safeAddr, 1, FEE_TIER)),
            ).to.emit(manager, "FeesCollected");
        });

        it("rejects pause and protocol toggles from non-pausers", async function () {
            const { manager, stranger } = await loadFixture(deployYieldManagerHarness);
            await expect(manager.connect(stranger).pause()).to.be.revertedWithCustomError(manager, "NotAuthorized");
            await expect(
                manager.connect(stranger).setProtocolEnabledForOpen(UNISWAP_V3, false),
            ).to.be.revertedWithCustomError(manager, "NotAuthorized");
            await expect(
                manager.connect(stranger).setProtocolEnabledForClose(UNISWAP_V3, false),
            ).to.be.revertedWithCustomError(manager, "NotAuthorized");
        });
    });

    describe("setters and access control", function () {
        it("timelock-gated setters reject non-timelock callers", async function () {
            const { manager, stranger, treasury } = await loadFixture(deployYieldManagerHarness);
            await expect(manager.connect(stranger).setTreasury(treasury.address)).to.be.revertedWithCustomError(
                manager,
                "OnlyTimelock",
            );
            await expect(manager.connect(stranger).setPerformanceFeeBps(0)).to.be.revertedWithCustomError(
                manager,
                "OnlyTimelock",
            );
            await expect(manager.connect(stranger).setFeeCollectBps(0)).to.be.revertedWithCustomError(
                manager,
                "OnlyTimelock",
            );
            await expect(
                manager.connect(stranger).setYieldHandler(UNISWAP_V3, treasury.address),
            ).to.be.revertedWithCustomError(manager, "OnlyTimelock");
        });

        it("timelock can rotate treasury, fees, and handlers", async function () {
            const { manager, deployer, timelock, stranger, uniHandler } = await loadFixture(deployYieldManagerHarness);
            await expect(timelockCall(timelock, manager, "setTreasury", [stranger.address])).to.emit(
                manager,
                "TreasuryUpdated",
            );
            expect(await manager.treasury()).to.equal(stranger.address);

            await expect(
                timelockCall(timelock, manager, "setPerformanceFeeBps", [MAX_FEE_BPS + 1]),
            ).to.be.revertedWithCustomError(manager, "FeeAboveMax");
            await (await timelockCall(timelock, manager, "setPerformanceFeeBps", [500])).wait();
            expect(await manager.performanceFeeBps()).to.equal(500);

            await expect(
                timelockCall(timelock, manager, "setYieldHandler", [UNISWAP_V3, ZERO]),
            ).to.be.revertedWithCustomError(manager, "InvalidHandler");
            await expect(timelockCall(timelock, manager, "setYieldHandler", [AERODROME, await uniHandler.getAddress()]))
                .to.be.revertedWithCustomError(manager, "HandlerProtocolMismatch")
                .withArgs(AERODROME, UNISWAP_V3);
            await expect(
                timelockCall(timelock, manager, "setYieldHandler", [UNISWAP_V3, stranger.address]),
            ).to.be.revertedWithCustomError(manager, "InvalidHandler");
        });

        it("rejects a handler contract without PROTOCOL()", async function () {
            const { manager, deployer, timelock, usdc } = await loadFixture(deployYieldManagerHarness);
            await expect(
                timelockCall(timelock, manager, "setYieldHandler", [UNISWAP_V3, await usdc.getAddress()]),
            ).to.be.revertedWithCustomError(manager, "InvalidHandler");
        });

        it("admin setters enforce role and bounds", async function () {
            const { manager, deployer, stranger } = await loadFixture(deployYieldManagerHarness);
            await expect(manager.connect(stranger).setMaxSlippageBps(500)).to.be.revertedWithCustomError(
                manager,
                "AccessControlUnauthorizedAccount",
            );
            await expect(manager.connect(deployer).setMaxSlippageBps(1001)).to.be.revertedWithCustomError(
                manager,
                "SlippageAboveMax",
            );
            await (await manager.connect(deployer).setMaxSlippageBps(500)).wait();
            expect(await manager.maxSlippageBps()).to.equal(500);

            await (await manager.connect(deployer).setMinPoolLiquidity(UNISWAP_V3, 123)).wait();
            expect(await manager.minPoolLiquidity(UNISWAP_V3)).to.equal(123);
            expect(await manager.minPoolLiquidity(AERODROME)).to.equal(0);

            await (await manager.connect(deployer).setMinPositionLiquidity(UNISWAP_V3, 456)).wait();
            expect(await manager.minPositionLiquidity(UNISWAP_V3)).to.equal(456);
            expect(await manager.minPositionLiquidity(AERODROME)).to.equal(0);
        });

        it("rescues ERC20 and ERC721 held by the manager", async function () {
            const { manager, deployer, stranger, usdc } = await loadFixture(deployYieldManagerHarness);
            const managerAddr = await manager.getAddress();
            await (await usdc.mint(managerAddr, 1_000n)).wait();
            await expect(manager.connect(deployer).rescueToken(await usdc.getAddress(), stranger.address, 1_000n))
                .to.emit(manager, "TokenRescued")
                .withArgs(await usdc.getAddress(), stranger.address, 1_000n);
            expect(await usdc.balanceOf(stranger.address)).to.equal(1_000n);

            const ERC721 = await ethers.getContractFactory("MockERC721");
            const nft = await ERC721.deploy();
            await nft.waitForDeployment();
            await (await nft.mint(managerAddr, 42)).wait();
            await (await manager.connect(deployer).rescueERC721(await nft.getAddress(), 42, stranger.address)).wait();
            expect(await nft.ownerOf(42)).to.equal(stranger.address);
        });
    });

    describe("protocol extensibility (uint8 ids)", function () {
        const NEXT_PROTOCOL = 2;

        it("registers and runs a handler for an id beyond the canonical ids without redeploy", async function () {
            const {
                manager,
                deployer,
                timelock,
                pauser,
                operatorEOA,
                safeAddr,
                usdcAddr,
                wethAddr,
                uniFactory,
                uniNpm,
                uniRouter,
            } = await loadFixture(deployYieldManagerHarness);

            const NextHandler = await ethers.getContractFactory("MockNextYieldHandler");
            const nextHandler = await NextHandler.deploy(
                NEXT_PROTOCOL,
                await uniNpm.getAddress(),
                usdcAddr,
                await uniRouter.getAddress(),
                await uniFactory.getAddress(),
            );
            await nextHandler.waitForDeployment();
            const nextHandlerAddr = await nextHandler.getAddress();

            await expect(timelockCall(timelock, manager, "setYieldHandler", [NEXT_PROTOCOL, nextHandlerAddr]))
                .to.emit(manager, "YieldHandlerUpdated")
                .withArgs(NEXT_PROTOCOL, ZERO, nextHandlerAddr);
            expect(await manager.yieldHandlers(NEXT_PROTOCOL)).to.equal(nextHandlerAddr);

            await expect(
                manager.connect(operatorEOA).openLp(NEXT_PROTOCOL, openParams(safeAddr, FEE_TIER)),
            ).to.be.revertedWithCustomError(manager, "ProtocolDisabled");

            await (await manager.connect(pauser).setProtocolEnabledForOpen(NEXT_PROTOCOL, true)).wait();
            await (await manager.connect(pauser).setProtocolEnabledForClose(NEXT_PROTOCOL, true)).wait();
            await (await manager.connect(deployer).setPoolParamAllowed(NEXT_PROTOCOL, FEE_TIER, true)).wait();

            await expect(manager.connect(operatorEOA).openLp(NEXT_PROTOCOL, openParams(safeAddr, FEE_TIER)))
                .to.emit(manager, "PositionOpened")
                .withArgs(safeAddr, NEXT_PROTOCOL, 1n, USDC_AMOUNT, WETH_OUT, HALF, USDC_AMOUNT);
            expect(await manager.residualBasisUsd6Of(NEXT_PROTOCOL, 1)).to.equal(USDC_AMOUNT);
            expect(await manager.residualBasisUsd6Of(UNISWAP_V3, 1)).to.equal(0);
            expect(await uniNpm.ownerOf(1)).to.equal(safeAddr);

            await (await uniRouter.setOutput(600_000n)).wait();
            await expect(manager.connect(operatorEOA).closeLp(NEXT_PROTOCOL, closeParams(safeAddr, 1, FEE_TIER)))
                .to.emit(manager, "PositionClosed")
                .withArgs(safeAddr, NEXT_PROTOCOL, 1n, USDC_AMOUNT, 1_100_000n, 10_000n, 10_000, 0n);
            expect(await manager.residualBasisUsd6Of(NEXT_PROTOCOL, 1)).to.equal(0);
            expect(await manager.positionHandlerOf(NEXT_PROTOCOL, 1)).to.equal(ZERO);
        });

        it("keeps unregistered ids inert instead of reverting on decode", async function () {
            const { manager, operatorEOA, pauser, safeAddr } = await loadFixture(deployYieldManagerHarness);
            await expect(
                manager.connect(operatorEOA).openLp(200, openParams(safeAddr, FEE_TIER)),
            ).to.be.revertedWithCustomError(manager, "HandlerNotSet");
            await expect(manager.connect(pauser).setProtocolEnabledForOpen(200, true)).to.be.revertedWithCustomError(
                manager,
                "HandlerNotSet",
            );
            expect(await manager.yieldHandlers(200)).to.equal(ZERO);
            expect(await manager.isPoolParamAllowed(200, FEE_TIER)).to.equal(false);
        });

        it("rejects registering a handler whose PROTOCOL id mismatches the target id", async function () {
            const { manager, deployer, timelock, uniHandler } = await loadFixture(deployYieldManagerHarness);
            await expect(
                timelockCall(timelock, manager, "setYieldHandler", [NEXT_PROTOCOL, await uniHandler.getAddress()]),
            )
                .to.be.revertedWithCustomError(manager, "HandlerProtocolMismatch")
                .withArgs(NEXT_PROTOCOL, UNISWAP_V3);
        });
    });

    describe("handlers", function () {
        it("rejects direct (non-delegatecall) invocation", async function () {
            const { uniHandler, aeroHandler, safeAddr } = await loadFixture(deployYieldManagerHarness);
            await expect(uniHandler.openLp(openParams(safeAddr, FEE_TIER))).to.be.revertedWithCustomError(
                uniHandler,
                "OnlyDelegatecall",
            );
            await expect(uniHandler.closeLp(closeParams(safeAddr, 1, FEE_TIER), 0)).to.be.revertedWithCustomError(
                uniHandler,
                "OnlyDelegatecall",
            );
            await expect(aeroHandler.collectLp(collectParams(safeAddr, 1, TICK_SPACING))).to.be.revertedWithCustomError(
                aeroHandler,
                "OnlyDelegatecall",
            );
            await expect(
                uniHandler.withdrawLp({
                    onBehalfOf: safeAddr,
                    tokenId: 1,
                    decreaseAmount0Min: 0,
                    decreaseAmount1Min: 0,
                    deadline: DEADLINE,
                }),
            ).to.be.revertedWithCustomError(uniHandler, "OnlyDelegatecall");
            await expect(
                uniHandler.openLpInKind({
                    onBehalfOf: safeAddr,
                    token0: safeAddr,
                    token1: safeAddr,
                    amount0: 0,
                    amount1: 0,
                    tickLower: -100,
                    tickUpper: 100,
                    mintAmount0Min: 0,
                    mintAmount1Min: 0,
                    lpPoolParam: FEE_TIER,
                    deadline: DEADLINE,
                }),
            ).to.be.revertedWithCustomError(uniHandler, "OnlyDelegatecall");
        });

        it("rejects zero addresses in handler constructors", async function () {
            const { uniHandler, uniNpm, uniRouter, uniFactory, clNpm, clRouter, clFactory, voter, usdcAddr } =
                await loadFixture(deployYieldManagerHarness);
            const UniHandler = await ethers.getContractFactory("UniV3YieldHandler");
            const AeroHandler = await ethers.getContractFactory("AerodromeYieldHandler");
            const npm = await uniNpm.getAddress();
            const router = await uniRouter.getAddress();
            const factory = await uniFactory.getAddress();
            const voterAddr = await voter.getAddress();

            await expect(UniHandler.deploy(ZERO, usdcAddr, router, factory)).to.be.revertedWithCustomError(
                uniHandler,
                "ZeroAddress",
            );
            await expect(UniHandler.deploy(npm, ZERO, router, factory)).to.be.revertedWithCustomError(
                uniHandler,
                "ZeroAddress",
            );
            await expect(UniHandler.deploy(npm, usdcAddr, ZERO, factory)).to.be.revertedWithCustomError(
                uniHandler,
                "ZeroAddress",
            );
            await expect(UniHandler.deploy(npm, usdcAddr, router, ZERO)).to.be.revertedWithCustomError(
                uniHandler,
                "ZeroAddress",
            );
            await expect(
                AeroHandler.deploy(await clNpm.getAddress(), usdcAddr, await clRouter.getAddress(), ZERO, voterAddr),
            ).to.be.revertedWithCustomError(uniHandler, "ZeroAddress");
            await expect(
                AeroHandler.deploy(
                    await clNpm.getAddress(),
                    usdcAddr,
                    await clRouter.getAddress(),
                    await clFactory.getAddress(),
                    ZERO,
                ),
            ).to.be.revertedWithCustomError(uniHandler, "ZeroAddress");
        });
    });

    describe("stakePool staking", function () {
        it("reverts StakingNotSupported when opening a Uniswap V3 position with stake", async function () {
            const { manager, operatorEOA, safeAddr, uniHandler } = await loadFixture(deployYieldManagerHarness);
            await expect(
                manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER, { stake: true })),
            ).to.be.revertedWithCustomError(uniHandler, "StakingNotSupported");
        });

        it("reverts StakingNotSupported opening on Aerodrome when the pool has no stakePool", async function () {
            const { manager, operatorEOA, safeAddr, aeroHandler } = await loadFixture(deployYieldManagerHarness);
            await expect(
                manager.connect(operatorEOA).openLp(AERODROME, openParams(safeAddr, TICK_SPACING, { stake: true })),
            ).to.be.revertedWithCustomError(aeroHandler, "StakingNotSupported");
        });

        it("stakes the minted Aerodrome NFT into its stakePool and unstakes it on close", async function () {
            const { manager, operatorEOA, safeAddr, clNpm, clPool, clRouter, voter } =
                await loadFixture(deployYieldManagerHarness);

            const { stakePoolAddr } = await deployStakePool(clNpm, clPool, voter);

            await expect(
                manager.connect(operatorEOA).openLp(AERODROME, openParams(safeAddr, TICK_SPACING, { stake: true })),
            ).to.emit(manager, "PositionOpened");

            expect(await clNpm.ownerOf(1)).to.equal(stakePoolAddr);

            await (await clRouter.setOutput(600_000n)).wait();
            await expect(manager.connect(operatorEOA).closeLp(AERODROME, closeParams(safeAddr, 1, TICK_SPACING)))
                .to.emit(manager, "PositionClosed")
                .withArgs(safeAddr, AERODROME, 1n, USDC_AMOUNT, 1_100_000n, 10_000n, 10_000, 0n);

            expect(await manager.residualBasisUsd6Of(AERODROME, 1)).to.equal(0);
            expect(await clNpm.ownerOf(1)).to.equal(ZERO);
        });

        it("closes normally when the NFT left the stakePool without the module", async function () {
            const { manager, operatorEOA, safeAddr, safe, clNpm, clPool, clRouter, voter } =
                await loadFixture(deployYieldManagerHarness);
            const { stakePool, stakePoolAddr } = await deployStakePool(clNpm, clPool, voter);

            await manager.connect(operatorEOA).openLp(AERODROME, openParams(safeAddr, TICK_SPACING, { stake: true }));
            expect(await clNpm.ownerOf(1)).to.equal(stakePoolAddr);

            // Direct gauge withdrawal bypassing the module: the recorded
            // stakePool pin persists but no longer owns the NFT.
            await (
                await safe.execTransactionFromModuleReturnData(
                    stakePoolAddr,
                    0,
                    stakePool.interface.encodeFunctionData("withdraw", [1]),
                    0,
                )
            ).wait();
            expect(await clNpm.ownerOf(1)).to.equal(safeAddr);

            await (await clRouter.setOutput(600_000n)).wait();
            await expect(
                manager.connect(operatorEOA).closeLp(AERODROME, closeParams(safeAddr, 1, TICK_SPACING)),
            ).to.emit(manager, "PositionClosed");
            expect(await clNpm.ownerOf(1)).to.equal(ZERO);
        });

        it("unstakes from the original stakePool after the Voter gauge rotates", async function () {
            const { manager, operatorEOA, safeAddr, clNpm, clPool, clRouter, voter } =
                await loadFixture(deployYieldManagerHarness);
            const { stakePoolAddr: originalStakePool } = await deployStakePool(clNpm, clPool, voter);

            await manager.connect(operatorEOA).openLp(AERODROME, openParams(safeAddr, TICK_SPACING, { stake: true }));
            expect(await clNpm.ownerOf(1)).to.equal(originalStakePool);

            const { stakePoolAddr: replacementStakePool } = await deployStakePool(clNpm, clPool, voter);
            expect(replacementStakePool).to.not.equal(originalStakePool);
            await (await clRouter.setOutput(600_000n)).wait();

            await expect(
                manager.connect(operatorEOA).closeLp(AERODROME, closeParams(safeAddr, 1, TICK_SPACING)),
            ).to.emit(manager, "PositionClosed");
            expect(await clNpm.ownerOf(1)).to.equal(ZERO);
        });

        it("claims stakePool rewards only for a staked Aerodrome position and leaves it staked", async function () {
            const { manager, operatorEOA, safeAddr, treasury, weth, usdc, clNpm, clPool, voter } =
                await loadFixture(deployYieldManagerHarness);

            const { stakePool, stakePoolAddr } = await deployStakePool(clNpm, clPool, voter);

            await manager.connect(operatorEOA).openLp(AERODROME, openParams(safeAddr, TICK_SPACING, { stake: true }));
            expect(await clNpm.ownerOf(1)).to.equal(stakePoolAddr);

            // Staked liquidity earns emissions instead of trading fees, so any owed
            // amounts on the NFT must stay untouched — no temporary unstake to
            // collect them, no FeesCollected, no treasury skim.
            await (await clNpm.setOwed(1, 100_000n, 40_000n)).wait();
            const safeWethBefore = await weth.balanceOf(safeAddr);
            const safeUsdcBefore = await usdc.balanceOf(safeAddr);

            const collectTx = manager
                .connect(operatorEOA)
                .collectLp(AERODROME, collectParams(safeAddr, 1, TICK_SPACING));
            await expect(collectTx).to.emit(stakePool, "RewardClaimed").withArgs(1n, safeAddr);
            await expect(collectTx).to.not.emit(manager, "FeesCollected");

            expect(await weth.balanceOf(treasury.address)).to.equal(0);
            expect(await usdc.balanceOf(treasury.address)).to.equal(0);
            expect(await weth.balanceOf(safeAddr)).to.equal(safeWethBefore);
            expect(await usdc.balanceOf(safeAddr)).to.equal(safeUsdcBefore);
            expect(await clNpm.ownerOf(1)).to.equal(stakePoolAddr);
        });

        it("swaps the claimed stakePool reward to USDC through a pool param that is not allow-listed (M-1)", async function () {
            const {
                manager,
                timelock,
                operatorEOA,
                safeAddr,
                treasury,
                usdc,
                clNpm,
                clPool,
                clFactory,
                clRouter,
                voter,
            } = await loadFixture(deployYieldManagerHarness);

            const { stakePool, stakePoolAddr } = await deployStakePool(clNpm, clPool, voter);

            // Arm the stakePool with a mock AERO payout and give the reward its own
            // AERO/USDC pool: exit legs need a route and a reference, not an
            // allow-list entry.
            const ERC = await ethers.getContractFactory("MockERC20");
            const aero = await ERC.deploy("Mock Aero", "AERO", 18);
            await aero.waitForDeployment();
            const aeroAddr = await aero.getAddress();
            const usdcAddr = await usdc.getAddress();
            await (await aero.mint(stakePoolAddr, 10n ** 24n)).wait();
            await (await stakePool.setReward(aeroAddr, 500_000n)).wait();

            const [r0, r1] =
                aeroAddr.toLowerCase() < usdcAddr.toLowerCase() ? [aeroAddr, usdcAddr] : [usdcAddr, aeroAddr];
            const AERO_PARAM = encodeAerodromePoolParam(r0, r1, 50);
            const CLPool = await ethers.getContractFactory("MockCLPool");
            const aeroPool = await CLPool.deploy(r0, r1, Q96, 10n ** 18n);
            await aeroPool.waitForDeployment();
            await (await clFactory.setPoolFor(r0, r1, 50, aeroPool)).wait();
            // The reward swap executes on Aerodrome but is priced off a Uniswap
            // V3 reference — one price per token, independent of venue.
            const UniPoolFactory = await ethers.getContractFactory("MockUniswapV3Pool");
            const aeroRef = await UniPoolFactory.deploy(r0, r1, Q96, 10n ** 18n);
            await aeroRef.waitForDeployment();
            await (
                await timelockCall(timelock, manager, "setTwapConfig", [
                    aeroAddr,
                    await aeroRef.getAddress(),
                    TWAP_WINDOW,
                    TWAP_CARDINALITY,
                ])
            ).wait();
            expect(await manager.isPoolParamAllowed(AERODROME, AERO_PARAM)).to.equal(false);
            await (await clRouter.setOutputFor(usdcAddr, 123_456n)).wait();

            await manager.connect(operatorEOA).openLp(AERODROME, openParams(safeAddr, TICK_SPACING, { stake: true }));
            expect(await clNpm.ownerOf(1)).to.equal(stakePoolAddr);

            const safeUsdcBefore = await usdc.balanceOf(safeAddr);
            const collectTx = manager.connect(operatorEOA).collectLp(
                AERODROME,
                collectParams(safeAddr, 1, TICK_SPACING, {
                    swapRewardToUsdc: true,
                    rewardSwap: leg(100_000n, AERO_PARAM),
                }),
            );
            await expect(collectTx).to.emit(stakePool, "RewardClaimed").withArgs(1n, safeAddr);
            await expect(collectTx).to.not.emit(manager, "FeesCollected");

            // M-03: emissions are yield, so the claim pays feeCollectBps FIRST and
            // only the net reaches the router — the Safe keeps no AERO either way.
            const rewardFee = (500_000n * COLLECT_FEE_BPS) / 10_000n;
            await expect(collectTx)
                .to.emit(manager, "StakedRewardCollected")
                .withArgs(safeAddr, AERODROME, 1n, aeroAddr, 500_000n, rewardFee);
            expect(await aero.balanceOf(treasury.address)).to.equal(rewardFee);
            expect(await aero.balanceOf(safeAddr)).to.equal(0);
            expect(await aero.balanceOf(await clRouter.getAddress())).to.equal(500_000n - rewardFee);
            expect((await usdc.balanceOf(safeAddr)) - safeUsdcBefore).to.equal(123_456n);
            expect(await clNpm.ownerOf(1)).to.equal(stakePoolAddr);
        });

        it("collectLp on an unstaked Aerodrome position runs the normal fee collect", async function () {
            const { manager, operatorEOA, safeAddr, clNpm } = await loadFixture(deployYieldManagerHarness);

            // No stakePool set on the voter → the position is unstaked and owned by the Safe.
            await manager.connect(operatorEOA).openLp(AERODROME, openParams(safeAddr, TICK_SPACING));
            expect(await clNpm.ownerOf(1)).to.equal(safeAddr);

            // Falls through to the normal LP-fee collect (no stakePool reward path); NFT
            // stays on the Safe, and swapRewardToUsdc is ignored for unstaked positions.
            await manager
                .connect(operatorEOA)
                .collectLp(AERODROME, collectParams(safeAddr, 1, TICK_SPACING, { swapRewardToUsdc: true }));
            expect(await clNpm.ownerOf(1)).to.equal(safeAddr);
        });

        it("ignores a live stakePool for a position that opted out of staking", async function () {
            const { manager, operatorEOA, safeAddr, clNpm, clPool, clRouter, voter } =
                await loadFixture(deployYieldManagerHarness);

            // The pool HAS a stakePool, but the position never staked — the staked-stakePool
            // detection must key off custody (ownerOf == stakePool), not stakePool existence.
            const { stakePool } = await deployStakePool(clNpm, clPool, voter);

            await manager.connect(operatorEOA).openLp(AERODROME, openParams(safeAddr, TICK_SPACING));
            expect(await clNpm.ownerOf(1)).to.equal(safeAddr);

            const collectTx = manager
                .connect(operatorEOA)
                .collectLp(AERODROME, collectParams(safeAddr, 1, TICK_SPACING));
            await expect(collectTx).to.emit(manager, "FeesCollected");
            await expect(collectTx).to.not.emit(stakePool, "RewardClaimed");
            expect(await clNpm.ownerOf(1)).to.equal(safeAddr);

            await (await clRouter.setOutput(600_000n)).wait();
            await expect(manager.connect(operatorEOA).closeLp(AERODROME, closeParams(safeAddr, 1, TICK_SPACING)))
                .to.emit(manager, "PositionClosed")
                .withArgs(safeAddr, AERODROME, 1n, USDC_AMOUNT, 1_100_000n, 10_000n, 10_000, 0n);
            expect(await clNpm.ownerOf(1)).to.equal(ZERO);
        });

        // L-01: a partial close must not silently stop emissions. The surviving NFT
        // goes back into the pool it came out of, and the pin keeps pointing there.
        it("restakes the surviving NFT into the same stakePool after a partial close", async function () {
            const { manager, operatorEOA, safeAddr, clNpm, clPool, clRouter, voter } =
                await loadFixture(deployYieldManagerHarness);
            const { stakePoolAddr } = await deployStakePool(clNpm, clPool, voter);

            await manager.connect(operatorEOA).openLp(AERODROME, openParams(safeAddr, TICK_SPACING, { stake: true }));
            const liquidityBefore = (await clNpm.positionsData(1))[4];
            await (await clRouter.setOutput(300_000n)).wait();

            await expect(
                manager.connect(operatorEOA).closeLp(
                    AERODROME,
                    closeParams(safeAddr, 1, TICK_SPACING, {
                        exitBps: 5_000,
                        swap0: leg(300_000n, TICK_SPACING),
                    }),
                ),
            ).to.emit(manager, "PositionClosed");

            expect(await clNpm.ownerOf(1)).to.equal(stakePoolAddr);
            expect(await manager.stakePoolOf(AERODROME, 1)).to.equal(stakePoolAddr);
            const liquidityAfter = (await clNpm.positionsData(1))[4];
            expect(liquidityAfter).to.equal(liquidityBefore / 2n);
            expect(liquidityAfter).to.be.lessThan(liquidityBefore);
        });

        it("keeps claiming rewards after a partial close, and clears the pin on the final close", async function () {
            const { manager, operatorEOA, safeAddr, clNpm, clPool, clRouter, voter } =
                await loadFixture(deployYieldManagerHarness);
            const { stakePool, stakePoolAddr } = await deployStakePool(clNpm, clPool, voter);

            await manager.connect(operatorEOA).openLp(AERODROME, openParams(safeAddr, TICK_SPACING, { stake: true }));
            await (await clRouter.setOutput(300_000n)).wait();
            await (
                await manager.connect(operatorEOA).closeLp(
                    AERODROME,
                    closeParams(safeAddr, 1, TICK_SPACING, {
                        exitBps: 5_000,
                        swap0: leg(300_000n, TICK_SPACING),
                    }),
                )
            ).wait();

            // Still staked, so a later collect still routes to the stakePool.
            await expect(manager.connect(operatorEOA).collectLp(AERODROME, collectParams(safeAddr, 1, TICK_SPACING)))
                .to.emit(stakePool, "RewardClaimed")
                .withArgs(1n, safeAddr);

            await (await clRouter.setOutput(600_000n)).wait();
            await expect(
                manager.connect(operatorEOA).closeLp(AERODROME, closeParams(safeAddr, 1, TICK_SPACING)),
            ).to.emit(manager, "PositionClosed");
            expect(await clNpm.ownerOf(1)).to.equal(ZERO);
            expect(await manager.stakePoolOf(AERODROME, 1)).to.equal(ZERO);
            void stakePoolAddr;
        });

        it("does not stake a never-staked position on a partial close", async function () {
            const { manager, operatorEOA, safeAddr, clNpm, clPool, clRouter, voter } =
                await loadFixture(deployYieldManagerHarness);
            const { stakePoolAddr } = await deployStakePool(clNpm, clPool, voter);

            await manager.connect(operatorEOA).openLp(AERODROME, openParams(safeAddr, TICK_SPACING));
            await (await clRouter.setOutput(300_000n)).wait();

            await expect(
                manager.connect(operatorEOA).closeLp(
                    AERODROME,
                    closeParams(safeAddr, 1, TICK_SPACING, {
                        exitBps: 5_000,
                        swap0: leg(300_000n, TICK_SPACING),
                    }),
                ),
            ).to.emit(manager, "PositionClosed");

            expect(await clNpm.ownerOf(1)).to.equal(safeAddr);
            expect(await clNpm.ownerOf(1)).to.not.equal(stakePoolAddr);
            expect(await manager.stakePoolOf(AERODROME, 1)).to.equal(ZERO);
        });

        it("restakes into the pinned stakePool even after the Voter gauge rotates", async function () {
            const { manager, operatorEOA, safeAddr, clNpm, clPool, clRouter, voter } =
                await loadFixture(deployYieldManagerHarness);
            const { stakePoolAddr: originalStakePool } = await deployStakePool(clNpm, clPool, voter);

            await manager.connect(operatorEOA).openLp(AERODROME, openParams(safeAddr, TICK_SPACING, { stake: true }));

            const { stakePoolAddr: replacementStakePool } = await deployStakePool(clNpm, clPool, voter);
            expect(replacementStakePool).to.not.equal(originalStakePool);
            await (await clRouter.setOutput(300_000n)).wait();

            await (
                await manager.connect(operatorEOA).closeLp(
                    AERODROME,
                    closeParams(safeAddr, 1, TICK_SPACING, {
                        exitBps: 5_000,
                        swap0: leg(300_000n, TICK_SPACING),
                    }),
                )
            ).wait();

            // The rotation must not move the user's position to the new gauge.
            expect(await clNpm.ownerOf(1)).to.equal(originalStakePool);
            expect(await manager.stakePoolOf(AERODROME, 1)).to.equal(originalStakePool);
        });

        it("reverts the whole partial close when the restake fails", async function () {
            const { manager, operatorEOA, safeAddr, clNpm, clPool, clRouter, voter } =
                await loadFixture(deployYieldManagerHarness);
            const { stakePool, stakePoolAddr } = await deployStakePool(clNpm, clPool, voter);

            await manager.connect(operatorEOA).openLp(AERODROME, openParams(safeAddr, TICK_SPACING, { stake: true }));
            const liquidityBefore = (await clNpm.positionsData(1))[4];
            const basisBefore = await manager.residualBasisUsd6Of(AERODROME, 1);
            await (await clRouter.setOutput(300_000n)).wait();
            await (await stakePool.setDepositFails(true)).wait();

            await expect(
                manager.connect(operatorEOA).closeLp(
                    AERODROME,
                    closeParams(safeAddr, 1, TICK_SPACING, {
                        exitBps: 5_000,
                        swap0: leg(300_000n, TICK_SPACING),
                    }),
                ),
            ).to.be.reverted;

            // Nothing moved: still staked in the same pool, same liquidity, same basis.
            expect(await clNpm.ownerOf(1)).to.equal(stakePoolAddr);
            expect((await clNpm.positionsData(1))[4]).to.equal(liquidityBefore);
            expect(await manager.residualBasisUsd6Of(AERODROME, 1)).to.equal(basisBefore);
            expect(await manager.stakePoolOf(AERODROME, 1)).to.equal(stakePoolAddr);
        });

        // M-03: emissions are fee-bearing yield on EVERY route that can claim them
        // — an explicit collect, and the gauge withdrawal inside a close or switch.
        describe("staked reward fee (M-03)", function () {
            const REWARD = 500_000n;
            const REWARD_FEE = (REWARD * COLLECT_FEE_BPS) / 10_000n;

            /// Stake a position and arm its gauge with `rewardToken`/`REWARD`.
            async function stakeWithReward(f: any, rewardToken?: any, rewardAmount = REWARD) {
                const { manager, operatorEOA, safeAddr, clNpm, clPool, voter } = f;
                const { stakePool, stakePoolAddr } = await deployStakePool(clNpm, clPool, voter);
                let reward = rewardToken;
                if (!reward) {
                    const ERC = await ethers.getContractFactory("MockERC20");
                    reward = await ERC.deploy("Mock Aero", "AERO", 18);
                    await reward.waitForDeployment();
                }
                const rewardAddr = await reward.getAddress();
                await (await reward.mint(stakePoolAddr, 10n ** 24n)).wait();
                await (await stakePool.setReward(rewardAddr, rewardAmount)).wait();
                await manager
                    .connect(operatorEOA)
                    .openLp(AERODROME, openParams(safeAddr, TICK_SPACING, { stake: true }));
                return { stakePool, stakePoolAddr, reward, rewardAddr };
            }

            it("leaves a one-unit claimed reward in kind when its TWAP floor rounds to zero", async function () {
                const f = await loadFixture(deployYieldManagerHarness);
                const { manager, operatorEOA, safeAddr, weth, clRouter } = f;
                await stakeWithReward(f, weth, 1n);
                const callsBefore = await clRouter.callCount();
                const wethBefore = await weth.balanceOf(safeAddr);

                await expect(
                    manager.connect(operatorEOA).collectLp(
                        AERODROME,
                        collectParams(safeAddr, 1, TICK_SPACING, {
                            swapRewardToUsdc: true,
                            rewardSwap: leg(0, TICK_SPACING),
                        }),
                    ),
                )
                    .to.emit(manager, "StakedRewardCollected")
                    .withArgs(safeAddr, AERODROME, 1n, await weth.getAddress(), 1n, 0n);

                expect(await clRouter.callCount()).to.equal(callsBefore);
                expect(await weth.balanceOf(safeAddr)).to.equal(wethBefore + 1n);
            });

            it("charges the collect fee on a claim even when the reward is not swapped", async function () {
                const f = await loadFixture(deployYieldManagerHarness);
                const { manager, operatorEOA, safeAddr, treasury } = f;
                const { reward, rewardAddr } = await stakeWithReward(f);

                await expect(
                    manager.connect(operatorEOA).collectLp(AERODROME, collectParams(safeAddr, 1, TICK_SPACING)),
                )
                    .to.emit(manager, "StakedRewardCollected")
                    .withArgs(safeAddr, AERODROME, 1n, rewardAddr, REWARD, REWARD_FEE);

                expect(await reward.balanceOf(treasury.address)).to.equal(REWARD_FEE);
                expect(await reward.balanceOf(safeAddr)).to.equal(REWARD - REWARD_FEE);
            });

            it("taxes only the newly claimed delta, never a reward the Safe already held", async function () {
                const f = await loadFixture(deployYieldManagerHarness);
                const { manager, operatorEOA, safeAddr, treasury } = f;
                const { reward, rewardAddr } = await stakeWithReward(f);

                // Pre-existing balance: not part of this claim, so not fee-bearing.
                await (await reward.mint(safeAddr, 9_000_000n)).wait();

                await expect(
                    manager.connect(operatorEOA).collectLp(AERODROME, collectParams(safeAddr, 1, TICK_SPACING)),
                )
                    .to.emit(manager, "StakedRewardCollected")
                    .withArgs(safeAddr, AERODROME, 1n, rewardAddr, REWARD, REWARD_FEE);

                expect(await reward.balanceOf(treasury.address)).to.equal(REWARD_FEE);
                expect(await reward.balanceOf(safeAddr)).to.equal(9_000_000n + REWARD - REWARD_FEE);
            });

            it("charges the reward paid out by the gauge on a full close", async function () {
                const f = await loadFixture(deployYieldManagerHarness);
                const { manager, operatorEOA, safeAddr, treasury, clRouter } = f;
                const { reward, rewardAddr } = await stakeWithReward(f);
                await (await clRouter.setOutput(600_000n)).wait();

                await expect(manager.connect(operatorEOA).closeLp(AERODROME, closeParams(safeAddr, 1, TICK_SPACING)))
                    .to.emit(manager, "StakedRewardCollected")
                    .withArgs(safeAddr, AERODROME, 1n, rewardAddr, REWARD, REWARD_FEE);

                expect(await reward.balanceOf(treasury.address)).to.equal(REWARD_FEE);
            });

            it("keeps a USDC-denominated gauge reward out of the close's realized value", async function () {
                const f = await loadFixture(deployYieldManagerHarness);
                const { manager, operatorEOA, safeAddr, treasury, usdc, clRouter } = f;
                // Reward token == USDC is the sharpest probe: if the claim were
                // settled after the close snapshot, it would inflate
                // currentValueUsd6 and overstate the performance fee.
                await stakeWithReward(f, usdc);
                await (await clRouter.setOutput(600_000n)).wait();

                await expect(manager.connect(operatorEOA).closeLp(AERODROME, closeParams(safeAddr, 1, TICK_SPACING)))
                    .to.emit(manager, "PositionClosed")
                    .withArgs(safeAddr, AERODROME, 1n, USDC_AMOUNT, 1_100_000n, 10_000n, 10_000, 0n);

                // Treasury got the reward fee, and only the LP value drove the perf fee.
                expect(await usdc.balanceOf(treasury.address)).to.equal(REWARD_FEE + 10_000n);
            });

            it("charges a partial close's gauge reward exactly once and restakes", async function () {
                const f = await loadFixture(deployYieldManagerHarness);
                const { manager, operatorEOA, safeAddr, treasury, clNpm, clRouter } = f;
                const { reward, stakePoolAddr } = await stakeWithReward(f);
                await (await clRouter.setOutput(300_000n)).wait();

                await (
                    await manager.connect(operatorEOA).closeLp(
                        AERODROME,
                        closeParams(safeAddr, 1, TICK_SPACING, {
                            exitBps: 5_000,
                            swap0: leg(300_000n, TICK_SPACING),
                        }),
                    )
                ).wait();

                // One withdrawal → one claim → one fee. The restake must not claim again.
                expect(await reward.balanceOf(treasury.address)).to.equal(REWARD_FEE);
                expect(await clNpm.ownerOf(1)).to.equal(stakePoolAddr);
            });

            it("charges a switch's gauge reward once and keeps it out of the moved amounts", async function () {
                const f = await loadFixture(deployYieldManagerHarness);
                const { manager, operatorEOA, safeAddr, treasury, usdc } = f;
                // USDC reward again: the switch moves token amounts in kind, so a
                // leaked reward would show up as an inflated withdrawn1.
                await stakeWithReward(f, usdc);

                await expect(
                    manager.connect(operatorEOA).switchLp(AERODROME, UNISWAP_V3, {
                        onBehalfOf: safeAddr,
                        tokenId: 1,
                        decreaseAmount0Min: 0,
                        decreaseAmount1Min: 0,
                        tickLower: -100,
                        tickUpper: 100,
                        mintAmount0Min: 0,
                        mintAmount1Min: 0,
                        lpPoolParam: FEE_TIER,
                        deadline: DEADLINE,
                    }),
                )
                    .to.emit(manager, "PositionSwitched")
                    .withArgs(safeAddr, AERODROME, UNISWAP_V3, 1n, 1n, USDC_AMOUNT, WETH_OUT, HALF, WETH_OUT, HALF);

                expect(await usdc.balanceOf(treasury.address)).to.equal(REWARD_FEE);
            });

            it("handles a zero fee rate, a fee that rounds to zero, and no reward at all", async function () {
                const f = await loadFixture(deployYieldManagerHarness);
                const { manager, timelock, operatorEOA, safeAddr, treasury } = f;
                const { stakePool, reward, rewardAddr } = await stakeWithReward(f);

                // Rounds to zero: 3 * 250 / 10_000 == 0 — claimed, reported, untaxed.
                await (await stakePool.setReward(rewardAddr, 3n)).wait();
                await expect(
                    manager.connect(operatorEOA).collectLp(AERODROME, collectParams(safeAddr, 1, TICK_SPACING)),
                )
                    .to.emit(manager, "StakedRewardCollected")
                    .withArgs(safeAddr, AERODROME, 1n, rewardAddr, 3n, 0n);
                expect(await reward.balanceOf(treasury.address)).to.equal(0);

                // Zero reward: nothing claimed, so nothing to report.
                await (await stakePool.setReward(rewardAddr, 0n)).wait();
                await expect(
                    manager.connect(operatorEOA).collectLp(AERODROME, collectParams(safeAddr, 1, TICK_SPACING)),
                ).to.not.emit(manager, "StakedRewardCollected");

                // Fee rate zero: the claim still lands, still reported, still untaxed.
                await (await stakePool.setReward(rewardAddr, REWARD)).wait();
                await (await timelockCall(timelock, manager, "setFeeCollectBps", [0])).wait();
                await expect(
                    manager.connect(operatorEOA).collectLp(AERODROME, collectParams(safeAddr, 1, TICK_SPACING)),
                )
                    .to.emit(manager, "StakedRewardCollected")
                    .withArgs(safeAddr, AERODROME, 1n, rewardAddr, REWARD, 0n);
                expect(await reward.balanceOf(treasury.address)).to.equal(0);
            });

            it("waives the reward fee — without blocking the collect — when the treasury cannot receive it", async function () {
                const f = await loadFixture(deployYieldManagerHarness);
                const { manager, operatorEOA, safeAddr, treasury } = f;
                const { reward, rewardAddr } = await stakeWithReward(f);

                // A token that REVERTS for the treasury (blacklist-style).
                await (await reward.setRevertTransferTo(treasury.address)).wait();
                const collectTx = manager
                    .connect(operatorEOA)
                    .collectLp(AERODROME, collectParams(safeAddr, 1, TICK_SPACING));
                await expect(collectTx)
                    .to.emit(manager, "CollectFeeTransferFailed")
                    .withArgs(safeAddr, 1n, rewardAddr, REWARD_FEE);
                await expect(collectTx)
                    .to.emit(manager, "StakedRewardCollected")
                    .withArgs(safeAddr, AERODROME, 1n, rewardAddr, REWARD, 0n);
                expect(await reward.balanceOf(treasury.address)).to.equal(0);
                expect(await reward.balanceOf(safeAddr)).to.equal(REWARD);
            });

            it("waives the reward fee on a silent false return and still closes", async function () {
                const f = await loadFixture(deployYieldManagerHarness);
                const { manager, operatorEOA, safeAddr, treasury, clRouter } = f;
                const { reward, rewardAddr } = await stakeWithReward(f);
                await (await clRouter.setOutput(600_000n)).wait();

                // A non-compliant token that returns false instead of reverting.
                await (await reward.setFalseTransferTo(treasury.address)).wait();
                const closeTx = manager.connect(operatorEOA).closeLp(AERODROME, closeParams(safeAddr, 1, TICK_SPACING));
                await expect(closeTx)
                    .to.emit(manager, "CollectFeeTransferFailed")
                    .withArgs(safeAddr, 1n, rewardAddr, REWARD_FEE);
                await expect(closeTx)
                    .to.emit(manager, "StakedRewardCollected")
                    .withArgs(safeAddr, AERODROME, 1n, rewardAddr, REWARD, 0n);
                await expect(closeTx).to.emit(manager, "PositionClosed");
                expect(await reward.balanceOf(treasury.address)).to.equal(0);
            });
        });
    });

    describe("constructor validation", function () {
        async function baseArgs(f: Awaited<ReturnType<typeof deployYieldManagerHarness>>) {
            return [
                await f.reg.getAddress(),
                f.usdcAddr,
                f.wethAddr,
                [UNISWAP_V3, AERODROME],
                [await f.uniHandler.getAddress(), await f.aeroHandler.getAddress()],
                [[FEE_TIER], [TICK_SPACING]],
                [0, 0],
                [0, 0],
                [
                    {
                        token: f.wethAddr,
                        config: { pool: f.uniPoolAddr, window: TWAP_WINDOW, minCardinality: TWAP_CARDINALITY },
                    },
                ],
                f.treasury.address,
                Number(PERF_FEE_BPS),
                Number(COLLECT_FEE_BPS),
                MAX_FEE_BPS,
                f.deployer.address,
                await f.timelock.getAddress(),
                f.pauser.address,
            ];
        }

        it("rejects zero addresses and out-of-range fees", async function () {
            const f = await loadFixture(deployYieldManagerHarness);
            const Manager = await ethers.getContractFactory("SafeYieldManager");
            const base = await baseArgs(f);
            const deployWith = (index: number, value: any) => {
                const args = [...base];
                args[index] = value;
                return (Manager as any).deploy(...args);
            };

            await expect(deployWith(0, ZERO)).to.be.revertedWithCustomError(f.manager, "ZeroAddress");
            await expect(deployWith(1, ZERO)).to.be.revertedWithCustomError(f.manager, "ZeroAddress");
            await expect(deployWith(2, ZERO)).to.be.revertedWithCustomError(f.manager, "ZeroAddress");
            await expect(deployWith(13, ZERO)).to.be.revertedWithCustomError(f.manager, "ZeroAddress");
            await expect(deployWith(14, ZERO)).to.be.revertedWithCustomError(f.manager, "ZeroAddress");
            await expect(deployWith(15, ZERO)).to.be.revertedWithCustomError(f.manager, "ZeroAddress");
            await expect(deployWith(9, ZERO)).to.be.revertedWithCustomError(f.manager, "InvalidTreasury");
            await expect(deployWith(12, 10_001)).to.be.revertedWithCustomError(f.manager, "FeeAboveMax");
            await expect(deployWith(10, MAX_FEE_BPS + 1)).to.be.revertedWithCustomError(f.manager, "FeeAboveMax");
            await expect(deployWith(11, MAX_FEE_BPS + 1)).to.be.revertedWithCustomError(f.manager, "FeeAboveMax");
        });

        // The invariant the seeded references exist to hold: a deployment
        // cannot allow-list a pool param whose non-USDC side has no live
        // reference. Without this the constructor would be the one path into
        // an allow-listed-but-unpriceable pool, and openLp would only discover
        // it at the first swap.
        it("refuses to allow-list a seeded pool param with no reference behind it", async function () {
            const f = await loadFixture(deployYieldManagerHarness);
            const Manager = await ethers.getContractFactory("SafeYieldManager");
            const args = await baseArgs(f);
            args[8] = [];
            await expect((Manager as any).deploy(...args))
                .to.be.revertedWithCustomError(f.manager, "TwapNotConfigured")
                .withArgs(f.wethAddr);
        });

        it("holds a seeded reference to the same standard as a replaced one", async function () {
            const f = await loadFixture(deployYieldManagerHarness);
            const Manager = await ethers.getContractFactory("SafeYieldManager");
            const seedWith = async (overrides: Record<string, any>) => {
                const args = await baseArgs(f);
                args[8] = [
                    {
                        token: f.wethAddr,
                        config: {
                            pool: f.uniPoolAddr,
                            window: TWAP_WINDOW,
                            minCardinality: TWAP_CARDINALITY,
                            ...overrides,
                        },
                    },
                ];
                return (Manager as any).deploy(...args);
            };

            await expect(seedWith({ window: TWAP_WINDOW - 1 })).to.be.revertedWithCustomError(
                f.manager,
                "TwapWindowTooShort",
            );
            await expect(seedWith({ minCardinality: TWAP_CARDINALITY - 1 })).to.be.revertedWithCustomError(
                f.manager,
                "TwapCardinalityBelowFloor",
            );
            await expect(seedWith({ pool: f.stranger.address })).to.be.revertedWithCustomError(
                f.manager,
                "InvalidTwapReferencePool",
            );

            // A pool that does not trade the pair, and one that trades it but
            // cannot answer over the window, are both rejected at deploy time
            // rather than at the first swap.
            const Pool = await ethers.getContractFactory("MockUniswapV3Pool");
            const wrongPair = await Pool.deploy(f.wethAddr, f.wethAddr, Q96, 10n ** 18n);
            await expect(seedWith({ pool: await wrongPair.getAddress() })).to.be.revertedWithCustomError(
                f.manager,
                "TwapPoolPairMismatch",
            );

            const thinHistory = await Pool.deploy(f.wethAddr, f.usdcAddr, Q96, 10n ** 18n);
            await (await thinHistory.setObservationCardinality(TWAP_CARDINALITY - 1)).wait();
            await expect(seedWith({ pool: await thinHistory.getAddress() })).to.be.revertedWithCustomError(
                f.manager,
                "TwapCardinalityTooLow",
            );
        });

        it("rejects every constructor array length mismatch", async function () {
            const f = await loadFixture(deployYieldManagerHarness);
            const Manager = await ethers.getContractFactory("SafeYieldManager");
            const base = await baseArgs(f);
            const deployWith = (index: number, value: any) => {
                const args = [...base];
                args[index] = value;
                return (Manager as any).deploy(...args);
            };

            await expect(deployWith(5, [[FEE_TIER]])).to.be.revertedWithCustomError(f.manager, "LengthMismatch");
            await expect(deployWith(6, [0])).to.be.revertedWithCustomError(f.manager, "LengthMismatch");
            await expect(deployWith(7, [0])).to.be.revertedWithCustomError(f.manager, "LengthMismatch");
        });
    });

    describe("pool validation", function () {
        it("rejects missing, mispaired, uninitialized, and thin pools", async function () {
            const { manager, operatorEOA, deployer, safeAddr, uniFactory, uniPool, wethAddr, usdcAddr } =
                await loadFixture(deployYieldManagerHarness);
            const Pool = await ethers.getContractFactory("MockUniswapV3Pool");
            const open = () => manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER));

            await (await uniFactory.setPool(ZERO)).wait();
            await expect(open()).to.be.revertedWithCustomError(manager, "PoolDoesNotExist");

            const mispaired0 = await Pool.deploy(usdcAddr, wethAddr, Q96, 10n ** 18n);
            await (await uniFactory.setPool(await mispaired0.getAddress())).wait();
            await expect(open()).to.be.revertedWithCustomError(manager, "WrongTokenPair");

            const mispaired1 = await Pool.deploy(wethAddr, wethAddr, Q96, 10n ** 18n);
            await (await uniFactory.setPool(await mispaired1.getAddress())).wait();
            await expect(open()).to.be.revertedWithCustomError(manager, "WrongTokenPair");

            const uninitialized = await Pool.deploy(wethAddr, usdcAddr, 0, 10n ** 18n);
            await (await uniFactory.setPool(await uninitialized.getAddress())).wait();
            await expect(open()).to.be.revertedWithCustomError(manager, "PoolNotInitialized");

            await (await uniFactory.setPool(await uniPool.getAddress())).wait();
            await (await manager.connect(deployer).setMinPoolLiquidity(UNISWAP_V3, 10n ** 19n)).wait();
            await expect(open()).to.be.revertedWithCustomError(manager, "PoolTooThin");
        });
    });

    describe("defensive branches", function () {
        it("reverts LpNotOnSafe when the minted NFT lands elsewhere", async function () {
            const { manager, operatorEOA, stranger, safeAddr, uniNpm } = await loadFixture(deployYieldManagerHarness);
            await (await uniNpm.setMintOwnerOverride(stranger.address)).wait();
            await expect(
                manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER)),
            ).to.be.revertedWithCustomError(manager, "LpNotOnSafe");
        });

        it("reverts InvalidExitBps when a partial close would round to zero liquidity", async function () {
            const { manager, operatorEOA, safeAddr, uniNpm } = await loadFixture(deployYieldManagerHarness);
            await (await uniNpm.setMintLiquidity(1)).wait();
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            await expect(
                manager
                    .connect(operatorEOA)
                    .closeLp(UNISWAP_V3, closeParams(safeAddr, 1, FEE_TIER, { exitBps: 5_000 })),
            ).to.be.revertedWithCustomError(manager, "InvalidExitBps");
        });

        it("full-closes a zero-liquidity position without decrease or swap and charges no fee", async function () {
            const { manager, operatorEOA, safeAddr, uniNpm } = await loadFixture(deployYieldManagerHarness);
            await (await uniNpm.setMintLiquidity(0)).wait();
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            await expect(manager.connect(operatorEOA).closeLp(UNISWAP_V3, closeParams(safeAddr, 1, FEE_TIER)))
                .to.emit(manager, "PositionClosed")
                .withArgs(safeAddr, UNISWAP_V3, 1n, USDC_AMOUNT, 0n, 0n, 10_000, 0n);
        });

        it("charges no performance fee when a close realizes a loss", async function () {
            const { manager, operatorEOA, safeAddr, treasury, usdc, uniRouter } =
                await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            await (await uniRouter.setOutput(300_000n)).wait();

            const tx = manager
                .connect(operatorEOA)
                .closeLp(UNISWAP_V3, closeParams(safeAddr, 1, FEE_TIER, { swap0: leg(300_000n, FEE_TIER) }));
            await expect(tx)
                .to.emit(manager, "PositionClosed")
                .withArgs(safeAddr, UNISWAP_V3, 1n, USDC_AMOUNT, 800_000n, 0n, 10_000, 0n);
            await expect(tx).to.not.emit(manager, "FeeTransferFailed");
            expect(await usdc.balanceOf(treasury.address)).to.equal(0);
        });

        it("closeLp enforces the deadline", async function () {
            const { manager, operatorEOA, safeAddr } = await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            await expect(
                manager.connect(operatorEOA).closeLp(UNISWAP_V3, closeParams(safeAddr, 1, FEE_TIER, { deadline: 1 })),
            ).to.be.revertedWithCustomError(manager, "DeadlineExpired");
        });

        it("closeLp and collectLp reject unauthorized callers", async function () {
            const { manager, operatorEOA, stranger, safeAddr } = await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            await expect(
                manager.connect(stranger).closeLp(UNISWAP_V3, closeParams(safeAddr, 1, FEE_TIER)),
            ).to.be.revertedWithCustomError(manager, "NotAuthorized");
            await expect(
                manager.connect(stranger).collectLp(UNISWAP_V3, collectParams(safeAddr, 1, FEE_TIER)),
            ).to.be.revertedWithCustomError(manager, "NotAuthorized");
        });

        it("collectLp enforces the deadline on the swap path", async function () {
            const { manager, operatorEOA, safeAddr } = await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            await expect(
                manager
                    .connect(operatorEOA)
                    .collectLp(UNISWAP_V3, collectParams(safeAddr, 1, FEE_TIER, { swapFeesToUsdc: true, deadline: 1 })),
            ).to.be.revertedWithCustomError(manager, "DeadlineExpired");
        });

        it("reverts WrongTokenPair when a swap leg's pool does not trade the position token against USDC", async function () {
            const { manager, operatorEOA, safeAddr, uniNpm, usdcAddr } = await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();

            const ERC = await ethers.getContractFactory("MockERC20");
            const foreign = await ERC.deploy("Foreign", "FRN", 18);
            await foreign.waitForDeployment();

            // Position token0 no longer matches the {token0, USDC} pair of the
            // pool the leg routes through — the leg validation must refuse it.
            await (await uniNpm.setTokens(1, await foreign.getAddress(), usdcAddr)).wait();
            await expect(
                manager.connect(operatorEOA).closeLp(UNISWAP_V3, closeParams(safeAddr, 1, FEE_TIER)),
            ).to.be.revertedWithCustomError(manager, "WrongTokenPair");

            await expect(
                manager
                    .connect(operatorEOA)
                    .collectLp(UNISWAP_V3, collectParams(safeAddr, 1, FEE_TIER, { swapFeesToUsdc: true })),
            ).to.be.revertedWithCustomError(manager, "WrongTokenPair");
        });

        it("reverts LpNotOnSafe when the position left the Safe after open", async function () {
            const { manager, operatorEOA, stranger, safeAddr, uniNpm } = await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            await (await uniNpm.setOwner(1, stranger.address)).wait();
            await expect(
                manager.connect(operatorEOA).closeLp(UNISWAP_V3, closeParams(safeAddr, 1, FEE_TIER)),
            ).to.be.revertedWithCustomError(manager, "LpNotOnSafe");
        });

        it("surfaces typed ModuleCallFailed when the Safe fails with empty returndata", async function () {
            const { manager, operatorEOA, safeAddr, safe, uniRouter } = await loadFixture(deployYieldManagerHarness);
            await (await safe.setFail(await uniRouter.getAddress(), 1)).wait();
            await expect(manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER)))
                .to.be.revertedWithCustomError(manager, "ModuleCallFailed")
                .withArgs(3);
        });

        it("bubbles the Safe's revert data when present", async function () {
            const { manager, operatorEOA, safeAddr, safe, uniRouter } = await loadFixture(deployYieldManagerHarness);
            const errData = ethers.concat(["0x08c379a0", abi.encode(["string"], ["router boom"])]);
            await (await safe.setFail(await uniRouter.getAddress(), 2)).wait();
            await (await safe.setFailData(errData)).wait();
            await expect(
                manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER)),
            ).to.be.revertedWith("router boom");
        });

        it("wraps empty handler reverts in HandlerCallFailed", async function () {
            const { manager, deployer, timelock, pauser, operatorEOA, safeAddr } =
                await loadFixture(deployYieldManagerHarness);
            const Reverting = await ethers.getContractFactory("MockRevertingYieldHandler");
            const reverting = await Reverting.deploy(3);
            await reverting.waitForDeployment();
            await (await timelockCall(timelock, manager, "setYieldHandler", [3, await reverting.getAddress()])).wait();
            await (await manager.connect(pauser).setProtocolEnabledForOpen(3, true)).wait();
            await (await manager.connect(deployer).setPoolParamAllowed(3, FEE_TIER, true)).wait();
            await expect(
                manager.connect(operatorEOA).openLp(3, openParams(safeAddr, FEE_TIER)),
            ).to.be.revertedWithCustomError(manager, "HandlerCallFailed");
        });

        it("reverts HandlerNotSet when the pinned handler is missing (defensive invariant)", async function () {
            const { manager, operatorEOA, safeAddr } = await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();

            const baseSlot = BigInt("0x53ba738b9a2829dfda910cf4e864fcd3f84e03854b49244f3d159a473ee6a400");
            const inner = ethers.keccak256(abi.encode(["uint256", "uint256"], [UNISWAP_V3, baseSlot + 5n]));
            const slot = ethers.keccak256(abi.encode(["uint256", "bytes32"], [1, inner]));
            await ethers.provider.send("hardhat_setStorageAt", [await manager.getAddress(), slot, ethers.ZeroHash]);

            await expect(
                manager.connect(operatorEOA).closeLp(UNISWAP_V3, closeParams(safeAddr, 1, FEE_TIER)),
            ).to.be.revertedWithCustomError(manager, "HandlerNotSet");
        });

        it("blocks reentrant calls through the swap callback", async function () {
            const { manager, operatorEOA, safeAddr, uniRouter, uniNpm } = await loadFixture(deployYieldManagerHarness);
            const managerAddr = await manager.getAddress();

            await (
                await uniRouter.setCallback(
                    managerAddr,
                    manager.interface.encodeFunctionData("openLp", [UNISWAP_V3, openParams(safeAddr, FEE_TIER)]),
                )
            ).wait();
            await expect(
                manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER)),
            ).to.be.revertedWithCustomError(manager, "ReentrancyGuardReentrantCall");

            await (await uniRouter.setCallback(ZERO, "0x")).wait();
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();

            await (
                await uniRouter.setCallback(
                    managerAddr,
                    manager.interface.encodeFunctionData("closeLp", [UNISWAP_V3, closeParams(safeAddr, 1, FEE_TIER)]),
                )
            ).wait();
            await expect(
                manager.connect(operatorEOA).closeLp(UNISWAP_V3, closeParams(safeAddr, 1, FEE_TIER)),
            ).to.be.revertedWithCustomError(manager, "ReentrancyGuardReentrantCall");

            await (await uniNpm.setOwed(1, 100_000n, 0)).wait();
            await (
                await uniRouter.setCallback(
                    managerAddr,
                    manager.interface.encodeFunctionData("collectLp", [
                        UNISWAP_V3,
                        collectParams(safeAddr, 1, FEE_TIER),
                    ]),
                )
            ).wait();
            await expect(
                manager.connect(operatorEOA).collectLp(
                    UNISWAP_V3,
                    collectParams(safeAddr, 1, FEE_TIER, {
                        swapFeesToUsdc: true,
                        swap0: leg(95_000n, FEE_TIER),
                    }),
                ),
            ).to.be.revertedWithCustomError(manager, "ReentrancyGuardReentrantCall");
        });

        it("treats empty transfer returndata as fee-transfer success", async function () {
            const { manager, operatorEOA, safeAddr, safe, usdcAddr, uniRouter } =
                await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            await (await uniRouter.setOutput(600_000n)).wait();
            await (await safe.setFail(usdcAddr, 3)).wait();
            await (await safe.setFailData("0x")).wait();

            const tx = manager.connect(operatorEOA).closeLp(UNISWAP_V3, closeParams(safeAddr, 1, FEE_TIER));
            await expect(tx)
                .to.emit(manager, "PositionClosed")
                .withArgs(safeAddr, UNISWAP_V3, 1n, USDC_AMOUNT, 1_100_000n, 10_000n, 10_000, 0n);
            await expect(tx).to.not.emit(manager, "FeeTransferFailed");
        });

        it("treats short transfer returndata as fee-transfer failure", async function () {
            const { manager, operatorEOA, safeAddr, safe, usdcAddr, uniRouter } =
                await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            await (await uniRouter.setOutput(600_000n)).wait();
            await (await safe.setFail(usdcAddr, 3)).wait();
            await (await safe.setFailData("0x01")).wait();

            await expect(manager.connect(operatorEOA).closeLp(UNISWAP_V3, closeParams(safeAddr, 1, FEE_TIER)))
                .to.emit(manager, "FeeTransferFailed")
                .withArgs(safeAddr, 1n, 10_000n);
        });
    });

    describe("collect fee edge cases", function () {
        it("skips the collect fee when it rounds to zero", async function () {
            const { manager, operatorEOA, safeAddr, treasury, usdc, uniNpm } =
                await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            await (await uniNpm.setOwed(1, 0, 10n)).wait();

            const safeBefore = await usdc.balanceOf(safeAddr);
            await expect(manager.connect(operatorEOA).collectLp(UNISWAP_V3, collectParams(safeAddr, 1, FEE_TIER)))
                .to.emit(manager, "FeesCollected")
                .withArgs(safeAddr, UNISWAP_V3, 1n, anyValue, 0n, 0n, anyValue, 10n, 0n);
            expect(await usdc.balanceOf(treasury.address)).to.equal(0);
            expect((await usdc.balanceOf(safeAddr)) - safeBefore).to.equal(10n);
        });

        it("waives the collect fee when the treasury transfer returns false or reverts", async function () {
            const { manager, operatorEOA, safeAddr, treasury, usdc, weth, uniNpm } =
                await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            await (await uniNpm.setOwed(1, 100_000n, 40_000n)).wait();
            await (await usdc.setFalseTransferTo(treasury.address)).wait();
            await (await weth.setRevertTransferTo(treasury.address)).wait();

            const safeUsdcBefore = await usdc.balanceOf(safeAddr);
            const tx = manager.connect(operatorEOA).collectLp(UNISWAP_V3, collectParams(safeAddr, 1, FEE_TIER));
            await expect(tx)
                .to.emit(manager, "CollectFeeTransferFailed")
                .withArgs(safeAddr, 1n, await usdc.getAddress(), 1_000n);
            await expect(tx)
                .to.emit(manager, "CollectFeeTransferFailed")
                .withArgs(safeAddr, 1n, await weth.getAddress(), 2_500n);
            expect(await usdc.balanceOf(treasury.address)).to.equal(0);
            expect((await usdc.balanceOf(safeAddr)) - safeUsdcBefore).to.equal(40_000n);
        });

        it("forwards nothing to the Safe when feeCollectBps consumes the whole harvest", async function () {
            const f = await loadFixture(deployYieldManagerHarness);
            const Manager = await ethers.getContractFactory("SafeYieldManager");
            const manager = await Manager.deploy(
                await f.reg.getAddress(),
                f.usdcAddr,
                f.wethAddr,
                [UNISWAP_V3],
                [await f.uniHandler.getAddress()],
                [[FEE_TIER]],
                [0],
                [0],
                [
                    {
                        token: f.wethAddr,
                        config: { pool: f.uniPoolAddr, window: TWAP_WINDOW, minCardinality: TWAP_CARDINALITY },
                    },
                ],
                f.treasury.address,
                0,
                10_000,
                10_000,
                f.deployer.address,
                await f.timelock.getAddress(),
                f.pauser.address,
            );
            await manager.waitForDeployment();

            await (await manager.connect(f.operatorEOA).openLp(UNISWAP_V3, openParams(f.safeAddr, FEE_TIER))).wait();
            await (await f.uniNpm.setOwed(1, 0, 40_000n)).wait();

            const safeBefore = await f.usdc.balanceOf(f.safeAddr);
            await expect(manager.connect(f.operatorEOA).collectLp(UNISWAP_V3, collectParams(f.safeAddr, 1, FEE_TIER)))
                .to.emit(manager, "FeesCollected")
                .withArgs(f.safeAddr, UNISWAP_V3, 1n, anyValue, 0n, 0n, anyValue, 40_000n, 40_000n);
            expect(await f.usdc.balanceOf(f.treasury.address)).to.equal(40_000n);
            expect(await f.usdc.balanceOf(f.safeAddr)).to.equal(safeBefore);
        });
    });

    describe("setter edge cases", function () {
        it("setTreasury rejects the zero address", async function () {
            const { manager, timelock } = await loadFixture(deployYieldManagerHarness);
            await expect(timelockCall(timelock, manager, "setTreasury", [ZERO])).to.be.revertedWithCustomError(
                manager,
                "InvalidTreasury",
            );
        });

        it("setFeeCollectBps bounds and updates", async function () {
            const { manager, timelock } = await loadFixture(deployYieldManagerHarness);
            await expect(
                timelockCall(timelock, manager, "setFeeCollectBps", [MAX_FEE_BPS + 1]),
            ).to.be.revertedWithCustomError(manager, "FeeAboveMax");
            await expect(timelockCall(timelock, manager, "setFeeCollectBps", [100]))
                .to.emit(manager, "FeeCollectBpsUpdated")
                .withArgs(COLLECT_FEE_BPS, 100);
            expect(await manager.feeCollectBps()).to.equal(100);
        });

        it("admin-only setters reject non-admins", async function () {
            const { manager, stranger, usdcAddr } = await loadFixture(deployYieldManagerHarness);
            const calls = [
                manager.connect(stranger).setPoolParamAllowed(UNISWAP_V3, FEE_TIER, true),
                manager.connect(stranger).setMinPoolLiquidity(UNISWAP_V3, 1),
                manager.connect(stranger).setMinPositionLiquidity(UNISWAP_V3, 1),
                manager.connect(stranger).setPauser(stranger.address),
                manager.connect(stranger).rescueToken(usdcAddr, stranger.address, 1),
                manager.connect(stranger).rescueERC721(usdcAddr, 1, stranger.address),
            ];
            for (const call of calls) {
                await expect(call).to.be.revertedWithCustomError(manager, "AccessControlUnauthorizedAccount");
            }
        });

        it("setPauser validates and rotates", async function () {
            const { manager, deployer, stranger } = await loadFixture(deployYieldManagerHarness);
            await expect(manager.connect(deployer).setPauser(ZERO)).to.be.revertedWithCustomError(
                manager,
                "ZeroAddress",
            );
            await expect(manager.connect(deployer).setPauser(stranger.address)).to.emit(manager, "PauserUpdated");
            await expect(manager.connect(stranger).pause()).to.emit(manager, "Paused");
        });

        it("rescue functions reject zero token and recipient", async function () {
            const { manager, deployer, stranger, usdcAddr } = await loadFixture(deployYieldManagerHarness);
            await expect(
                manager.connect(deployer).rescueToken(ZERO, stranger.address, 1),
            ).to.be.revertedWithCustomError(manager, "ZeroAddress");
            await expect(manager.connect(deployer).rescueToken(usdcAddr, ZERO, 1)).to.be.revertedWithCustomError(
                manager,
                "ZeroAddress",
            );
            await expect(
                manager.connect(deployer).rescueERC721(ZERO, 1, stranger.address),
            ).to.be.revertedWithCustomError(manager, "ZeroAddress");
            await expect(manager.connect(deployer).rescueERC721(usdcAddr, 1, ZERO)).to.be.revertedWithCustomError(
                manager,
                "ZeroAddress",
            );
        });

        it("setProtocolEnabledForClose requires a registered handler", async function () {
            const { manager, pauser } = await loadFixture(deployYieldManagerHarness);
            await expect(manager.connect(pauser).setProtocolEnabledForClose(200, true)).to.be.revertedWithCustomError(
                manager,
                "HandlerNotSet",
            );
        });

        it("unpause rejects non-pausers", async function () {
            const { manager, stranger } = await loadFixture(deployYieldManagerHarness);
            await expect(manager.connect(stranger).unpause()).to.be.revertedWithCustomError(manager, "NotAuthorized");
        });
    });

    describe("arbitrary pairs (two-leg swaps)", function () {
        async function deployNonUsdcPair(harness: { manager: any; deployer: any; uniFactory: any; reg: any }) {
            const ERC = await ethers.getContractFactory("MockERC20");
            const a = await ERC.deploy("Wrapped BTC", "WBTC", 8);
            const b = await ERC.deploy("Tether USD", "USDT", 6);
            await a.waitForDeployment();
            await b.waitForDeployment();
            const [tokenX, tokenY] =
                (await a.getAddress()).toLowerCase() < (await b.getAddress()).toLowerCase() ? [a, b] : [b, a];
            const xAddr = await tokenX.getAddress();
            const yAddr = await tokenY.getAddress();

            const LP_PARAM = encodeUniV3PoolParam(xAddr, yAddr, 500);
            const Pool = await ethers.getContractFactory("MockUniswapV3Pool");
            const lpPool = await Pool.deploy(xAddr, yAddr, Q96, 10n ** 18n);
            await (await harness.uniFactory.setPoolFor(xAddr, yAddr, 500, await lpPool.getAddress())).wait();
            await (await harness.reg.setWhitelisted(xAddr, true)).wait();
            await (await harness.reg.setWhitelisted(yAddr, true)).wait();
            return { tokenX, tokenY, xAddr, yAddr, LP_PARAM, Pool };
        }

        it("reverts the whole open when a token rejects the final approval reset", async function () {
            const { manager, operatorEOA, safeAddr, weth, uniNpm, uniHandler } =
                await loadFixture(deployYieldManagerHarness);

            await (await weth.setFalseApproveZero(true)).wait();
            await expect(
                manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER)),
            ).to.be.revertedWithCustomError(uniHandler, "TokenApprovalFailed");

            // The revert rolls the mint and the initial router approval back.
            expect(await uniNpm.nextId()).to.equal(1n);
            expect(await weth.allowance(safeAddr, await uniNpm.getAddress())).to.equal(0n);
        });

        it("opens and closes a non-USDC pair position by swapping both legs through USDC", async function () {
            const harness = await loadFixture(deployYieldManagerHarness);
            const {
                manager,
                deployer,
                timelock,
                operatorEOA,
                safeAddr,
                usdc,
                usdcAddr,
                uniFactory,
                uniNpm,
                uniRouter,
            } = harness;
            const { tokenX, tokenY, xAddr, yAddr, LP_PARAM, Pool } = await deployNonUsdcPair(harness);

            const [swapX0, swapX1] =
                xAddr.toLowerCase() < usdcAddr.toLowerCase() ? [xAddr, usdcAddr] : [usdcAddr, xAddr];
            const [swapY0, swapY1] =
                yAddr.toLowerCase() < usdcAddr.toLowerCase() ? [yAddr, usdcAddr] : [usdcAddr, yAddr];
            const SWAP_X_PARAM = encodeUniV3PoolParam(swapX0, swapX1, 500);
            const SWAP_Y_PARAM = encodeUniV3PoolParam(swapY0, swapY1, 500);

            const xPool = await Pool.deploy(swapX0, swapX1, Q96, 10n ** 18n);
            const yPool = await Pool.deploy(swapY0, swapY1, Q96, 10n ** 18n);
            await (await uniFactory.setPoolFor(swapX0, swapX1, 500, await xPool.getAddress())).wait();
            await (await uniFactory.setPoolFor(swapY0, swapY1, 500, await yPool.getAddress())).wait();

            for (const [token, pool] of [
                [xAddr, xPool],
                [yAddr, yPool],
            ] as const) {
                await (
                    await timelockCall(timelock, manager, "setTwapConfig", [
                        token,
                        await pool.getAddress(),
                        TWAP_WINDOW,
                        TWAP_CARDINALITY,
                    ])
                ).wait();
            }
            for (const param of [LP_PARAM, SWAP_X_PARAM, SWAP_Y_PARAM]) {
                await (await manager.connect(deployer).setPoolParamAllowed(UNISWAP_V3, param, true)).wait();
            }

            const X_OUT = 3_000n;
            const Y_OUT = 480_000n;
            for (const token of [tokenX, tokenY]) {
                await (await token.mint(await uniRouter.getAddress(), 10n ** 18n)).wait();
                await (await token.mint(await uniNpm.getAddress(), 10n ** 18n)).wait();
            }
            await (await uniRouter.setOutputFor(xAddr, X_OUT)).wait();
            await (await uniRouter.setOutputFor(yAddr, Y_OUT)).wait();

            await expect(
                manager.connect(operatorEOA).openLp(
                    UNISWAP_V3,
                    openParams(safeAddr, LP_PARAM, {
                        swap0: leg(X_OUT, SWAP_X_PARAM),
                        swap1: leg(Y_OUT, SWAP_Y_PARAM),
                    }),
                ),
            )
                .to.emit(manager, "PositionOpened")
                .withArgs(safeAddr, UNISWAP_V3, 1n, USDC_AMOUNT, X_OUT, Y_OUT, USDC_AMOUNT);
            expect(await manager.residualBasisUsd6Of(UNISWAP_V3, 1)).to.equal(USDC_AMOUNT);
            expect(await uniNpm.ownerOf(1)).to.equal(safeAddr);

            const safeUsdcBefore = await usdc.balanceOf(safeAddr);
            await (await uniRouter.setOutputFor(usdcAddr, 450_000n)).wait();
            await expect(
                manager.connect(operatorEOA).closeLp(
                    UNISWAP_V3,
                    closeParams(safeAddr, 1, LP_PARAM, {
                        swap0: leg(450_000n, SWAP_X_PARAM),
                        swap1: leg(450_000n, SWAP_Y_PARAM),
                    }),
                ),
            )
                .to.emit(manager, "PositionClosed")
                .withArgs(safeAddr, UNISWAP_V3, 1n, USDC_AMOUNT, 900_000n, 0n, 10_000, 0n);

            expect((await usdc.balanceOf(safeAddr)) - safeUsdcBefore).to.equal(900_000n);
            expect(await tokenX.balanceOf(safeAddr)).to.equal(0);
            expect(await tokenY.balanceOf(safeAddr)).to.equal(0);
            expect(await manager.residualBasisUsd6Of(UNISWAP_V3, 1)).to.equal(0);
            expect(await uniNpm.ownerOf(1)).to.equal(ZERO);
        });

        it("handles a pair where USDC itself is token0 (skips leg0, swaps only leg1)", async function () {
            const {
                manager,
                deployer,
                timelock,
                operatorEOA,
                safeAddr,
                usdc,
                usdcAddr,
                uniFactory,
                uniNpm,
                uniRouter,
                reg,
            } = await loadFixture(deployYieldManagerHarness);

            // Mock deploy addresses are nonce-derived and can land anywhere, so
            // place MockERC20 code at usdc + 1 directly — deterministically the
            // next address up, making USDC token0 of the pair.
            const highAddr = ethers.getAddress(ethers.toBeHex(BigInt(usdcAddr) + 1n, 20));
            await ethers.provider.send("hardhat_setCode", [highAddr, await ethers.provider.getCode(usdcAddr)]);
            const high = await ethers.getContractAt("MockERC20", highAddr);

            const LP_PARAM = encodeUniV3PoolParam(usdcAddr, highAddr, 500);
            const Pool = await ethers.getContractFactory("MockUniswapV3Pool");
            const lpPool = await Pool.deploy(usdcAddr, highAddr, Q96, 10n ** 18n);
            await (await uniFactory.setPoolFor(usdcAddr, highAddr, 500, await lpPool.getAddress())).wait();
            await (await reg.setWhitelisted(highAddr, true)).wait();
            await (
                await timelockCall(timelock, manager, "setTwapConfig", [
                    highAddr,
                    await lpPool.getAddress(),
                    TWAP_WINDOW,
                    TWAP_CARDINALITY,
                ])
            ).wait();
            await (await manager.connect(deployer).setPoolParamAllowed(UNISWAP_V3, LP_PARAM, true)).wait();

            const HIGH_OUT = 400_000n;
            await (await high.mint(await uniRouter.getAddress(), 10n ** 24n)).wait();
            await (await high.mint(await uniNpm.getAddress(), 10n ** 24n)).wait();
            await (await uniRouter.setOutputFor(highAddr, HIGH_OUT)).wait();

            // token0 == USDC → swap0 is the ignored zero leg; the LP pool doubles
            // as the USDC/high swap venue for leg1.
            await expect(
                manager.connect(operatorEOA).openLp(
                    UNISWAP_V3,
                    openParams(safeAddr, LP_PARAM, {
                        swap0: ZERO_LEG,
                        swap1: leg(HIGH_OUT, LP_PARAM),
                    }),
                ),
            )
                .to.emit(manager, "PositionOpened")
                .withArgs(safeAddr, UNISWAP_V3, 1n, USDC_AMOUNT, HALF, HIGH_OUT, USDC_AMOUNT);

            await (await uniNpm.setOwed(1, 30_000n, 10_000n)).wait();
            await (await uniRouter.setOutputFor(usdcAddr, 9_000n)).wait();
            await expect(
                manager.connect(operatorEOA).collectLp(
                    UNISWAP_V3,
                    collectParams(safeAddr, 1, LP_PARAM, {
                        swapFeesToUsdc: true,
                        swap0: ZERO_LEG,
                        swap1: leg(9_000n, LP_PARAM),
                    }),
                ),
            ).to.emit(manager, "FeesCollected");
            expect(await high.balanceOf(safeAddr)).to.equal(0);

            const safeUsdcBefore = await usdc.balanceOf(safeAddr);
            await (await uniRouter.setOutputFor(usdcAddr, 450_000n)).wait();
            await expect(
                manager.connect(operatorEOA).closeLp(
                    UNISWAP_V3,
                    closeParams(safeAddr, 1, LP_PARAM, {
                        swap0: ZERO_LEG,
                        swap1: leg(450_000n, LP_PARAM),
                    }),
                ),
            )
                .to.emit(manager, "PositionClosed")
                .withArgs(safeAddr, UNISWAP_V3, 1n, USDC_AMOUNT, HALF + 450_000n, 0n, 10_000, 0n);
            expect((await usdc.balanceOf(safeAddr)) - safeUsdcBefore).to.equal(HALF + 450_000n);
            expect(await high.balanceOf(safeAddr)).to.equal(0);
        });

        it("rejects a leg whose swap pool does not contain USDC", async function () {
            const harness = await loadFixture(deployYieldManagerHarness);
            const { manager, deployer, timelock, operatorEOA, safeAddr, usdcAddr, uniRouter } = harness;
            const { xAddr, yAddr, LP_PARAM, Pool } = await deployNonUsdcPair(harness);
            for (const token of [xAddr, yAddr]) {
                const [r0, r1] = token.toLowerCase() < usdcAddr.toLowerCase() ? [token, usdcAddr] : [usdcAddr, token];
                const reference = await Pool.deploy(r0, r1, Q96, 10n ** 18n);
                await (
                    await timelockCall(timelock, manager, "setTwapConfig", [
                        token,
                        await reference.getAddress(),
                        TWAP_WINDOW,
                        TWAP_CARDINALITY,
                    ])
                ).wait();
            }
            await (await manager.connect(deployer).setPoolParamAllowed(UNISWAP_V3, LP_PARAM, true)).wait();
            await (await uniRouter.setOutputFor(xAddr, 1n)).wait();
            await (await uniRouter.setOutputFor(yAddr, 1n)).wait();

            // Both legs route through the X/Y pool itself — it never trades
            // USDC, so the leg validation must refuse it for both sides.
            await expect(
                manager.connect(operatorEOA).openLp(
                    UNISWAP_V3,
                    openParams(safeAddr, LP_PARAM, {
                        swap0: leg(1n, LP_PARAM),
                        swap1: leg(1n, LP_PARAM),
                    }),
                ),
            ).to.be.revertedWithCustomError(manager, "WrongTokenPair");
        });
    });

    describe("switchLp", function () {
        function switchParams(
            safeAddr: string,
            tokenId: bigint | number,
            openPoolParam: string,
            overrides: Record<string, any> = {},
        ) {
            return {
                onBehalfOf: safeAddr,
                tokenId,
                decreaseAmount0Min: 0,
                decreaseAmount1Min: 0,
                tickLower: -100,
                tickUpper: 100,
                mintAmount0Min: 0,
                mintAmount1Min: 0,
                lpPoolParam: openPoolParam,
                deadline: DEADLINE,
                ...overrides,
            };
        }

        it("moves a position across protocols in kind, carrying the basis without swaps or fee", async function () {
            const {
                manager,
                operatorEOA,
                safeAddr,
                treasury,
                usdc,
                weth,
                uniNpm,
                clNpm,
                uniRouter,
                clRouter,
                aeroHandler,
            } = await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            const uniRouterWethBefore = await weth.balanceOf(await uniRouter.getAddress());
            const clRouterWethBefore = await weth.balanceOf(await clRouter.getAddress());

            await expect(
                manager.connect(operatorEOA).switchLp(UNISWAP_V3, AERODROME, switchParams(safeAddr, 1, TICK_SPACING)),
            )
                .to.emit(manager, "PositionSwitched")
                .withArgs(safeAddr, UNISWAP_V3, AERODROME, 1n, 1n, USDC_AMOUNT, WETH_OUT, HALF, WETH_OUT, HALF);

            expect(await manager.residualBasisUsd6Of(UNISWAP_V3, 1)).to.equal(0);
            expect(await manager.positionHandlerOf(UNISWAP_V3, 1)).to.equal(ZERO);
            expect(await manager.residualBasisUsd6Of(AERODROME, 1)).to.equal(USDC_AMOUNT);
            expect(await manager.positionHandlerOf(AERODROME, 1)).to.equal(await aeroHandler.getAddress());
            expect(await uniNpm.ownerOf(1)).to.equal(ZERO);
            expect(await clNpm.ownerOf(1)).to.equal(safeAddr);
            expect(await weth.balanceOf(await uniRouter.getAddress())).to.equal(uniRouterWethBefore);
            expect(await weth.balanceOf(await clRouter.getAddress())).to.equal(clRouterWethBefore);
            expect(await usdc.balanceOf(treasury.address)).to.equal(0);
        });

        it("reverts TokenNotWhitelisted when the switch destination pool token is de-listed", async function () {
            const { manager, operatorEOA, safeAddr, reg, wethAddr } = await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();

            await (await reg.setWhitelisted(wethAddr, false)).wait();
            await expect(
                manager.connect(operatorEOA).switchLp(UNISWAP_V3, AERODROME, switchParams(safeAddr, 1, TICK_SPACING)),
            )
                .to.be.revertedWithCustomError(manager, "TokenNotWhitelisted")
                .withArgs(wethAddr);
        });

        it("settles the performance fee against the original basis at the real exit", async function () {
            const { manager, operatorEOA, safeAddr, treasury, usdc, clRouter } =
                await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            await (
                await manager
                    .connect(operatorEOA)
                    .switchLp(UNISWAP_V3, AERODROME, switchParams(safeAddr, 1, TICK_SPACING))
            ).wait();

            await (await clRouter.setOutput(600_000n)).wait();
            await expect(
                manager.connect(operatorEOA).closeLp(
                    AERODROME,
                    closeParams(safeAddr, 1, TICK_SPACING, {
                        swap0: leg(600_000n, TICK_SPACING),
                    }),
                ),
            )
                .to.emit(manager, "PositionClosed")
                .withArgs(safeAddr, AERODROME, 1n, USDC_AMOUNT, 1_100_000n, 10_000n, 10_000, 0n);
            expect(await usdc.balanceOf(treasury.address)).to.equal(10_000n);
        });

        it("supports switching pool params within the same protocol", async function () {
            const { manager, deployer, operatorEOA, safeAddr, uniNpm } = await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(deployer).setPoolParamAllowed(UNISWAP_V3, BAD_FEE_TIER, true)).wait();
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();

            await expect(
                manager.connect(operatorEOA).switchLp(UNISWAP_V3, UNISWAP_V3, switchParams(safeAddr, 1, BAD_FEE_TIER)),
            )
                .to.emit(manager, "PositionSwitched")
                .withArgs(safeAddr, UNISWAP_V3, UNISWAP_V3, 1n, 2n, USDC_AMOUNT, WETH_OUT, HALF, WETH_OUT, HALF);
            expect(await manager.residualBasisUsd6Of(UNISWAP_V3, 2)).to.equal(USDC_AMOUNT);
            expect(await uniNpm.ownerOf(2)).to.equal(safeAddr);
        });

        it("moves a position from Aerodrome back to Uniswap V3", async function () {
            const { manager, operatorEOA, safeAddr, clNpm, uniNpm, uniHandler } =
                await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(AERODROME, openParams(safeAddr, TICK_SPACING))).wait();

            await expect(
                manager.connect(operatorEOA).switchLp(AERODROME, UNISWAP_V3, switchParams(safeAddr, 1, FEE_TIER)),
            ).to.emit(manager, "PositionSwitched");

            expect(await clNpm.ownerOf(1)).to.equal(ZERO);
            expect(await uniNpm.ownerOf(1)).to.equal(safeAddr);
            expect(await manager.residualBasisUsd6Of(AERODROME, 1)).to.equal(0);
            expect(await manager.residualBasisUsd6Of(UNISWAP_V3, 1)).to.equal(USDC_AMOUNT);
            expect(await manager.positionHandlerOf(UNISWAP_V3, 1)).to.equal(await uniHandler.getAddress());
        });

        it("rolls the withdraw leg and bookkeeping back when the replacement open fails", async function () {
            const { manager, operatorEOA, stranger, safeAddr, uniNpm, clNpm } =
                await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            await (await clNpm.setMintOwnerOverride(stranger.address)).wait();

            await expect(
                manager.connect(operatorEOA).switchLp(UNISWAP_V3, AERODROME, switchParams(safeAddr, 1, TICK_SPACING)),
            ).to.be.revertedWithCustomError(manager, "LpNotOnSafe");

            expect(await uniNpm.ownerOf(1)).to.equal(safeAddr);
            expect(await manager.residualBasisUsd6Of(UNISWAP_V3, 1)).to.equal(USDC_AMOUNT);
            expect(await manager.positionHandlerOf(UNISWAP_V3, 1)).to.not.equal(ZERO);
            expect(await clNpm.nextId()).to.equal(1);
        });

        // ─────────────────────────────────────────────────────────────
        //  M-02: residue an in-kind switch could not redeploy
        // ─────────────────────────────────────────────────────────────

        // With mint usage at 50%, the destination consumes half of each side
        // and the rest lands on the Safe: 1_000_000 wei of WETH and 250_000
        // USDC. The reference sits at tick 0, so the WETH side values 1:1 and
        // the residue is worth 1_250_000 against a 1_000_000 basis.
        const HALF_USAGE_RESIDUE_WETH = WETH_OUT / 2n;
        const HALF_USAGE_RESIDUE_USDC = HALF / 2n;
        const HALF_USAGE_RESIDUE_USD6 = HALF_USAGE_RESIDUE_WETH + HALF_USAGE_RESIDUE_USDC;

        it("books residue above the basis as carried profit", async function () {
            const { manager, operatorEOA, safeAddr, treasury, usdc, weth, clNpm } =
                await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            await (await clNpm.setMintUsageBps(5_000)).wait();
            const safeUsdcBefore = await usdc.balanceOf(safeAddr);

            const carry = HALF_USAGE_RESIDUE_USD6 - USDC_AMOUNT;
            await expect(
                manager.connect(operatorEOA).switchLp(UNISWAP_V3, AERODROME, switchParams(safeAddr, 1, TICK_SPACING)),
            )
                .to.emit(manager, "SwitchResidueSettled")
                .withArgs(
                    safeAddr,
                    AERODROME,
                    1n,
                    HALF_USAGE_RESIDUE_WETH,
                    HALF_USAGE_RESIDUE_USDC,
                    HALF_USAGE_RESIDUE_USD6,
                    0n,
                    carry,
                );

            // The residue repaid the whole basis, so the replacement position
            // starts with none and owes a fee on the excess instead.
            expect(await manager.residualBasisUsd6Of(AERODROME, 1)).to.equal(0);
            expect(await manager.carryProfitUsd6Of(AERODROME, 1)).to.equal(carry);
            expect(await weth.balanceOf(safeAddr)).to.equal(HALF_USAGE_RESIDUE_WETH);
            expect((await usdc.balanceOf(safeAddr)) - safeUsdcBefore).to.equal(HALF_USAGE_RESIDUE_USDC);
            // Nothing is charged at the switch itself; the fee is settled on exit.
            expect(await usdc.balanceOf(treasury.address)).to.equal(0);
        });

        async function runPinnedCarryVector(finalValue: bigint) {
            const f = await loadFixture(deployYieldManagerHarness);
            const { manager, operatorEOA, safeAddr, treasury, usdc, uniNpm, clNpm, clRouter } = f;
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();

            // Audit vector: B=1,000,000; R=2,000,000; D=500,000.
            // The mock position exits entirely as token0 and the destination
            // consumes 25%, leaving U=1,500,000 on the Safe.
            await (await uniNpm.setPrincipal(1, 2_000_000n, 0n)).wait();
            await (await clNpm.setMintUsageBps(2_500)).wait();
            const treasuryBeforeSwitch = await usdc.balanceOf(treasury.address);
            await expect(
                manager.connect(operatorEOA).switchLp(UNISWAP_V3, AERODROME, switchParams(safeAddr, 1, TICK_SPACING)),
            )
                .to.emit(manager, "SwitchResidueSettled")
                .withArgs(safeAddr, AERODROME, 1n, 1_500_000n, 0n, 1_500_000n, 0n, 500_000n);
            expect(await usdc.balanceOf(treasury.address)).to.equal(treasuryBeforeSwitch);
            expect(await manager.residualBasisUsd6Of(UNISWAP_V3, 1)).to.equal(0n);
            expect(await manager.carryProfitUsd6Of(UNISWAP_V3, 1)).to.equal(0n);
            expect(await manager.residualBasisUsd6Of(AERODROME, 1)).to.equal(0n);
            expect(await manager.carryProfitUsd6Of(AERODROME, 1)).to.equal(500_000n);

            await (await clRouter.setOutput(finalValue)).wait();
            const treasuryBeforeClose = await usdc.balanceOf(treasury.address);
            const receipt = await (
                await manager
                    .connect(operatorEOA)
                    .closeLp(AERODROME, closeParams(safeAddr, 1, TICK_SPACING, { swap0: leg(0, TICK_SPACING) }))
            ).wait();
            const closed = receipt!.logs
                .map((log: any) => {
                    try {
                        return manager.interface.parseLog(log);
                    } catch {
                        return null;
                    }
                })
                .find((event: any) => event?.name === "PositionClosed")!;
            const expectedProfit = finalValue + 500_000n;
            const expectedFee = (expectedProfit * PERF_FEE_BPS) / 10_000n;
            expect(closed.args.basisUsd6).to.equal(0n);
            expect(closed.args.currentValueUsd6).to.equal(finalValue);
            expect(closed.args.carryForExitUsd6).to.equal(500_000n);
            expect(closed.args.feeUsd6).to.equal(expectedFee);
            expect((await usdc.balanceOf(treasury.address)) - treasuryBeforeClose).to.equal(expectedFee);
            expect(await manager.carryProfitUsd6Of(AERODROME, 1)).to.equal(0n);
        }

        it("matches the pinned carry vector when the replacement closes at 500,000", async function () {
            await runPinnedCarryVector(500_000n);
        });

        it("reflects replacement loss when the pinned vector closes at 100,000", async function () {
            await runPinnedCarryVector(100_000n);
        });

        it("preserves the lifecycle invariant across seeded multi-switch sequences", async function () {
            // Deterministic generated cases make failures reproducible while
            // covering different hop counts and integer divisions.
            let seed = 0x4817n;
            const next = () => {
                seed = (seed * 1_103_515_245n + 12_345n) & 0x7fff_ffffn;
                return seed;
            };

            for (let caseIndex = 0; caseIndex < 6; caseIndex++) {
                const f = await loadFixture(deployYieldManagerHarness);
                const { manager, operatorEOA, safeAddr, treasury, usdc, uniNpm, clNpm, uniRouter, clRouter } = f;
                await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();

                let protocol = UNISWAP_V3;
                let tokenId = 1n;
                let basis = USDC_AMOUNT;
                let carry = 0n;
                let totalResidue = 0n;
                const hopCount = 1 + Number(next() % 3n);

                for (let hop = 0; hop < hopCount; hop++) {
                    const realized = 1_000_000n + (next() % 1_000_001n);
                    const usageBps = 2_000n + (next() % 7_501n);
                    const destination = protocol === UNISWAP_V3 ? AERODROME : UNISWAP_V3;
                    const sourceNpm = protocol === UNISWAP_V3 ? uniNpm : clNpm;
                    const destinationNpm = destination === UNISWAP_V3 ? uniNpm : clNpm;
                    await (await sourceNpm.setPrincipal(tokenId, realized, 0n)).wait();
                    await (await destinationNpm.setMintUsageBps(usageBps)).wait();

                    const destinationParam = destination === UNISWAP_V3 ? FEE_TIER : TICK_SPACING;
                    const receipt = await (
                        await manager
                            .connect(operatorEOA)
                            .switchLp(protocol, destination, switchParams(safeAddr, tokenId, destinationParam))
                    ).wait();
                    const switched = receipt!.logs
                        .map((log: any) => {
                            try {
                                return manager.interface.parseLog(log);
                            } catch {
                                return null;
                            }
                        })
                        .find((event: any) => event?.name === "PositionSwitched")!;
                    const deployed = (realized * usageBps) / 10_000n;
                    const residue = realized - deployed;
                    totalResidue += residue;
                    if (residue >= basis) {
                        carry += residue - basis;
                        basis = 0n;
                    } else {
                        basis -= residue;
                    }

                    expect(await manager.residualBasisUsd6Of(destination, switched.args.newTokenId)).to.equal(basis);
                    expect(await manager.carryProfitUsd6Of(destination, switched.args.newTokenId)).to.equal(carry);
                    expect(await manager.residualBasisUsd6Of(protocol, tokenId)).to.equal(0n);
                    expect(await manager.carryProfitUsd6Of(protocol, tokenId)).to.equal(0n);
                    protocol = destination;
                    tokenId = switched.args.newTokenId;
                }

                const finalValue = 1_000_000n + (next() % 500_001n);
                const closeRouter = protocol === UNISWAP_V3 ? uniRouter : clRouter;
                const closeParam = protocol === UNISWAP_V3 ? FEE_TIER : TICK_SPACING;
                await (await closeRouter.setOutput(finalValue)).wait();
                const treasuryBefore = await usdc.balanceOf(treasury.address);
                const receipt = await (
                    await manager
                        .connect(operatorEOA)
                        .closeLp(protocol, closeParams(safeAddr, tokenId, closeParam, { swap0: leg(0, closeParam) }))
                ).wait();
                const closed = receipt!.logs
                    .map((log: any) => {
                        try {
                            return manager.interface.parseLog(log);
                        } catch {
                            return null;
                        }
                    })
                    .find((event: any) => event?.name === "PositionClosed")!;
                const lifecycleProfit =
                    totalResidue + finalValue > USDC_AMOUNT ? totalResidue + finalValue - USDC_AMOUNT : 0n;
                const expectedFee = (lifecycleProfit * PERF_FEE_BPS) / 10_000n;
                expect(closed.args.feeUsd6).to.equal(expectedFee);
                expect((await usdc.balanceOf(treasury.address)) - treasuryBefore).to.equal(expectedFee);
                expect(await manager.residualBasisUsd6Of(protocol, tokenId)).to.equal(0n);
                expect(await manager.carryProfitUsd6Of(protocol, tokenId)).to.equal(0n);
            }
        });

        it("repays basis first when the residue is smaller than it", async function () {
            const { manager, operatorEOA, safeAddr, clNpm } = await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            await (await clNpm.setMintUsageBps(9_000)).wait();

            // 10% of each side left behind: 200_000 wei WETH + 50_000 USDC.
            const residue = WETH_OUT / 10n + HALF / 10n;
            await (
                await manager
                    .connect(operatorEOA)
                    .switchLp(UNISWAP_V3, AERODROME, switchParams(safeAddr, 1, TICK_SPACING))
            ).wait();

            expect(await manager.residualBasisUsd6Of(AERODROME, 1)).to.equal(USDC_AMOUNT - residue);
            expect(await manager.carryProfitUsd6Of(AERODROME, 1)).to.equal(0);
        });

        it("needs no price at all when the switch redeploys everything", async function () {
            const { manager, operatorEOA, safeAddr, uniPool } = await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            await (await uniPool.setObserveReverts(true)).wait();

            await (
                await manager
                    .connect(operatorEOA)
                    .switchLp(UNISWAP_V3, AERODROME, switchParams(safeAddr, 1, TICK_SPACING))
            ).wait();
            expect(await manager.residualBasisUsd6Of(AERODROME, 1)).to.equal(USDC_AMOUNT);
            expect(await manager.carryProfitUsd6Of(AERODROME, 1)).to.equal(0);
        });

        it("refuses to guess at a residue it cannot price", async function () {
            const { manager, operatorEOA, safeAddr, uniPool, clNpm } = await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            await (await clNpm.setMintUsageBps(5_000)).wait();
            await (await uniPool.setObserveReverts(true)).wait();

            await expect(
                manager.connect(operatorEOA).switchLp(UNISWAP_V3, AERODROME, switchParams(safeAddr, 1, TICK_SPACING)),
            ).to.be.revertedWith("OLD");
        });

        it("charges the carried profit at the eventual close", async function () {
            const { manager, operatorEOA, safeAddr, treasury, usdc, clNpm, clRouter } =
                await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            await (await clNpm.setMintUsageBps(5_000)).wait();
            await (
                await manager
                    .connect(operatorEOA)
                    .switchLp(UNISWAP_V3, AERODROME, switchParams(safeAddr, 1, TICK_SPACING))
            ).wait();
            const carry = await manager.carryProfitUsd6Of(AERODROME, 1);
            expect(carry).to.be.greaterThan(0);

            await (await clRouter.setOutput(600_000n)).wait();
            const treasuryBefore = await usdc.balanceOf(treasury.address);
            const receipt = await (
                await manager
                    .connect(operatorEOA)
                    .closeLp(AERODROME, closeParams(safeAddr, 1, TICK_SPACING, { swap0: leg(600_000n, TICK_SPACING) }))
            ).wait();

            const closed = receipt!.logs
                .map((l: any) => {
                    try {
                        return manager.interface.parseLog(l);
                    } catch {
                        return null;
                    }
                })
                .find((e: any) => e && e.name === "PositionClosed")!;
            const [, , , basisForExit, currentValue, feeUsd6, , carryForExit] = closed.args as unknown as [
                string,
                bigint,
                bigint,
                bigint,
                bigint,
                bigint,
                bigint,
                bigint,
            ];

            expect(basisForExit).to.equal(0);
            expect(carryForExit).to.equal(carry);
            // The fee follows lifecycle profit, not just this exit's proceeds.
            const expectedFee = ((currentValue + carryForExit - basisForExit) * PERF_FEE_BPS) / 10_000n;
            expect(feeUsd6).to.equal(expectedFee);
            expect((await usdc.balanceOf(treasury.address)) - treasuryBefore).to.equal(expectedFee);
            expect(await manager.carryProfitUsd6Of(AERODROME, 1)).to.equal(0);
        });

        it("prorates the carried profit across a partial close", async function () {
            const { manager, operatorEOA, safeAddr, clNpm, clRouter } = await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            await (await clNpm.setMintUsageBps(5_000)).wait();
            await (
                await manager
                    .connect(operatorEOA)
                    .switchLp(UNISWAP_V3, AERODROME, switchParams(safeAddr, 1, TICK_SPACING))
            ).wait();
            const carry = await manager.carryProfitUsd6Of(AERODROME, 1);

            await (await clRouter.setOutput(600_000n)).wait();
            await (
                await manager.connect(operatorEOA).closeLp(
                    AERODROME,
                    closeParams(safeAddr, 1, TICK_SPACING, {
                        exitBps: 5_000,
                        swap0: leg(600_000n, TICK_SPACING),
                    }),
                )
            ).wait();

            expect(await manager.carryProfitUsd6Of(AERODROME, 1)).to.equal(carry - carry / 2n);
        });

        it("accumulates carry across successive switches", async function () {
            const { manager, deployer, operatorEOA, safeAddr, uniNpm, clNpm } =
                await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(deployer).setPoolParamAllowed(UNISWAP_V3, BAD_FEE_TIER, true)).wait();
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();

            await (await clNpm.setMintUsageBps(5_000)).wait();
            await (
                await manager
                    .connect(operatorEOA)
                    .switchLp(UNISWAP_V3, AERODROME, switchParams(safeAddr, 1, TICK_SPACING))
            ).wait();
            const firstCarry = await manager.carryProfitUsd6Of(AERODROME, 1);
            expect(firstCarry).to.be.greaterThan(0);

            // Second hop: basis is already zero, so every unit of residue is
            // profit and the carry can only grow.
            await (await uniNpm.setMintUsageBps(5_000)).wait();
            await (
                await manager.connect(operatorEOA).switchLp(AERODROME, UNISWAP_V3, switchParams(safeAddr, 1, FEE_TIER))
            ).wait();

            expect(await manager.carryProfitUsd6Of(AERODROME, 1)).to.equal(0);
            expect(await manager.carryProfitUsd6Of(UNISWAP_V3, 2)).to.be.greaterThan(firstCarry);
            expect(await manager.residualBasisUsd6Of(UNISWAP_V3, 2)).to.equal(0);
        });

        it("enforces gating: pause, per-protocol switches, and missing handlers", async function () {
            const { manager, operatorEOA, pauser, safeAddr } = await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            const params = switchParams(safeAddr, 1, TICK_SPACING);
            const call = () => manager.connect(operatorEOA).switchLp(UNISWAP_V3, AERODROME, params);

            await (await manager.connect(pauser).pause()).wait();
            await expect(call()).to.be.revertedWithCustomError(manager, "EnforcedPause");
            await (await manager.connect(pauser).unpause()).wait();

            await (await manager.connect(pauser).setProtocolEnabledForClose(UNISWAP_V3, false)).wait();
            await expect(call()).to.be.revertedWithCustomError(manager, "ProtocolDisabled");
            await (await manager.connect(pauser).setProtocolEnabledForClose(UNISWAP_V3, true)).wait();

            await (await manager.connect(pauser).setProtocolEnabledForOpen(AERODROME, false)).wait();
            await expect(call()).to.be.revertedWithCustomError(manager, "ProtocolDisabled");
            await (await manager.connect(pauser).setProtocolEnabledForOpen(AERODROME, true)).wait();

            await expect(manager.connect(operatorEOA).switchLp(UNISWAP_V3, 200, params)).to.be.revertedWithCustomError(
                manager,
                "HandlerNotSet",
            );
        });

        it("rejects unauthorized callers, expired deadlines, and unknown positions", async function () {
            const { manager, operatorEOA, stranger, safeAddr } = await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();

            await expect(
                manager.connect(stranger).switchLp(UNISWAP_V3, AERODROME, switchParams(safeAddr, 1, TICK_SPACING)),
            ).to.be.revertedWithCustomError(manager, "NotAuthorized");
            await expect(
                manager
                    .connect(operatorEOA)
                    .switchLp(UNISWAP_V3, AERODROME, switchParams(safeAddr, 1, TICK_SPACING, { deadline: 1 })),
            ).to.be.revertedWithCustomError(manager, "DeadlineExpired");
            await expect(
                manager.connect(operatorEOA).switchLp(UNISWAP_V3, AERODROME, switchParams(safeAddr, 99, TICK_SPACING)),
            ).to.be.revertedWithCustomError(manager, "UnknownPosition");
        });

        it("enforces the withdraw leg's decrease minimums", async function () {
            const { manager, operatorEOA, safeAddr } = await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();

            await expect(
                manager
                    .connect(operatorEOA)
                    .switchLp(
                        UNISWAP_V3,
                        AERODROME,
                        switchParams(safeAddr, 1, TICK_SPACING, { decreaseAmount0Min: WETH_OUT + 1n }),
                    ),
            ).to.be.revertedWith("Price slippage check");
        });

        it("rejects a destination mint below the position-liquidity floor", async function () {
            const { manager, deployer, operatorEOA, safeAddr } = await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            await (await manager.connect(deployer).setMinPositionLiquidity(AERODROME, 2_000_000)).wait();

            await expect(
                manager.connect(operatorEOA).switchLp(UNISWAP_V3, AERODROME, switchParams(safeAddr, 1, TICK_SPACING)),
            ).to.be.revertedWithCustomError(manager, "PositionLiquidityTooLow");
        });

        it("rejects an in-kind open whose withdrawn tokens do not match the destination pool", async function () {
            const { manager, operatorEOA, safeAddr, uniNpm, wethAddr, usdcAddr } =
                await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();

            const ERC = await ethers.getContractFactory("MockERC20");
            const tokenC = await ERC.deploy("Token C", "TKC", 18);
            await tokenC.waitForDeployment();
            const tokenCAddr = await tokenC.getAddress();
            await (await tokenC.mint(await uniNpm.getAddress(), 10n ** 24n)).wait();

            // token0 mismatch: the withdrawal delivers tokenC, the destination trades WETH.
            await (await uniNpm.setTokens(1, tokenCAddr, usdcAddr)).wait();
            await expect(
                manager.connect(operatorEOA).switchLp(UNISWAP_V3, AERODROME, switchParams(safeAddr, 1, TICK_SPACING)),
            ).to.be.revertedWithCustomError(manager, "WrongTokenPair");

            // token1 mismatch: token0 lines up, so only the second side rejects it.
            await (await uniNpm.setTokens(1, wethAddr, tokenCAddr)).wait();
            await expect(
                manager.connect(operatorEOA).switchLp(UNISWAP_V3, AERODROME, switchParams(safeAddr, 1, TICK_SPACING)),
            ).to.be.revertedWithCustomError(manager, "WrongTokenPair");
        });

        it("withdraws a zero-liquidity position without a decrease and still switches", async function () {
            const { manager, operatorEOA, safeAddr, uniNpm, clNpm } = await loadFixture(deployYieldManagerHarness);
            await (await uniNpm.setMintLiquidity(0)).wait();
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();

            await expect(
                manager.connect(operatorEOA).switchLp(UNISWAP_V3, AERODROME, switchParams(safeAddr, 1, TICK_SPACING)),
            )
                .to.emit(manager, "PositionSwitched")
                .withArgs(safeAddr, UNISWAP_V3, AERODROME, 1n, 1n, USDC_AMOUNT, 0n, 0n, 0n, 0n);

            expect(await clNpm.ownerOf(1)).to.equal(safeAddr);
            expect(await manager.residualBasisUsd6Of(AERODROME, 1)).to.equal(USDC_AMOUNT);
        });

        it("blocks reentrant switchLp through a position-manager callback", async function () {
            const { manager, operatorEOA, safeAddr, uniNpm } = await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            await (
                await uniNpm.setCallback(
                    await manager.getAddress(),
                    manager.interface.encodeFunctionData("switchLp", [
                        UNISWAP_V3,
                        AERODROME,
                        switchParams(safeAddr, 1, TICK_SPACING),
                    ]),
                )
            ).wait();

            await expect(
                manager.connect(operatorEOA).switchLp(UNISWAP_V3, AERODROME, switchParams(safeAddr, 1, TICK_SPACING)),
            ).to.be.revertedWithCustomError(manager, "ReentrancyGuardReentrantCall");
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  H-01: reference TWAP
    // ─────────────────────────────────────────────────────────────────────

    describe("TwapOracle", function () {
        async function deployProbe() {
            const harness = await loadFixture(deployYieldManagerHarness);
            const Probe = await ethers.getContractFactory("TwapOracleProbe");
            const probe = await Probe.deploy();
            await probe.waitForDeployment();
            return { ...harness, probe, poolAddr: await harness.uniPool.getAddress() };
        }

        it("returns the pool's mean tick over the window", async function () {
            const { probe, uniPool, poolAddr } = await deployProbe();
            await (await uniPool.setTwapTick(-201_770)).wait();
            expect(await probe.meanTick(poolAddr, TWAP_WINDOW, TWAP_CARDINALITY)).to.equal(-201_770);
        });

        it("rounds a negative mean toward negative infinity", async function () {
            const { probe, uniPool, poolAddr } = await deployProbe();
            // -3 ticks over the window, one second short of an exact multiple:
            // truncation would give -2, which reads as a BETTER price for the
            // side being quoted than the pool actually traded at.
            await (await uniPool.setCumulativeDelta(-3n * BigInt(TWAP_WINDOW) + 1n)).wait();
            expect(await probe.meanTick(poolAddr, TWAP_WINDOW, TWAP_CARDINALITY)).to.equal(-3);
        });

        it("truncates a positive mean without adjustment", async function () {
            const { probe, uniPool, poolAddr } = await deployProbe();
            await (await uniPool.setCumulativeDelta(3n * BigInt(TWAP_WINDOW) + 1n)).wait();
            expect(await probe.meanTick(poolAddr, TWAP_WINDOW, TWAP_CARDINALITY)).to.equal(3);
        });

        it("refuses an unconfigured pool and a zero window", async function () {
            const { probe, poolAddr } = await deployProbe();
            await expect(
                probe.meanTick(ethers.ZeroAddress, TWAP_WINDOW, TWAP_CARDINALITY),
            ).to.be.revertedWithCustomError(probe, "TwapNotConfigured");
            await expect(probe.meanTick(poolAddr, 0, TWAP_CARDINALITY)).to.be.revertedWithCustomError(
                probe,
                "TwapWindowZero",
            );
        });

        it("refuses a pool whose observation array is too small to hold the window", async function () {
            const { probe, uniPool, poolAddr } = await deployProbe();
            await (await uniPool.setObservationCardinality(59)).wait();
            await expect(probe.meanTick(poolAddr, TWAP_WINDOW, 60))
                .to.be.revertedWithCustomError(probe, "TwapCardinalityTooLow")
                .withArgs(poolAddr, 59, 60);
        });

        // The case a bare `observe()` call cannot detect: an idle pool answers
        // without reverting, and every second of the window resolves after its
        // newest observation, so the "average" IS the live tick.
        it("refuses a pool whose newest observation is stale", async function () {
            const { probe, uniPool, poolAddr } = await deployProbe();
            const maxAge = TWAP_WINDOW / Number(await probe.maxStalenessDivisor());

            await (await uniPool.setObservationAge(maxAge)).wait();
            expect(await probe.meanTick(poolAddr, TWAP_WINDOW, TWAP_CARDINALITY)).to.equal(0);

            await (await uniPool.setObservationAge(maxAge + 1)).wait();
            await expect(probe.meanTick(poolAddr, TWAP_WINDOW, TWAP_CARDINALITY))
                .to.be.revertedWithCustomError(probe, "TwapObservationStale")
                .withArgs(poolAddr, maxAge + 1, maxAge);
        });

        it("lets the pool's own OLD revert through rather than falling back to spot", async function () {
            const { probe, uniPool, poolAddr } = await deployProbe();
            await (await uniPool.setObserveReverts(true)).wait();
            await expect(probe.meanTick(poolAddr, TWAP_WINDOW, TWAP_CARDINALITY)).to.be.revertedWith("OLD");
        });

        it("quotes both directions of the pair", async function () {
            const { probe, uniPool, poolAddr, wethAddr, usdcAddr } = await deployProbe();
            // token0 = WETH, token1 = USDC. Tick 0 is 1 raw unit for 1 raw unit.
            expect(await probe.quote(poolAddr, TWAP_WINDOW, TWAP_CARDINALITY, wethAddr, usdcAddr, 10n ** 9n)).to.equal(
                10n ** 9n,
            );
            expect(await probe.quote(poolAddr, TWAP_WINDOW, TWAP_CARDINALITY, usdcAddr, wethAddr, 10n ** 9n)).to.equal(
                10n ** 9n,
            );

            // One tick up is +1bp on token1 per token0, and the inverse holds.
            await (await uniPool.setTwapTick(1)).wait();
            expect(await probe.quote(poolAddr, TWAP_WINDOW, TWAP_CARDINALITY, wethAddr, usdcAddr, 10n ** 9n)).to.equal(
                1_000_100_000n,
            );
            expect(await probe.quote(poolAddr, TWAP_WINDOW, TWAP_CARDINALITY, usdcAddr, wethAddr, 10n ** 9n)).to.equal(
                999_900_009n,
            );
        });

        // Above ~tick 443_636 the sqrt price exceeds uint128 and squaring it
        // would overflow Q192, so the library carries the ratio in Q128.
        it("quotes both directions past the Q192 overflow threshold", async function () {
            const { probe, uniPool, poolAddr, wethAddr, usdcAddr } = await deployProbe();
            await (await uniPool.setTwapTick(500_000)).wait();
            const up = await probe.quote(poolAddr, TWAP_WINDOW, TWAP_CARDINALITY, wethAddr, usdcAddr, 1_000n);
            const down = await probe.quote(poolAddr, TWAP_WINDOW, TWAP_CARDINALITY, usdcAddr, wethAddr, 10n ** 30n);
            expect(up).to.be.greaterThan(10n ** 12n);
            expect(down).to.be.greaterThan(0n);
            expect(down).to.be.lessThan(10n ** 12n);
        });
    });

    describe("setTwapConfig", function () {
        it("stores and atomically replaces a reference, but never clears it", async function () {
            const { manager, deployer, timelock, wethAddr, usdcAddr, uniPool } =
                await loadFixture(deployYieldManagerHarness);
            const poolAddr = await uniPool.getAddress();

            const stored = await manager.twapConfigOf(wethAddr);
            expect(stored.pool).to.equal(poolAddr);
            expect(stored.window).to.equal(TWAP_WINDOW);
            expect(stored.minCardinality).to.equal(TWAP_CARDINALITY);

            await expect(
                manager.connect(deployer).setTwapConfig(wethAddr, ethers.ZeroAddress, 0, 0),
            ).to.be.revertedWithCustomError(manager, "OnlyTimelock");
            await expect(timelockCall(timelock, manager, "setTwapConfig", [wethAddr, ethers.ZeroAddress, 0, 0]))
                .to.be.revertedWithCustomError(manager, "TwapReferenceRemovalNotAllowed")
                .withArgs(wethAddr);

            const Pool = await ethers.getContractFactory("MockUniswapV3Pool");
            const replacement = await Pool.deploy(wethAddr, usdcAddr, Q96, 10n ** 18n);
            await expect(
                timelockCall(timelock, manager, "setTwapConfig", [
                    wethAddr,
                    await replacement.getAddress(),
                    TWAP_WINDOW,
                    TWAP_CARDINALITY,
                ]),
            )
                .to.emit(manager, "TwapConfigUpdated")
                .withArgs(wethAddr, await replacement.getAddress(), TWAP_WINDOW, TWAP_CARDINALITY);
            expect((await manager.twapConfigOf(wethAddr)).pool).to.equal(await replacement.getAddress());
        });

        it("refuses a window or cardinality below the floors no role can lower", async function () {
            const { manager, timelock, wethAddr, uniPool } = await loadFixture(deployYieldManagerHarness);
            const poolAddr = await uniPool.getAddress();
            await expect(
                timelockCall(timelock, manager, "setTwapConfig", [
                    wethAddr,
                    poolAddr,
                    TWAP_WINDOW - 1,
                    TWAP_CARDINALITY,
                ]),
            ).to.be.revertedWithCustomError(manager, "TwapWindowTooShort");
            await expect(
                timelockCall(timelock, manager, "setTwapConfig", [
                    wethAddr,
                    poolAddr,
                    TWAP_WINDOW,
                    TWAP_CARDINALITY - 1,
                ]),
            ).to.be.revertedWithCustomError(manager, "TwapCardinalityBelowFloor");
        });

        it("refuses a pool that does not trade the pair", async function () {
            const { manager, timelock, wethAddr, usdcAddr, uniPool } = await loadFixture(deployYieldManagerHarness);
            const Pool = await ethers.getContractFactory("MockUniswapV3Pool");
            const wrong = await Pool.deploy(wethAddr, wethAddr, Q96, 10n ** 18n);
            await wrong.waitForDeployment();
            await expect(
                timelockCall(timelock, manager, "setTwapConfig", [
                    wethAddr,
                    await wrong.getAddress(),
                    TWAP_WINDOW,
                    TWAP_CARDINALITY,
                ]),
            ).to.be.revertedWithCustomError(manager, "TwapPoolPairMismatch");
            // Right pool, wrong token to key it under.
            await expect(
                timelockCall(timelock, manager, "setTwapConfig", [
                    usdcAddr,
                    await uniPool.getAddress(),
                    TWAP_WINDOW,
                    TWAP_CARDINALITY,
                ]),
            ).to.be.revertedWithCustomError(manager, "TwapPoolPairMismatch");
        });

        it("refuses a reference that cannot answer today", async function () {
            const { manager, timelock, wethAddr, uniPool } = await loadFixture(deployYieldManagerHarness);
            await (await uniPool.setObservationCardinality(TWAP_CARDINALITY - 1)).wait();
            await expect(
                timelockCall(timelock, manager, "setTwapConfig", [
                    wethAddr,
                    await uniPool.getAddress(),
                    TWAP_WINDOW,
                    TWAP_CARDINALITY,
                ]),
            ).to.be.revertedWithCustomError(manager, "TwapCardinalityTooLow");
        });

        it("uses address(0) as the native key and validates it against WETH", async function () {
            const { manager, timelock, wethAddr, usdcAddr, uniPool } = await loadFixture(deployYieldManagerHarness);
            const poolAddr = await uniPool.getAddress();
            await expect(
                timelockCall(timelock, manager, "setTwapConfig", [
                    ethers.ZeroAddress,
                    poolAddr,
                    TWAP_WINDOW,
                    TWAP_CARDINALITY,
                ]),
            )
                .to.emit(manager, "TwapConfigUpdated")
                .withArgs(ethers.ZeroAddress, poolAddr, TWAP_WINDOW, TWAP_CARDINALITY);
            expect((await manager.twapConfigOf(ethers.ZeroAddress)).pool).to.equal(poolAddr);
            expect(await manager.twapQuote(ethers.ZeroAddress, usdcAddr, 500_000n)).to.equal(500_000n);

            const ERC = await ethers.getContractFactory("MockERC20");
            const other = await ERC.deploy("Other", "OTHER", 18);
            const otherAddr = await other.getAddress();
            const [p0, p1] =
                otherAddr.toLowerCase() < usdcAddr.toLowerCase() ? [otherAddr, usdcAddr] : [usdcAddr, otherAddr];
            const Pool = await ethers.getContractFactory("MockUniswapV3Pool");
            const wrong = await Pool.deploy(p0, p1, Q96, 10n ** 18n);
            await expect(
                timelockCall(timelock, manager, "setTwapConfig", [
                    ethers.ZeroAddress,
                    await wrong.getAddress(),
                    TWAP_WINDOW,
                    TWAP_CARDINALITY,
                ]),
            ).to.be.revertedWithCustomError(manager, "TwapPoolPairMismatch");
            expect(await manager.WETH()).to.equal(wethAddr);
        });

        it("rejects direct DEFAULT_ADMIN calls, codeless pools, and uninitialized pools", async function () {
            const { manager, deployer, stranger, timelock, wethAddr, usdcAddr, uniPool } =
                await loadFixture(deployYieldManagerHarness);
            const poolAddr = await uniPool.getAddress();
            for (const caller of [deployer, stranger]) {
                await expect(
                    manager.connect(caller).setTwapConfig(wethAddr, poolAddr, TWAP_WINDOW, TWAP_CARDINALITY),
                ).to.be.revertedWithCustomError(manager, "OnlyTimelock");
            }
            await expect(
                timelockCall(timelock, manager, "setTwapConfig", [
                    wethAddr,
                    stranger.address,
                    TWAP_WINDOW,
                    TWAP_CARDINALITY,
                ]),
            )
                .to.be.revertedWithCustomError(manager, "InvalidTwapReferencePool")
                .withArgs(stranger.address);

            const Pool = await ethers.getContractFactory("MockUniswapV3Pool");
            const uninitialized = await Pool.deploy(wethAddr, usdcAddr, 0, 10n ** 18n);
            await expect(
                timelockCall(timelock, manager, "setTwapConfig", [
                    wethAddr,
                    await uninitialized.getAddress(),
                    TWAP_WINDOW,
                    TWAP_CARDINALITY,
                ]),
            ).to.be.revertedWithCustomError(manager, "PoolNotInitialized");
        });

        it("quotes and previews the exact effective floor", async function () {
            const { manager, wethAddr, usdcAddr } = await loadFixture(deployYieldManagerHarness);
            expect(await manager.twapQuote(usdcAddr, wethAddr, 500_000n)).to.equal(500_000n);
            expect(await manager.twapMinimumOut(usdcAddr, wethAddr, 500_000n, 100)).to.equal(495_000n);
        });

        // The allow-list gained a parallel array plus an index map so protocol
        // re-enablement can walk it. Swap-and-pop bookkeeping is easy to get
        // wrong in a way nothing else notices, so it is pinned directly.
        it("keeps the enumerable allow-list consistent through add, no-op and swap-and-pop removal", async function () {
            const { manager, deployer, uniPool, wethAddr, usdcAddr } = await loadFixture(deployYieldManagerHarness);
            const poolAddr = await uniPool.getAddress();
            const extraA = encodeUniV3PoolParam(wethAddr, usdcAddr, 3000);
            const extraB = encodeUniV3PoolParam(wethAddr, usdcAddr, 10000);

            // The fixture allow-lists exactly one param for UNISWAP_V3.
            expect(await manager.allowedPoolParamCount(UNISWAP_V3)).to.equal(1);
            expect(await manager.allowedPoolParamAt(UNISWAP_V3, 0)).to.equal(FEE_TIER);

            await (await manager.connect(deployer).setPoolParamAllowed(UNISWAP_V3, extraA, true)).wait();
            await (await manager.connect(deployer).setPoolParamAllowed(UNISWAP_V3, extraB, true)).wait();
            expect(await manager.allowedPoolParamCount(UNISWAP_V3)).to.equal(3);

            // Re-allowing an already-allowed param must not duplicate the entry.
            await (await manager.connect(deployer).setPoolParamAllowed(UNISWAP_V3, extraA, true)).wait();
            expect(await manager.allowedPoolParamCount(UNISWAP_V3)).to.equal(3);
            // Disallowing something never allowed is likewise a no-op, not an
            // underflow on the index map.
            const unseen = encodeUniV3PoolParam(wethAddr, usdcAddr, 100);
            await (await manager.connect(deployer).setPoolParamAllowed(UNISWAP_V3, unseen, false)).wait();
            expect(await manager.allowedPoolParamCount(UNISWAP_V3)).to.equal(3);

            // Remove from the MIDDLE: the last entry has to move into the hole
            // and its index entry has to follow it.
            await (await manager.connect(deployer).setPoolParamAllowed(UNISWAP_V3, extraA, false)).wait();
            expect(await manager.allowedPoolParamCount(UNISWAP_V3)).to.equal(2);
            expect(await manager.isPoolParamAllowed(UNISWAP_V3, extraA)).to.equal(false);
            const remaining = [
                await manager.allowedPoolParamAt(UNISWAP_V3, 0),
                await manager.allowedPoolParamAt(UNISWAP_V3, 1),
            ];
            expect(remaining).to.have.members([FEE_TIER, extraB]);

            // Removing the moved entry exercises the index == lastIndex path,
            // and the survivor must still be addressable afterwards.
            await (await manager.connect(deployer).setPoolParamAllowed(UNISWAP_V3, extraB, false)).wait();
            expect(await manager.allowedPoolParamCount(UNISWAP_V3)).to.equal(1);
            expect(await manager.allowedPoolParamAt(UNISWAP_V3, 0)).to.equal(FEE_TIER);
            expect(await manager.isPoolParamAllowed(UNISWAP_V3, FEE_TIER)).to.equal(true);

            // Re-enabling the protocol still walks a coherent list.
            await (await manager.connect(deployer).setPoolParamAllowed(UNISWAP_V3, extraA, true)).wait();
            expect(await manager.allowedPoolParamCount(UNISWAP_V3)).to.equal(2);
            expect(poolAddr).to.properAddress;
        });

        it("refuses to allow-list a param for a protocol with no handler", async function () {
            const { manager, deployer, wethAddr, usdcAddr } = await loadFixture(deployYieldManagerHarness);
            await expect(
                manager.connect(deployer).setPoolParamAllowed(99, encodeUniV3PoolParam(wethAddr, usdcAddr, 500), true),
            ).to.be.revertedWithCustomError(manager, "HandlerNotSet");
        });

        it("checks a degenerate same-token pool param only once", async function () {
            const { manager, deployer, wethAddr } = await loadFixture(deployYieldManagerHarness);
            // token0 == token1: the second reference lookup is skipped rather
            // than repeated. WETH has a reference, so this is allowed.
            await (
                await manager
                    .connect(deployer)
                    .setPoolParamAllowed(UNISWAP_V3, encodeUniV3PoolParam(wethAddr, wethAddr, 500), true)
            ).wait();
            expect(
                await manager.isPoolParamAllowed(UNISWAP_V3, encodeUniV3PoolParam(wethAddr, wethAddr, 500)),
            ).to.equal(true);
        });

        it("bounds slippage and requires a reference when previewing the floor", async function () {
            const { manager, wethAddr, usdcAddr } = await loadFixture(deployYieldManagerHarness);
            await expect(manager.twapMinimumOut(usdcAddr, wethAddr, 1_000n, 0)).to.be.revertedWithCustomError(
                manager,
                "SlippageTooLow",
            );
            await expect(manager.twapMinimumOut(usdcAddr, wethAddr, 1_000n, 301)).to.be.revertedWithCustomError(
                manager,
                "SlippageAboveMax",
            );
            const unpriced = ethers.Wallet.createRandom().address;
            await expect(manager.twapMinimumOut(usdcAddr, unpriced, 1_000n, 100)).to.be.revertedWithCustomError(
                manager,
                "TwapNotConfigured",
            );
        });

        it("quotes the native key in both directions once it is configured", async function () {
            const { manager, timelock, usdcAddr, uniPool } = await loadFixture(deployYieldManagerHarness);
            await (
                await timelockCall(timelock, manager, "setTwapConfig", [
                    ethers.ZeroAddress,
                    await uniPool.getAddress(),
                    TWAP_WINDOW,
                    TWAP_CARDINALITY,
                ])
            ).wait();

            // Native in and native out both resolve through WETH for the tick
            // math while keeping address(0) as the configuration key.
            expect(await manager.twapQuote(ethers.ZeroAddress, usdcAddr, 1_000_000n)).to.equal(1_000_000n);
            expect(await manager.twapQuote(usdcAddr, ethers.ZeroAddress, 1_000_000n)).to.equal(1_000_000n);
        });

        it("guards new allow-list entries and protocol re-enablement with live references", async function () {
            const { manager, deployer, pauser, timelock, usdcAddr, uniHandler, uniPool } =
                await loadFixture(deployYieldManagerHarness);
            const ERC = await ethers.getContractFactory("MockERC20");
            const token = await ERC.deploy("New Token", "NEW", 18);
            const tokenAddr = await token.getAddress();
            const [p0, p1] =
                tokenAddr.toLowerCase() < usdcAddr.toLowerCase() ? [tokenAddr, usdcAddr] : [usdcAddr, tokenAddr];
            const param = encodeUniV3PoolParam(p0, p1, 500);

            await expect(manager.connect(deployer).setPoolParamAllowed(UNISWAP_V3, param, true))
                .to.be.revertedWithCustomError(manager, "TwapNotConfigured")
                .withArgs(tokenAddr);

            const Pool = await ethers.getContractFactory("MockUniswapV3Pool");
            const reference = await Pool.deploy(p0, p1, Q96, 10n ** 18n);
            await (
                await timelockCall(timelock, manager, "setTwapConfig", [
                    tokenAddr,
                    await reference.getAddress(),
                    TWAP_WINDOW,
                    TWAP_CARDINALITY,
                ])
            ).wait();
            await expect(manager.connect(deployer).setPoolParamAllowed(UNISWAP_V3, param, true))
                .to.emit(manager, "PoolParamAllowedUpdated")
                .withArgs(UNISWAP_V3, param, false, true);

            expect(await manager.allowedPoolParamCount(UNISWAP_V3)).to.equal(2);
            expect(await manager.allowedPoolParamAt(UNISWAP_V3, 1)).to.equal(param);

            await (await manager.connect(pauser).setProtocolEnabledForOpen(UNISWAP_V3, false)).wait();
            await (await uniPool.setObserveReverts(true)).wait();
            await expect(manager.connect(pauser).setProtocolEnabledForOpen(UNISWAP_V3, true)).to.be.revertedWith("OLD");
            expect(await manager.protocolEnabledForOpen(UNISWAP_V3)).to.equal(false);
            await (await uniPool.setObserveReverts(false)).wait();
            await expect(manager.connect(pauser).setProtocolEnabledForOpen(UNISWAP_V3, true))
                .to.emit(manager, "ProtocolStatusChanged")
                .withArgs(UNISWAP_V3, true, true);

            expect(await uniHandler.PROTOCOL()).to.equal(UNISWAP_V3);
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  H-01: the exit that needs no oracle
    // ─────────────────────────────────────────────────────────────────────

    describe("withdrawLp", function () {
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

        it("exits in kind, releases the basis, and charges no fee", async function () {
            const { manager, operatorEOA, safeAddr, treasury, usdc, uniNpm } =
                await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            expect(await manager.residualBasisUsd6Of(UNISWAP_V3, 1)).to.equal(USDC_AMOUNT);

            const treasuryBefore = await usdc.balanceOf(treasury.address);
            await expect(manager.connect(operatorEOA).withdrawLp(UNISWAP_V3, withdrawParams(safeAddr, 1))).to.emit(
                manager,
                "PositionWithdrawn",
            );

            expect(await manager.residualBasisUsd6Of(UNISWAP_V3, 1)).to.equal(0);
            expect(await manager.positionHandlerOf(UNISWAP_V3, 1)).to.equal(ethers.ZeroAddress);
            expect(await usdc.balanceOf(treasury.address)).to.equal(treasuryBefore);
            // Burned: the mock clears the owner rather than reverting.
            expect(await uniNpm.ownerOf(1)).to.equal(ethers.ZeroAddress);
        });

        // The reason this entry point exists: a position must not depend on a
        // price reference to get out.
        it("still exits when the price reference is gone", async function () {
            const { manager, operatorEOA, safeAddr, uniPool } = await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            await (await uniPool.setObserveReverts(true)).wait();

            await expect(
                manager.connect(operatorEOA).closeLp(UNISWAP_V3, closeParams(safeAddr, 1, FEE_TIER)),
            ).to.be.revertedWith("OLD");
            await expect(manager.connect(operatorEOA).withdrawLp(UNISWAP_V3, withdrawParams(safeAddr, 1))).to.emit(
                manager,
                "PositionWithdrawn",
            );
        });

        it("stays available while the manager is paused", async function () {
            const { manager, operatorEOA, pauser, safeAddr } = await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            await (await manager.connect(pauser).pause()).wait();
            await expect(manager.connect(operatorEOA).withdrawLp(UNISWAP_V3, withdrawParams(safeAddr, 1))).to.emit(
                manager,
                "PositionWithdrawn",
            );
        });

        // The emergency exit has to work for the position type that is hardest
        // to get out of: one the stakePool owns rather than the Safe.
        it("unstakes a staked position and clears its pin", async function () {
            const { manager, operatorEOA, safeAddr, clNpm, clPool, voter } =
                await loadFixture(deployYieldManagerHarness);
            const { stakePoolAddr } = await deployStakePool(clNpm, clPool, voter);
            await (
                await manager
                    .connect(operatorEOA)
                    .openLp(AERODROME, openParams(safeAddr, TICK_SPACING, { stake: true }))
            ).wait();
            expect(await clNpm.ownerOf(1)).to.equal(stakePoolAddr);
            expect(await manager.stakePoolOf(AERODROME, 1)).to.equal(stakePoolAddr);

            await expect(manager.connect(operatorEOA).withdrawLp(AERODROME, withdrawParams(safeAddr, 1))).to.emit(
                manager,
                "PositionWithdrawn",
            );

            expect(await manager.stakePoolOf(AERODROME, 1)).to.equal(ethers.ZeroAddress);
            expect(await manager.residualBasisUsd6Of(AERODROME, 1)).to.equal(0);
        });

        it("reports the carried profit it releases without charging it", async function () {
            const { manager, operatorEOA, safeAddr, treasury, usdc, clNpm } =
                await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            await (await clNpm.setMintUsageBps(5_000)).wait();
            await (
                await manager.connect(operatorEOA).switchLp(UNISWAP_V3, AERODROME, {
                    onBehalfOf: safeAddr,
                    tokenId: 1,
                    decreaseAmount0Min: 0,
                    decreaseAmount1Min: 0,
                    tickLower: -100,
                    tickUpper: 100,
                    mintAmount0Min: 0,
                    mintAmount1Min: 0,
                    lpPoolParam: TICK_SPACING,
                    deadline: DEADLINE,
                })
            ).wait();
            const carry = await manager.carryProfitUsd6Of(AERODROME, 1);
            expect(carry).to.be.greaterThan(0);

            const treasuryBefore = await usdc.balanceOf(treasury.address);
            await expect(manager.connect(operatorEOA).withdrawLp(AERODROME, withdrawParams(safeAddr, 1)))
                .to.emit(manager, "PositionWithdrawn")
                .withArgs(safeAddr, AERODROME, 1n, 0n, carry, anyValue, anyValue);

            // Waived, not collected — and the waiver is on the record.
            expect(await usdc.balanceOf(treasury.address)).to.equal(treasuryBefore);
            expect(await manager.carryProfitUsd6Of(AERODROME, 1)).to.equal(0);
        });

        it("honours the same gates as every other exit", async function () {
            const { manager, operatorEOA, pauser, stranger, safeAddr } = await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();

            await expect(
                manager.connect(stranger).withdrawLp(UNISWAP_V3, withdrawParams(safeAddr, 1)),
            ).to.be.revertedWithCustomError(manager, "NotAuthorized");
            await expect(
                manager.connect(operatorEOA).withdrawLp(UNISWAP_V3, withdrawParams(safeAddr, 1, { deadline: 1 })),
            ).to.be.revertedWithCustomError(manager, "DeadlineExpired");
            await expect(
                manager.connect(operatorEOA).withdrawLp(UNISWAP_V3, withdrawParams(safeAddr, 999)),
            ).to.be.revertedWithCustomError(manager, "UnknownPosition");

            await (await manager.connect(pauser).setProtocolEnabledForClose(UNISWAP_V3, false)).wait();
            await expect(
                manager.connect(operatorEOA).withdrawLp(UNISWAP_V3, withdrawParams(safeAddr, 1)),
            ).to.be.revertedWithCustomError(manager, "ProtocolDisabled");
        });
    });
});
