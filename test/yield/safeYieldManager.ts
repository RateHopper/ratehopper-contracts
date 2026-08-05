import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { YieldProtocol } from "../../contractAddresses";

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

function collectParams(
    safeAddr: string,
    tokenId: bigint | number,
    poolParam: string,
    overrides: Record<string, any> = {},
) {
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

        it("rejects mismatched and non-contract handlers in the constructor", async function () {
            const { manager, reg, usdcAddr, uniHandler, treasury, deployer, pauser, stranger } =
                await loadFixture(deployYieldManagerHarness);
            const Manager = await ethers.getContractFactory("SafeYieldManager");
            const registryAddress = await reg.getAddress();
            const deployWithHandler = (handler: string) =>
                Manager.deploy(
                    registryAddress,
                    usdcAddr,
                    [AERODROME],
                    [handler],
                    [[TICK_SPACING]],
                    [0],
                    [0],
                    treasury.address,
                    Number(PERF_FEE_BPS),
                    Number(COLLECT_FEE_BPS),
                    MAX_FEE_BPS,
                    deployer.address,
                    deployer.address,
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
                manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER, { expectedSwapOut: 0 })),
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
                .to.be.revertedWithCustomError(manager, "HandlerProtocolMismatch")
                .withArgs(AERODROME, UNISWAP_V3);
            await expect(
                manager.connect(deployer).setYieldHandler(UNISWAP_V3, stranger.address),
            ).to.be.revertedWithCustomError(manager, "InvalidHandler");
        });

        it("rejects a handler contract without PROTOCOL()", async function () {
            const { manager, deployer, usdc } = await loadFixture(deployYieldManagerHarness);
            await expect(
                manager.connect(deployer).setYieldHandler(UNISWAP_V3, await usdc.getAddress()),
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
                wethAddr,
                await uniRouter.getAddress(),
                await uniFactory.getAddress(),
            );
            await nextHandler.waitForDeployment();
            const nextHandlerAddr = await nextHandler.getAddress();

            await expect(manager.connect(deployer).setYieldHandler(NEXT_PROTOCOL, nextHandlerAddr))
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
                .withArgs(safeAddr, NEXT_PROTOCOL, 1n, USDC_AMOUNT, 1_100_000n, 10_000n, 10_000);
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
            const { manager, deployer, uniHandler } = await loadFixture(deployYieldManagerHarness);
            await expect(manager.connect(deployer).setYieldHandler(NEXT_PROTOCOL, await uniHandler.getAddress()))
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
        });

        it("rejects zero addresses and unsorted pairs in handler constructors", async function () {
            const { uniHandler, uniNpm, uniRouter, uniFactory, clNpm, clRouter, usdcAddr, wethAddr } =
                await loadFixture(deployYieldManagerHarness);
            const UniHandler = await ethers.getContractFactory("UniV3YieldHandler");
            const AeroHandler = await ethers.getContractFactory("AerodromeYieldHandler");
            const npm = await uniNpm.getAddress();
            const router = await uniRouter.getAddress();
            const factory = await uniFactory.getAddress();

            await expect(UniHandler.deploy(ZERO, usdcAddr, wethAddr, router, factory)).to.be.revertedWithCustomError(
                uniHandler,
                "ZeroAddress",
            );
            await expect(UniHandler.deploy(npm, ZERO, wethAddr, router, factory)).to.be.revertedWithCustomError(
                uniHandler,
                "ZeroAddress",
            );
            await expect(UniHandler.deploy(npm, usdcAddr, ZERO, router, factory)).to.be.revertedWithCustomError(
                uniHandler,
                "ZeroAddress",
            );
            await expect(UniHandler.deploy(npm, usdcAddr, usdcAddr, router, factory)).to.be.revertedWithCustomError(
                uniHandler,
                "WrongTokenPair",
            );
            await expect(UniHandler.deploy(npm, usdcAddr, wethAddr, ZERO, factory)).to.be.revertedWithCustomError(
                uniHandler,
                "ZeroAddress",
            );
            await expect(UniHandler.deploy(npm, usdcAddr, wethAddr, router, ZERO)).to.be.revertedWithCustomError(
                uniHandler,
                "ZeroAddress",
            );
            await expect(
                AeroHandler.deploy(await clNpm.getAddress(), usdcAddr, wethAddr, await clRouter.getAddress(), ZERO),
            ).to.be.revertedWithCustomError(uniHandler, "ZeroAddress");
        });
    });

    describe("constructor validation", function () {
        async function baseArgs(f: Awaited<ReturnType<typeof deployYieldManagerHarness>>) {
            return [
                await f.reg.getAddress(),
                f.usdcAddr,
                [UNISWAP_V3, AERODROME],
                [await f.uniHandler.getAddress(), await f.aeroHandler.getAddress()],
                [[FEE_TIER], [TICK_SPACING]],
                [0, 0],
                [0, 0],
                f.treasury.address,
                Number(PERF_FEE_BPS),
                Number(COLLECT_FEE_BPS),
                MAX_FEE_BPS,
                f.deployer.address,
                f.deployer.address,
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
            await expect(deployWith(11, ZERO)).to.be.revertedWithCustomError(f.manager, "ZeroAddress");
            await expect(deployWith(12, ZERO)).to.be.revertedWithCustomError(f.manager, "ZeroAddress");
            await expect(deployWith(13, ZERO)).to.be.revertedWithCustomError(f.manager, "ZeroAddress");
            await expect(deployWith(7, ZERO)).to.be.revertedWithCustomError(f.manager, "InvalidTreasury");
            await expect(deployWith(10, 10_001)).to.be.revertedWithCustomError(f.manager, "FeeAboveMax");
            await expect(deployWith(8, MAX_FEE_BPS + 1)).to.be.revertedWithCustomError(f.manager, "FeeAboveMax");
            await expect(deployWith(9, MAX_FEE_BPS + 1)).to.be.revertedWithCustomError(f.manager, "FeeAboveMax");
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

            await expect(deployWith(4, [[FEE_TIER]])).to.be.revertedWithCustomError(f.manager, "LengthMismatch");
            await expect(deployWith(5, [0])).to.be.revertedWithCustomError(f.manager, "LengthMismatch");
            await expect(deployWith(6, [0])).to.be.revertedWithCustomError(f.manager, "LengthMismatch");
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
                manager.connect(operatorEOA).closeLp(UNISWAP_V3, closeParams(safeAddr, 1, FEE_TIER, { exitBps: 5_000 })),
            ).to.be.revertedWithCustomError(manager, "InvalidExitBps");
        });

        it("full-closes a zero-liquidity position without decrease or swap and charges no fee", async function () {
            const { manager, operatorEOA, safeAddr, uniNpm } = await loadFixture(deployYieldManagerHarness);
            await (await uniNpm.setMintLiquidity(0)).wait();
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            await expect(manager.connect(operatorEOA).closeLp(UNISWAP_V3, closeParams(safeAddr, 1, FEE_TIER)))
                .to.emit(manager, "PositionClosed")
                .withArgs(safeAddr, UNISWAP_V3, 1n, USDC_AMOUNT, 0n, 0n, 10_000);
        });

        it("charges no performance fee when a close realizes a loss", async function () {
            const { manager, operatorEOA, safeAddr, treasury, usdc, uniRouter } =
                await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();
            await (await uniRouter.setOutput(300_000n)).wait();

            const tx = manager.connect(operatorEOA).closeLp(
                UNISWAP_V3,
                closeParams(safeAddr, 1, FEE_TIER, { swapAmountOutMin: 300_000n, expectedSwapOut: 300_000n }),
            );
            await expect(tx)
                .to.emit(manager, "PositionClosed")
                .withArgs(safeAddr, UNISWAP_V3, 1n, USDC_AMOUNT, 800_000n, 0n, 10_000);
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
                    .collectLp(UNISWAP_V3, collectParams(safeAddr, 1, FEE_TIER, { swapWethToUsdc: true, deadline: 1 })),
            ).to.be.revertedWithCustomError(manager, "DeadlineExpired");
        });

        it("reverts WrongTokenPair on close and collect for tampered positions", async function () {
            const { manager, operatorEOA, safeAddr, uniNpm, wethAddr, usdcAddr } =
                await loadFixture(deployYieldManagerHarness);
            await (await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER))).wait();

            await (await uniNpm.setTokens(1, usdcAddr, usdcAddr)).wait();
            await expect(
                manager.connect(operatorEOA).closeLp(UNISWAP_V3, closeParams(safeAddr, 1, FEE_TIER)),
            ).to.be.revertedWithCustomError(manager, "WrongTokenPair");

            await (await uniNpm.setTokens(1, wethAddr, wethAddr)).wait();
            await expect(
                manager.connect(operatorEOA).collectLp(UNISWAP_V3, collectParams(safeAddr, 1, FEE_TIER)),
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
            const { manager, deployer, pauser, operatorEOA, safeAddr } = await loadFixture(deployYieldManagerHarness);
            const Reverting = await ethers.getContractFactory("MockRevertingYieldHandler");
            const reverting = await Reverting.deploy(3);
            await reverting.waitForDeployment();
            await (await manager.connect(deployer).setYieldHandler(3, await reverting.getAddress())).wait();
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
                    manager.interface.encodeFunctionData("collectLp", [UNISWAP_V3, collectParams(safeAddr, 1, FEE_TIER)]),
                )
            ).wait();
            await expect(
                manager
                    .connect(operatorEOA)
                    .collectLp(
                        UNISWAP_V3,
                        collectParams(safeAddr, 1, FEE_TIER, {
                            swapWethToUsdc: true,
                            swapAmountOutMin: 95_000n,
                            expectedSwapOut: 95_000n,
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
                .withArgs(safeAddr, UNISWAP_V3, 1n, USDC_AMOUNT, 1_100_000n, 10_000n, 10_000);
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
                [UNISWAP_V3],
                [await f.uniHandler.getAddress()],
                [[FEE_TIER]],
                [0],
                [0],
                f.treasury.address,
                0,
                10_000,
                10_000,
                f.deployer.address,
                f.deployer.address,
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
            const { manager, deployer } = await loadFixture(deployYieldManagerHarness);
            await expect(manager.connect(deployer).setTreasury(ZERO)).to.be.revertedWithCustomError(
                manager,
                "InvalidTreasury",
            );
        });

        it("setFeeCollectBps bounds and updates", async function () {
            const { manager, deployer } = await loadFixture(deployYieldManagerHarness);
            await expect(manager.connect(deployer).setFeeCollectBps(MAX_FEE_BPS + 1)).to.be.revertedWithCustomError(
                manager,
                "FeeAboveMax",
            );
            await expect(manager.connect(deployer).setFeeCollectBps(100))
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
});
