import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { YieldProtocol } from "../contractAddresses";

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

const FEE_TIER = abi.encode(["uint24"], [500]);
const BAD_FEE_TIER = abi.encode(["uint24"], [10000]);
const TICK_SPACING = abi.encode(["int24"], [100]);

const USDC_AMOUNT = 1_000_000n;
const HALF = USDC_AMOUNT / 2n;
const WETH_OUT = 2_000_000n; // WETH produced by the openLp swap

function openParams(safeAddr: string, poolParam: string, overrides: Record<string, any> = {}) {
    return {
        onBehalfOf: safeAddr,
        usdcAmount: USDC_AMOUNT,
        tickLower: -100,
        tickUpper: 100,
        mintAmount0Min: 0,
        mintAmount1Min: 0,
        swapAmountOutMin: WETH_OUT,
        expectedSwapOut: WETH_OUT,
        slippageBps: SLIP,
        deadline: DEADLINE,
        lpPoolParam: poolParam,
        swapPoolParam: poolParam,
        ...overrides,
    };
}

function closeParams(safeAddr: string, tokenId: bigint | number, poolParam: string, overrides: Record<string, any> = {}) {
    return {
        onBehalfOf: safeAddr,
        tokenId,
        exitBps: 10_000,
        swapAmountOutMin: 600_000n,
        expectedSwapOut: 600_000n,
        slippageBps: SLIP,
        decreaseAmount0Min: 0,
        decreaseAmount1Min: 0,
        deadline: DEADLINE,
        minUsdcOut: 0,
        swapPoolParam: poolParam,
        ...overrides,
    };
}

function collectParams(safeAddr: string, tokenId: bigint | number, poolParam: string, overrides: Record<string, any> = {}) {
    return {
        onBehalfOf: safeAddr,
        tokenId,
        swapWethToUsdc: false,
        swapAmountOutMin: 1,
        expectedSwapOut: 1,
        slippageBps: SLIP,
        deadline: DEADLINE,
        swapPoolParam: poolParam,
        ...overrides,
    };
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

    // Uniswap V3 side
    const UniPool = await ethers.getContractFactory("MockUniswapV3Pool");
    const uniPool = await UniPool.deploy(wethAddr, usdcAddr, Q96, 10n ** 18n);
    await uniPool.waitForDeployment();
    const UniFactory = await ethers.getContractFactory("MockUniswapV3Factory");
    const uniFactory = await UniFactory.deploy();
    await uniFactory.waitForDeployment();
    await (await uniFactory.setPool(await uniPool.getAddress())).wait();
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

    const Safe = await ethers.getContractFactory("MockSafeHarness");
    const safe = await Safe.deploy();
    await safe.waitForDeployment();
    const safeAddr = await safe.getAddress();

    const Reg = await ethers.getContractFactory("MockRegistry");
    const reg = await Reg.deploy();
    await reg.waitForDeployment();
    await (await reg.setOperator(operatorEOA.address)).wait();

    const UniHandler = await ethers.getContractFactory("UniV3YieldHandler");
    const uniHandler = await UniHandler.deploy(
        await uniNpm.getAddress(),
        usdcAddr,
        wethAddr,
        await uniRouter.getAddress(),
        await uniFactory.getAddress(),
    );
    await uniHandler.waitForDeployment();

    const AeroHandler = await ethers.getContractFactory("AerodromeYieldHandler");
    const aeroHandler = await AeroHandler.deploy(
        await clNpm.getAddress(),
        usdcAddr,
        wethAddr,
        await clRouter.getAddress(),
        await clFactory.getAddress(),
    );
    await aeroHandler.waitForDeployment();

    const Manager = await ethers.getContractFactory("SafeYieldManager");
    const manager = await Manager.deploy(
        await reg.getAddress(),
        usdcAddr,
        [UNISWAP_V3, AERODROME],
        [await uniHandler.getAddress(), await aeroHandler.getAddress()],
        [[FEE_TIER], [TICK_SPACING]],
        [0, 0],
        [0, 0],
        treasury.address,
        Number(PERF_FEE_BPS),
        Number(COLLECT_FEE_BPS),
        MAX_FEE_BPS,
        deployer.address, // initialAdmin
        deployer.address, // timelock
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
        weth,
        usdc,
        wethAddr,
        usdcAddr,
        uniPool,
        uniFactory,
        uniNpm,
        uniRouter,
        clPool,
        clFactory,
        clNpm,
        clRouter,
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
            const { manager, reg, usdcAddr, uniHandler, treasury, deployer, pauser } =
                await loadFixture(deployYieldManagerHarness);
            const Manager = await ethers.getContractFactory("SafeYieldManager");
            await expect(
                Manager.deploy(
                    await reg.getAddress(),
                    usdcAddr,
                    [UNISWAP_V3, AERODROME],
                    [await uniHandler.getAddress()],
                    [[FEE_TIER], [TICK_SPACING]],
                    [0, 0],
                    [0, 0],
                    treasury.address,
                    Number(PERF_FEE_BPS),
                    Number(COLLECT_FEE_BPS),
                    MAX_FEE_BPS,
                    deployer.address,
                    deployer.address,
                    pauser.address,
                ),
            ).to.be.revertedWithCustomError(manager, "LengthMismatch");
        });
    });

    describe("openLp", function () {
        it("opens a Uniswap V3 position through the manager module", async function () {
            const { manager, operatorEOA, safeAddr, uniNpm } = await loadFixture(deployYieldManagerHarness);

            await expect(manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER)))
                .to.emit(manager, "PositionOpened")
                .withArgs(safeAddr, UNISWAP_V3, 1n, USDC_AMOUNT, WETH_OUT, HALF, USDC_AMOUNT);

            expect(await manager.residualBasisUsd6Of(UNISWAP_V3, 1)).to.equal(USDC_AMOUNT);
            expect(await manager.positionHandlerOf(UNISWAP_V3, 1)).to.equal(
                await manager.yieldHandlers(UNISWAP_V3),
            );
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
            await expect(
                manager
                    .connect(operatorEOA)
                    .openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER, { swapAmountOutMin: WETH_OUT / 2n })),
            ).to.be.revertedWithCustomError(manager, "SwapMinBelowSlippageFloor");
            await expect(
                manager
                    .connect(operatorEOA)
                    .openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER, { swapAmountOutMin: 0 })),
            ).to.be.revertedWithCustomError(manager, "InvalidSwapAmountOutMin");
            await expect(
                manager
                    .connect(operatorEOA)
                    .openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER, { expectedSwapOut: 0 })),
            ).to.be.revertedWithCustomError(manager, "InvalidExpectedSwapOut");
        });

        it("reverts SwapFailed when the swap produces no WETH", async function () {
            const { manager, operatorEOA, safeAddr, uniRouter } = await loadFixture(deployYieldManagerHarness);
            await (await uniRouter.setOutput(0)).wait();
            await expect(
                manager
                    .connect(operatorEOA)
                    .openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER, { swapAmountOutMin: 1, expectedSwapOut: 1 })),
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
                .withArgs(safeAddr, UNISWAP_V3, 1n, USDC_AMOUNT, 1_100_000n, 10_000n, 10_000);

            expect((await usdc.balanceOf(treasury.address)) - treasuryBefore).to.equal(10_000n);
            expect(await manager.residualBasisUsd6Of(UNISWAP_V3, 1)).to.equal(0);
            expect(await manager.positionHandlerOf(UNISWAP_V3, 1)).to.equal(ZERO);
            expect(await uniNpm.ownerOf(1)).to.equal(ZERO);
        });

        it("closes through the handler pinned at open even after setYieldHandler", async function () {
            const { manager, operatorEOA, deployer, safeAddr, usdcAddr, wethAddr, uniNpm, uniRouter, uniFactory } =
                await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            const pinnedHandler = await manager.positionHandlerOf(UNISWAP_V3, 1);

            const NPM2 = await ethers.getContractFactory("MockNonfungiblePositionManager");
            const uniNpm2 = await NPM2.deploy();
            await uniNpm2.waitForDeployment();
            const UniHandler = await ethers.getContractFactory("UniV3YieldHandler");
            const newHandler = await UniHandler.deploy(
                await uniNpm2.getAddress(),
                usdcAddr,
                wethAddr,
                await uniRouter.getAddress(),
                await uniFactory.getAddress(),
            );
            await newHandler.waitForDeployment();
            await (await manager.connect(deployer).setYieldHandler(UNISWAP_V3, await newHandler.getAddress())).wait();

            expect(await manager.positionHandlerOf(UNISWAP_V3, 1)).to.equal(pinnedHandler);
            await (await uniRouter.setOutput(600_000n)).wait();
            await expect(
                manager.connect(operatorEOA).closeLp(UNISWAP_V3, closeParams(safeAddr, 1, FEE_TIER)),
            ).to.emit(manager, "PositionClosed");
            expect(await uniNpm.ownerOf(1)).to.equal(ZERO);
        });

        it("fully closes an Aerodrome position", async function () {
            const { manager, operatorEOA, safeAddr, clNpm, clRouter } = await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(AERODROME, openParams(safeAddr, TICK_SPACING))).wait();
            await (await clRouter.setOutput(600_000n)).wait();

            await expect(manager.connect(operatorEOA).closeLp(AERODROME, closeParams(safeAddr, 1, TICK_SPACING)))
                .to.emit(manager, "PositionClosed")
                .withArgs(safeAddr, AERODROME, 1n, USDC_AMOUNT, 1_100_000n, 10_000n, 10_000);

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
                        swapAmountOutMin: 300_000n,
                        expectedSwapOut: 300_000n,
                    }),
                ),
            )
                .to.emit(manager, "PositionClosed")
                .withArgs(safeAddr, UNISWAP_V3, 1n, HALF, 550_000n, 5_000n, 5_000);

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
                .withArgs(safeAddr, UNISWAP_V3, 1n, USDC_AMOUNT, 1_100_000n, 0n, 10_000);
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
                    140_000n,
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
                        swapWethToUsdc: true,
                        swapAmountOutMin: 95_000n,
                        expectedSwapOut: 95_000n,
                    }),
                )
            ).wait();

            expect(await weth.balanceOf(safeAddr)).to.equal(safeWethBefore);
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
            await expect(
                manager.connect(operatorEOA).closeLp(UNISWAP_V3, closeParams(safeAddr, 1, FEE_TIER)),
            ).to.emit(manager, "PositionClosed");

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
                .withArgs(UNISWAP_V3, "open", false);

            await expect(
                manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER)),
            ).to.be.revertedWithCustomError(manager, "ProtocolDisabled");
            await expect(manager.connect(operatorEOA).openLp(AERODROME, openParams(safeAddr, TICK_SPACING))).to.emit(
                manager,
                "PositionOpened",
            );
            await (await uniRouter.setOutput(600_000n)).wait();
            await expect(
                manager.connect(operatorEOA).closeLp(UNISWAP_V3, closeParams(safeAddr, 1, FEE_TIER)),
            ).to.emit(manager, "PositionClosed");
        });

        it("pauser can disable exits for a single protocol", async function () {
            const { manager, operatorEOA, pauser, safeAddr } = await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();

            await expect(manager.connect(pauser).setProtocolEnabledForClose(UNISWAP_V3, false))
                .to.emit(manager, "ProtocolStatusChanged")
                .withArgs(UNISWAP_V3, "close", false);

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
            const { manager, deployer, stranger, uniHandler } = await loadFixture(deployYieldManagerHarness);
            await expect(manager.connect(deployer).setTreasury(stranger.address)).to.emit(manager, "TreasuryUpdated");
            expect(await manager.treasury()).to.equal(stranger.address);

            await expect(manager.connect(deployer).setPerformanceFeeBps(MAX_FEE_BPS + 1)).to.be.revertedWithCustomError(
                manager,
                "FeeAboveMax",
            );
            await (await manager.connect(deployer).setPerformanceFeeBps(500)).wait();
            expect(await manager.performanceFeeBps()).to.equal(500);

            await expect(manager.connect(deployer).setYieldHandler(UNISWAP_V3, ZERO)).to.be.revertedWithCustomError(
                manager,
                "InvalidHandler",
            );
            await expect(manager.connect(deployer).setYieldHandler(AERODROME, await uniHandler.getAddress()))
                .to.emit(manager, "YieldHandlerUpdated")
                .withArgs(AERODROME, anyValue, await uniHandler.getAddress());
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

    describe("handlers", function () {
        it("rejects direct (non-delegatecall) invocation", async function () {
            const { uniHandler, aeroHandler, safeAddr } = await loadFixture(deployYieldManagerHarness);
            await expect(uniHandler.openLp(openParams(safeAddr, FEE_TIER))).to.be.revertedWithCustomError(
                uniHandler,
                "OnlyDelegatecall",
            );
            await expect(
                aeroHandler.collectLp(collectParams(safeAddr, 1, TICK_SPACING)),
            ).to.be.revertedWithCustomError(aeroHandler, "OnlyDelegatecall");
        });
    });
});
