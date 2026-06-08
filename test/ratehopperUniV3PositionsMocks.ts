import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

// ─────────────────────────────────────────────────────────────────────────
//  Mock-driven unit/branch-coverage suite for RatehopperUniV3Positions.
//
//  Unlike the fork integration suite (which needs a real Base RPC + an
//  env-driven Gnosis Safe and therefore skips in plain CI), this suite wires
//  RHP to fully-controlled mocks — a Safe-module executor, swap router, NPM,
//  factory/pool, and ERC20s — so the entire openLp / closeLp / collectLp
//  lifecycle AND every defensive revert branch execute deterministically with
//  no external dependencies.
// ─────────────────────────────────────────────────────────────────────────

const ZERO = "0x0000000000000000000000000000000000000000";
const DEADLINE = ethers.MaxUint256;
const SLIP = 100; // 1%
const PERF_FEE_BPS = 1000n; // 10%
const COLLECT_FEE_BPS = 250n; // 2.5%
const MAX_FEE_BPS = 2000;
const Q96 = 1n << 96n;

const USDC_AMOUNT = 1_000_000n; // openLp input
const HALF = USDC_AMOUNT / 2n;
const WETH_OUT = 2_000_000n; // WETH produced by the openLp swap

// Module-call failure data the MockSafe bubbles for the revert-bubble branch.
const BUBBLE_REASON = "module boom";
const BUBBLE_DATA = ethers.concat([
    "0x08c379a0",
    ethers.AbiCoder.defaultAbiCoder().encode(["string"], [BUBBLE_REASON]),
]);

async function deployMockHarness() {
    const [deployer, operatorEOA, treasury, stranger] = await ethers.getSigners();

    const ERC = await ethers.getContractFactory("MockERC20");
    const tokenA = await ERC.deploy("Token A", "TKA", 18);
    const tokenB = await ERC.deploy("Token B", "TKB", 6);
    await tokenA.waitForDeployment();
    await tokenB.waitForDeployment();
    const addrA = (await tokenA.getAddress()).toLowerCase();
    const addrB = (await tokenB.getAddress()).toLowerCase();
    // RHP requires WETH < USDC by address.
    const [weth, usdc] = addrA < addrB ? [tokenA, tokenB] : [tokenB, tokenA];
    const wethAddr = await weth.getAddress();
    const usdcAddr = await usdc.getAddress();

    const Pool = await ethers.getContractFactory("MockUniswapV3Pool");
    const validPool = await Pool.deploy(wethAddr, usdcAddr, Q96, 10n ** 18n);
    await validPool.waitForDeployment();

    const Factory = await ethers.getContractFactory("MockUniswapV3Factory");
    const factory = await Factory.deploy();
    await factory.waitForDeployment();
    await (await factory.setPool(await validPool.getAddress())).wait();

    const NPM = await ethers.getContractFactory("MockNonfungiblePositionManager");
    const npm = await NPM.deploy();
    await npm.waitForDeployment();

    const Router = await ethers.getContractFactory("MockSwapRouter");
    const router = await Router.deploy();
    await router.waitForDeployment();

    const Safe = await ethers.getContractFactory("MockSafeHarness");
    const safe = await Safe.deploy();
    await safe.waitForDeployment();
    const safeAddr = await safe.getAddress();

    const Reg = await ethers.getContractFactory("MockRegistry");
    const reg = await Reg.deploy();
    await reg.waitForDeployment();
    await (await reg.setOperator(operatorEOA.address)).wait();

    const RHP = await ethers.getContractFactory("RatehopperUniV3Positions");
    const rhp = await RHP.deploy(
        await npm.getAddress(),
        await reg.getAddress(),
        usdcAddr,
        wethAddr,
        await router.getAddress(),
        await factory.getAddress(),
        treasury.address,
        Number(PERF_FEE_BPS),
        Number(COLLECT_FEE_BPS),
        MAX_FEE_BPS,
        deployer.address, // initialAdmin
        deployer.address, // timelock
        0,
        0,
    );
    await rhp.waitForDeployment();

    // Funding: Safe holds USDC to open with; router + NPM hold both legs so
    // swaps and collects can pay out.
    await (await usdc.mint(safeAddr, 10n ** 12n)).wait();
    await (await weth.mint(await router.getAddress(), 10n ** 24n)).wait();
    await (await usdc.mint(await router.getAddress(), 10n ** 18n)).wait();
    await (await weth.mint(await npm.getAddress(), 10n ** 24n)).wait();
    await (await usdc.mint(await npm.getAddress(), 10n ** 18n)).wait();

    return {
        deployer,
        operatorEOA,
        treasury,
        stranger,
        weth,
        usdc,
        wethAddr,
        usdcAddr,
        validPool,
        factory,
        npm,
        router,
        safe,
        safeAddr,
        reg,
        rhp,
    };
}

type Ctx = Awaited<ReturnType<typeof deployMockHarness>>;

// openLp via the operator on behalf of the mock Safe. Returns the tokenId.
async function openLp(ctx: Ctx, opts: { usdcAmount?: bigint; wethOut?: bigint } = {}): Promise<bigint> {
    const usdcAmount = opts.usdcAmount ?? USDC_AMOUNT;
    await (await ctx.router.setOutput(opts.wethOut ?? WETH_OUT)).wait();
    await (
        await ctx.rhp
            .connect(ctx.operatorEOA)
            .openLp(ctx.safeAddr, usdcAmount, 0, 0, 500, 0, 0, 500, 1n, 1n, SLIP, DEADLINE)
    ).wait();
    const ev = await ctx.rhp.queryFilter(ctx.rhp.filters.PositionOpened(ctx.safeAddr), -5);
    return ev[ev.length - 1].args.tokenId as bigint;
}

function openLpCall(ctx: Ctx) {
    return ctx.rhp
        .connect(ctx.operatorEOA)
        .openLp(ctx.safeAddr, USDC_AMOUNT, 0, 0, 500, 0, 0, 500, 1n, 1n, SLIP, DEADLINE);
}

function closeLpCall(ctx: Ctx, tokenId: bigint, exitBps = 10_000) {
    return ctx.rhp
        .connect(ctx.operatorEOA)
        .closeLp(ctx.safeAddr, tokenId, 500, 1n, 1n, SLIP, exitBps, 0, 0, DEADLINE, 0);
}

describe("RatehopperUniV3Positions - mock harness (no fork)", function () {
    // ── _validatePool branches (revert before any Safe interaction) ──────

    it("openLp reverts PoolDoesNotExist when the factory returns address(0)", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await (await ctx.factory.setPool(ZERO)).wait();
        await expect(openLpCall(ctx)).to.be.revertedWithCustomError(ctx.rhp, "PoolDoesNotExist");
    });

    it("openLp reverts WrongTokenPair when the pool's tokens are not WETH/USDC", async function () {
        const ctx = await loadFixture(deployMockHarness);
        const Pool = await ethers.getContractFactory("MockUniswapV3Pool");
        // token0 = USDC (wrong; should be WETH).
        const badPool = await Pool.deploy(ctx.usdcAddr, ctx.usdcAddr, Q96, 10n ** 18n);
        await (await ctx.factory.setPool(await badPool.getAddress())).wait();
        await expect(openLpCall(ctx)).to.be.revertedWithCustomError(ctx.rhp, "WrongTokenPair");
    });

    it("openLp reverts PoolNotInitialized when slot0 sqrtPriceX96 == 0", async function () {
        const ctx = await loadFixture(deployMockHarness);
        const Pool = await ethers.getContractFactory("MockUniswapV3Pool");
        const uninit = await Pool.deploy(ctx.wethAddr, ctx.usdcAddr, 0n, 10n ** 18n);
        await (await ctx.factory.setPool(await uninit.getAddress())).wait();
        await expect(openLpCall(ctx)).to.be.revertedWithCustomError(ctx.rhp, "PoolNotInitialized");
    });

    it("openLp reverts PoolTooThin when pool liquidity is below minPoolLiquidity", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await (await ctx.rhp.connect(ctx.deployer).setMinPoolLiquidity(2n ** 127n)).wait();
        await expect(openLpCall(ctx)).to.be.revertedWithCustomError(ctx.rhp, "PoolTooThin");
    });

    // ── openLp swap / mint defensive branches ───────────────────────────

    it("openLp reverts SwapFailed when the swap yields zero WETH", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await (await ctx.router.setOutput(0n)).wait();
        await expect(openLpCall(ctx)).to.be.revertedWithCustomError(ctx.rhp, "SwapFailed");
    });

    it("openLp reverts LpNotOnSafe when the minted NFT is not owned by the Safe", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await (await ctx.router.setOutput(WETH_OUT)).wait();
        await (await ctx.npm.setMintOwnerOverride(ctx.stranger.address)).wait();
        await expect(openLpCall(ctx)).to.be.revertedWithCustomError(ctx.rhp, "LpNotOnSafe");
    });

    it("openLp reverts PositionLiquidityTooLow when minted liquidity is below the floor", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await (await ctx.router.setOutput(WETH_OUT)).wait();
        await (await ctx.rhp.connect(ctx.deployer).setMinPositionLiquidity(2n ** 120n)).wait();
        await (await ctx.npm.setMintLiquidity(1n)).wait();
        await expect(openLpCall(ctx)).to.be.revertedWithCustomError(ctx.rhp, "PositionLiquidityTooLow");
    });

    // ── Module-call failure branches (_safeApprove / _safeExec / mint) ──

    it("openLp bubbles the inner revert reason when an approve module call fails with returndata", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await (await ctx.safe.setFailData(BUBBLE_DATA)).wait();
        await (await ctx.safe.setFail(ctx.usdcAddr, 2)).wait(); // first approve target = USDC
        await expect(openLpCall(ctx)).to.be.revertedWith(BUBBLE_REASON);
    });

    it("openLp reverts ModuleCallFailed(20) when an approve module call fails with empty returndata", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await (await ctx.safe.setFail(ctx.usdcAddr, 1)).wait();
        await expect(openLpCall(ctx)).to.be.revertedWithCustomError(ctx.rhp, "ModuleCallFailed").withArgs(20);
    });

    it("openLp bubbles the inner revert reason when the swap module call fails with returndata", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await (await ctx.router.setOutput(WETH_OUT)).wait();
        await (await ctx.safe.setFailData(BUBBLE_DATA)).wait();
        await (await ctx.safe.setFail(await ctx.router.getAddress(), 2)).wait();
        await expect(openLpCall(ctx)).to.be.revertedWith(BUBBLE_REASON);
    });

    it("openLp reverts ModuleCallFailed(3) when the swap module call fails with empty returndata", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await (await ctx.safe.setFail(await ctx.router.getAddress(), 1)).wait();
        await expect(openLpCall(ctx)).to.be.revertedWithCustomError(ctx.rhp, "ModuleCallFailed").withArgs(3);
    });

    it("openLp reverts ModuleCallFailed(4) when the mint module call fails", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await (await ctx.router.setOutput(WETH_OUT)).wait();
        await (await ctx.safe.setFail(await ctx.npm.getAddress(), 1)).wait();
        await expect(openLpCall(ctx)).to.be.revertedWithCustomError(ctx.rhp, "ModuleCallFailed").withArgs(4);
    });

    // ── closeLp / collectLp defensive branches ──────────────────────────

    it("collectLp reverts WrongTokenPair when the position is not a WETH/USDC pair", async function () {
        const ctx = await loadFixture(deployMockHarness);
        const tokenId = await openLp(ctx);
        await (await ctx.npm.setTokens(tokenId, ctx.stranger.address, ctx.usdcAddr)).wait();
        await expect(ctx.rhp.connect(ctx.operatorEOA).collectLp(ctx.safeAddr, tokenId)).to.be.revertedWithCustomError(
            ctx.rhp,
            "WrongTokenPair",
        );
    });

    it("collectLp tolerates a token whose fee transfer returns false (non-reverting): fee waived, full amount forwarded", async function () {
        const ctx = await loadFixture(deployMockHarness);
        const tokenId = await openLp(ctx);
        const owed0 = 1_000_000n;
        const owed1 = 1_000_000n;
        await (await ctx.npm.setOwed(tokenId, owed0, owed1)).wait();
        // WETH transfer to the treasury returns false (no revert) → else branch.
        await (await ctx.weth.setFalseTransferTo(ctx.treasury.address)).wait();

        const tWeth0 = await ctx.weth.balanceOf(ctx.treasury.address);
        const sWeth0 = await ctx.weth.balanceOf(ctx.safeAddr);

        await expect(ctx.rhp.connect(ctx.operatorEOA).collectLp(ctx.safeAddr, tokenId))
            .to.emit(ctx.rhp, "CollectFeeTransferFailed")
            .withArgs(ctx.safeAddr, tokenId, ctx.wethAddr, (owed0 * COLLECT_FEE_BPS) / 10_000n);

        const ev = (await ctx.rhp.queryFilter(ctx.rhp.filters.FeesCollected(ctx.safeAddr, tokenId), -5)).slice(-1)[0]
            .args;
        // WETH leg fee waived; full WETH forwarded to the Safe.
        expect(ev.fee0).to.equal(0n);
        expect((await ctx.weth.balanceOf(ctx.treasury.address)) - tWeth0).to.equal(0n);
        expect((await ctx.weth.balanceOf(ctx.safeAddr)) - sWeth0).to.equal(owed0);
        // USDC leg charged normally.
        expect(ev.fee1).to.equal((owed1 * COLLECT_FEE_BPS) / 10_000n);
    });

    // ── Happy lifecycle ─────────────────────────────────────────────────

    it("openLp mints a position, stores the basis, and leaves the NFT on the Safe", async function () {
        const ctx = await loadFixture(deployMockHarness);
        const tokenId = await openLp(ctx);
        expect(await ctx.npm.ownerOf(tokenId)).to.equal(ctx.safeAddr);
        // basis = halfUsdc (WETH leg valued at swap rate) + retainedUsdc = usdcAmount.
        expect(await ctx.rhp.residualBasisUsd6Of(tokenId)).to.equal(USDC_AMOUNT);
    });

    it("collectLp harvests owed fees, charges feeCollectBps, and forwards the remainder", async function () {
        const ctx = await loadFixture(deployMockHarness);
        const tokenId = await openLp(ctx);
        const owed0 = 800_000n;
        const owed1 = 400_000n;
        await (await ctx.npm.setOwed(tokenId, owed0, owed1)).wait();

        const tWeth0 = await ctx.weth.balanceOf(ctx.treasury.address);
        const tUsdc0 = await ctx.usdc.balanceOf(ctx.treasury.address);
        const sWeth0 = await ctx.weth.balanceOf(ctx.safeAddr);
        const sUsdc0 = await ctx.usdc.balanceOf(ctx.safeAddr);

        await (await ctx.rhp.connect(ctx.operatorEOA).collectLp(ctx.safeAddr, tokenId)).wait();

        const fee0 = (owed0 * COLLECT_FEE_BPS) / 10_000n;
        const fee1 = (owed1 * COLLECT_FEE_BPS) / 10_000n;
        expect((await ctx.weth.balanceOf(ctx.treasury.address)) - tWeth0).to.equal(fee0);
        expect((await ctx.usdc.balanceOf(ctx.treasury.address)) - tUsdc0).to.equal(fee1);
        expect((await ctx.weth.balanceOf(ctx.safeAddr)) - sWeth0).to.equal(owed0 - fee0);
        expect((await ctx.usdc.balanceOf(ctx.safeAddr)) - sUsdc0).to.equal(owed1 - fee1);
        // Position stays open.
        expect(await ctx.npm.ownerOf(tokenId)).to.equal(ctx.safeAddr);
        expect(await ctx.rhp.residualBasisUsd6Of(tokenId)).to.equal(USDC_AMOUNT);
        // RHP keeps no residual of either leg.
        expect(await ctx.weth.balanceOf(await ctx.rhp.getAddress())).to.equal(0n);
        expect(await ctx.usdc.balanceOf(await ctx.rhp.getAddress())).to.equal(0n);
    });

    it("closeLp (full) charges a performance fee on net profit and burns the NFT", async function () {
        const ctx = await loadFixture(deployMockHarness);
        const tokenId = await openLp(ctx);

        // Realized USDC = 500_000 (principal) + closeOutput. basis = 1_000_000.
        const closeOutput = 1_000_000n;
        await (await ctx.router.setOutput(closeOutput)).wait();

        const tUsdc0 = await ctx.usdc.balanceOf(ctx.treasury.address);
        await (await closeLpCall(ctx, tokenId)).wait();

        const ev = (await ctx.rhp.queryFilter(ctx.rhp.filters.PositionClosed(ctx.safeAddr, tokenId), -5)).slice(-1)[0]
            .args;
        const currentValue = HALF + closeOutput; // 500_000 + 1_000_000
        const expectedFee = ((currentValue - USDC_AMOUNT) * PERF_FEE_BPS) / 10_000n;
        expect(ev.basisUsd6).to.equal(USDC_AMOUNT);
        expect(ev.currentValueUsd6).to.equal(currentValue);
        expect(ev.feeUsd6).to.equal(expectedFee);
        expect(ev.feeUsd6).to.be.gt(0n);
        expect(Number(ev.exitBps)).to.equal(10_000);
        expect((await ctx.usdc.balanceOf(ctx.treasury.address)) - tUsdc0).to.equal(expectedFee);
        // NFT burned + basis cleared.
        expect(await ctx.rhp.residualBasisUsd6Of(tokenId)).to.equal(0n);
        expect(await ctx.npm.ownerOf(tokenId)).to.equal(ZERO);
    });

    it("closeLp (full) charges no performance fee at break-even / loss", async function () {
        const ctx = await loadFixture(deployMockHarness);
        const tokenId = await openLp(ctx);

        // Realized = 500_000 + 400_000 = 900_000 < basis 1_000_000 → no fee.
        await (await ctx.router.setOutput(400_000n)).wait();
        const tUsdc0 = await ctx.usdc.balanceOf(ctx.treasury.address);
        await (await closeLpCall(ctx, tokenId)).wait();

        const ev = (await ctx.rhp.queryFilter(ctx.rhp.filters.PositionClosed(ctx.safeAddr, tokenId), -5)).slice(-1)[0]
            .args;
        expect(ev.feeUsd6).to.equal(0n);
        expect((await ctx.usdc.balanceOf(ctx.treasury.address)) - tUsdc0).to.equal(0n);
        expect(await ctx.rhp.residualBasisUsd6Of(tokenId)).to.equal(0n);
    });

    it("closeLp (partial) decrements basis pro-rata and keeps the position open", async function () {
        const ctx = await loadFixture(deployMockHarness);
        const tokenId = await openLp(ctx);
        await (await ctx.router.setOutput(300_000n)).wait();

        await (await closeLpCall(ctx, tokenId, 5_000)).wait();

        const ev = (await ctx.rhp.queryFilter(ctx.rhp.filters.PositionClosed(ctx.safeAddr, tokenId), -5)).slice(-1)[0]
            .args;
        expect(Number(ev.exitBps)).to.equal(5_000);
        expect(ev.basisUsd6).to.equal(USDC_AMOUNT / 2n);
        // Residual basis halved; NFT still on the Safe (not burned).
        expect(await ctx.rhp.residualBasisUsd6Of(tokenId)).to.equal(USDC_AMOUNT / 2n);
        expect(await ctx.npm.ownerOf(tokenId)).to.equal(ctx.safeAddr);
    });

    it("handles a USDC-only position: collectLp (collected0 == 0) and closeLp (wethToSwap == 0)", async function () {
        const ctx = await loadFixture(deployMockHarness);
        const tokenId = await openLp(ctx);
        // Reshape the position to be USDC-only (no WETH principal); basis stays
        // in RHP storage from openLp.
        await (
            await ctx.npm.seedPosition(tokenId, ctx.safeAddr, ctx.wethAddr, ctx.usdcAddr, 500, 1_000_000n, 0n, 500_000n)
        ).wait();

        // collectLp with only USDC owed → _collectLp `collected0 == 0` branch.
        await (await ctx.npm.setOwed(tokenId, 0n, 300_000n)).wait();
        await (await ctx.rhp.connect(ctx.operatorEOA).collectLp(ctx.safeAddr, tokenId)).wait();
        const cev = (await ctx.rhp.queryFilter(ctx.rhp.filters.FeesCollected(ctx.safeAddr, tokenId), -5)).slice(-1)[0]
            .args;
        expect(cev.collected0).to.equal(0n);
        expect(cev.collected1).to.equal(300_000n);

        // closeLp full → no WETH collected → `wethToSwap == 0` (swap skipped).
        await (await ctx.router.setOutput(0n)).wait();
        await (await closeLpCall(ctx, tokenId)).wait();
        const ev = (await ctx.rhp.queryFilter(ctx.rhp.filters.PositionClosed(ctx.safeAddr, tokenId), -5)).slice(-1)[0]
            .args;
        expect(Number(ev.exitBps)).to.equal(10_000);
        expect(await ctx.rhp.residualBasisUsd6Of(tokenId)).to.equal(0n);
    });

    // ── Access-control modifier branches ────────────────────────────────

    it("openLp reverts ZeroAddress when _onBehalfOf is the zero address", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await expect(
            ctx.rhp.connect(ctx.operatorEOA).openLp(ZERO, USDC_AMOUNT, 0, 0, 500, 0, 0, 500, 1n, 1n, SLIP, DEADLINE),
        ).to.be.revertedWithCustomError(ctx.rhp, "ZeroAddress");
    });

    it("openLp reverts NotAuthorized for a caller that is neither operator nor Safe", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await expect(
            ctx.rhp
                .connect(ctx.stranger)
                .openLp(ctx.safeAddr, USDC_AMOUNT, 0, 0, 500, 0, 0, 500, 1n, 1n, SLIP, DEADLINE),
        ).to.be.revertedWithCustomError(ctx.rhp, "NotAuthorized");
    });

    it("closeLp reverts ZeroAddress when _onBehalfOf is the zero address", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await expect(
            ctx.rhp.connect(ctx.operatorEOA).closeLp(ZERO, 1n, 500, 1n, 1n, SLIP, 5_000, 0, 0, DEADLINE, 0),
        ).to.be.revertedWithCustomError(ctx.rhp, "ZeroAddress");
    });

    it("closeLp reverts NotAuthorized for a caller that is neither operator nor Safe", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await expect(
            ctx.rhp.connect(ctx.stranger).closeLp(ctx.safeAddr, 1n, 500, 1n, 1n, SLIP, 5_000, 0, 0, DEADLINE, 0),
        ).to.be.revertedWithCustomError(ctx.rhp, "NotAuthorized");
    });

    it("collectLp reverts ZeroAddress when _onBehalfOf is the zero address", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await expect(ctx.rhp.connect(ctx.operatorEOA).collectLp(ZERO, 1n)).to.be.revertedWithCustomError(
            ctx.rhp,
            "ZeroAddress",
        );
    });

    it("collectLp reverts NotAuthorized for a caller that is neither operator nor Safe", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await expect(ctx.rhp.connect(ctx.stranger).collectLp(ctx.safeAddr, 1n)).to.be.revertedWithCustomError(
            ctx.rhp,
            "NotAuthorized",
        );
    });

    // ── Remaining openLp entry guards ───────────────────────────────────

    it("openLp reverts InvalidUsdcAmount when usdcAmount == 0", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await expect(
            ctx.rhp.connect(ctx.operatorEOA).openLp(ctx.safeAddr, 0, 0, 0, 500, 0, 0, 500, 1n, 1n, SLIP, DEADLINE),
        ).to.be.revertedWithCustomError(ctx.rhp, "InvalidUsdcAmount");
    });

    it("openLp reverts SlippageAboveMax when slippageBps exceeds maxSlippageBps", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await expect(
            ctx.rhp
                .connect(ctx.operatorEOA)
                .openLp(ctx.safeAddr, USDC_AMOUNT, 0, 0, 500, 0, 0, 500, 1n, 1n, 9999, DEADLINE),
        ).to.be.revertedWithCustomError(ctx.rhp, "SlippageAboveMax");
    });

    it("openLp reverts FeeTierNotAllowed for a disallowed LP fee tier", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await expect(
            ctx.rhp
                .connect(ctx.operatorEOA)
                .openLp(ctx.safeAddr, USDC_AMOUNT, 0, 0, 10000, 0, 0, 500, 1n, 1n, SLIP, DEADLINE),
        ).to.be.revertedWithCustomError(ctx.rhp, "FeeTierNotAllowed");
    });

    it("openLp reverts FeeTierNotAllowed for a disallowed swap fee tier", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await expect(
            ctx.rhp
                .connect(ctx.operatorEOA)
                .openLp(ctx.safeAddr, USDC_AMOUNT, 0, 0, 500, 0, 0, 10000, 1n, 1n, SLIP, DEADLINE),
        ).to.be.revertedWithCustomError(ctx.rhp, "FeeTierNotAllowed");
    });

    it("openLp reverts InvalidSwapAmountOutMin when swapAmountOutMin == 0", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await expect(
            ctx.rhp
                .connect(ctx.operatorEOA)
                .openLp(ctx.safeAddr, USDC_AMOUNT, 0, 0, 500, 0, 0, 500, 0n, 1n, SLIP, DEADLINE),
        ).to.be.revertedWithCustomError(ctx.rhp, "InvalidSwapAmountOutMin");
    });

    it("openLp reverts WrongTokenPair when only the pool's token1 is wrong (second operand)", async function () {
        const ctx = await loadFixture(deployMockHarness);
        const Pool = await ethers.getContractFactory("MockUniswapV3Pool");
        const badPool = await Pool.deploy(ctx.wethAddr, ctx.stranger.address, Q96, 10n ** 18n);
        await (await ctx.factory.setPool(await badPool.getAddress())).wait();
        await expect(openLpCall(ctx)).to.be.revertedWithCustomError(ctx.rhp, "WrongTokenPair");
    });

    // ── closeLp entry guards ────────────────────────────────────────────

    it("closeLp reverts InvalidExitBps for exitBps == 0 and exitBps > 10_000", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await expect(closeLpCall(ctx, 1n, 0)).to.be.revertedWithCustomError(ctx.rhp, "InvalidExitBps");
        await expect(closeLpCall(ctx, 1n, 10_001)).to.be.revertedWithCustomError(ctx.rhp, "InvalidExitBps");
    });

    it("closeLp reverts SlippageAboveMax when slippageBps exceeds maxSlippageBps", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await expect(
            ctx.rhp.connect(ctx.operatorEOA).closeLp(ctx.safeAddr, 1n, 500, 1n, 1n, 9999, 5_000, 0, 0, DEADLINE, 0),
        ).to.be.revertedWithCustomError(ctx.rhp, "SlippageAboveMax");
    });

    it("closeLp reverts FeeTierNotAllowed for a disallowed swap fee tier", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await expect(
            ctx.rhp.connect(ctx.operatorEOA).closeLp(ctx.safeAddr, 1n, 10000, 1n, 1n, SLIP, 5_000, 0, 0, DEADLINE, 0),
        ).to.be.revertedWithCustomError(ctx.rhp, "FeeTierNotAllowed");
    });

    it("closeLp reverts InvalidSwapAmountOutMin when swapAmountOutMin == 0", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await expect(
            ctx.rhp.connect(ctx.operatorEOA).closeLp(ctx.safeAddr, 1n, 500, 0n, 1n, SLIP, 5_000, 0, 0, DEADLINE, 0),
        ).to.be.revertedWithCustomError(ctx.rhp, "InvalidSwapAmountOutMin");
    });

    it("closeLp reverts UnknownPosition for a tokenId never opened via this contract", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await expect(closeLpCall(ctx, 999n)).to.be.revertedWithCustomError(ctx.rhp, "UnknownPosition");
    });

    it("collectLp reverts UnknownPosition for a tokenId never opened via this contract", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await expect(ctx.rhp.connect(ctx.operatorEOA).collectLp(ctx.safeAddr, 999n)).to.be.revertedWithCustomError(
            ctx.rhp,
            "UnknownPosition",
        );
    });

    it("collectLp reverts LpNotOnSafe when the position is owned by another address", async function () {
        const ctx = await loadFixture(deployMockHarness);
        const tokenId = await openLp(ctx);
        await (await ctx.npm.setOwner(tokenId, ctx.stranger.address)).wait();
        await expect(ctx.rhp.connect(ctx.operatorEOA).collectLp(ctx.safeAddr, tokenId)).to.be.revertedWithCustomError(
            ctx.rhp,
            "LpNotOnSafe",
        );
    });

    it("collectLp reverts WrongTokenPair when only token1 is wrong (second operand)", async function () {
        const ctx = await loadFixture(deployMockHarness);
        const tokenId = await openLp(ctx);
        await (await ctx.npm.setTokens(tokenId, ctx.wethAddr, ctx.stranger.address)).wait();
        await expect(ctx.rhp.connect(ctx.operatorEOA).collectLp(ctx.safeAddr, tokenId)).to.be.revertedWithCustomError(
            ctx.rhp,
            "WrongTokenPair",
        );
    });

    it("closeLp reverts MinUsdcOutNotMet when realized USDC is below minUsdcOut", async function () {
        const ctx = await loadFixture(deployMockHarness);
        const tokenId = await openLp(ctx);
        await (await ctx.router.setOutput(1_000_000n)).wait();
        await expect(
            ctx.rhp
                .connect(ctx.operatorEOA)
                .closeLp(ctx.safeAddr, tokenId, 500, 1n, 1n, SLIP, 10_000, 0, 0, DEADLINE, 10n ** 18n),
        ).to.be.revertedWithCustomError(ctx.rhp, "MinUsdcOutNotMet");
    });

    it("closeLp reverts InvalidExitBps (L-4) when a partial exit would remove zero liquidity", async function () {
        const ctx = await loadFixture(deployMockHarness);
        const tokenId = await openLp(ctx);
        // Tiny-liquidity position → liquidityToRemove truncates to 0 while
        // basisForExit stays > 0.
        await (
            await ctx.npm.seedPosition(tokenId, ctx.safeAddr, ctx.wethAddr, ctx.usdcAddr, 500, 1n, 0n, 500_000n)
        ).wait();
        await expect(closeLpCall(ctx, tokenId, 5_000)).to.be.revertedWithCustomError(ctx.rhp, "InvalidExitBps");
    });

    it("closeLp partial dust no-op: zero basisForExit and zero liquidityToRemove leaves the position untouched", async function () {
        const ctx = await loadFixture(deployMockHarness);
        // basis = 2 (usdcAmount = 2) and liquidity = 1, so a 1-bps exit floors
        // both basisForExit and liquidityToRemove to 0 → the L-4 guard does not
        // fire (basisForExit == 0) and the decrease block (line 583) is skipped.
        await (await ctx.npm.setMintLiquidity(1n)).wait();
        const tokenId = await openLp(ctx, { usdcAmount: 2n });
        expect(await ctx.rhp.residualBasisUsd6Of(tokenId)).to.equal(2n);

        await (await ctx.router.setOutput(0n)).wait();
        await (await closeLpCall(ctx, tokenId, 1)).wait();

        // No basis drawn down, position untouched and still open.
        expect(await ctx.rhp.residualBasisUsd6Of(tokenId)).to.equal(2n);
        expect(await ctx.npm.ownerOf(tokenId)).to.equal(ctx.safeAddr);
    });

    it("closeLp charges no performance fee when the profit rounds the fee to zero", async function () {
        const ctx = await loadFixture(deployMockHarness);
        const tokenId = await openLp(ctx);
        // currentValue = 500_000 + 500_005 = 1_000_005; profit = 5; fee = 5*1000/10000 = 0.
        await (await ctx.router.setOutput(500_005n)).wait();
        await (await closeLpCall(ctx, tokenId)).wait();
        const ev = (await ctx.rhp.queryFilter(ctx.rhp.filters.PositionClosed(ctx.safeAddr, tokenId), -5)).slice(-1)[0]
            .args;
        expect(ev.currentValueUsd6).to.be.gt(ev.basisUsd6);
        expect(ev.feeUsd6).to.equal(0n);
    });

    it("closeLp waives the performance fee (FeeTransferFailed) when the treasury transfer reverts", async function () {
        const ctx = await loadFixture(deployMockHarness);
        const tokenId = await openLp(ctx);
        await (await ctx.router.setOutput(1_000_000n)).wait(); // profit
        await (await ctx.usdc.setRevertTransferTo(ctx.treasury.address)).wait();
        const tUsdc0 = await ctx.usdc.balanceOf(ctx.treasury.address);
        await expect(closeLpCall(ctx, tokenId)).to.emit(ctx.rhp, "FeeTransferFailed");
        const ev = (await ctx.rhp.queryFilter(ctx.rhp.filters.PositionClosed(ctx.safeAddr, tokenId), -5)).slice(-1)[0]
            .args;
        expect(ev.feeUsd6).to.equal(0n);
        expect((await ctx.usdc.balanceOf(ctx.treasury.address)) - tUsdc0).to.equal(0n);
    });

    it("collectLp surfaces CollectFeeTransferFailed (catch branch) when the fee transfer reverts", async function () {
        const ctx = await loadFixture(deployMockHarness);
        const tokenId = await openLp(ctx);
        await (await ctx.npm.setOwed(tokenId, 1_000_000n, 1_000_000n)).wait();
        await (await ctx.weth.setRevertTransferTo(ctx.treasury.address)).wait();
        await expect(ctx.rhp.connect(ctx.operatorEOA).collectLp(ctx.safeAddr, tokenId))
            .to.emit(ctx.rhp, "CollectFeeTransferFailed")
            .withArgs(ctx.safeAddr, tokenId, ctx.wethAddr, (1_000_000n * COLLECT_FEE_BPS) / 10_000n);
        const ev = (await ctx.rhp.queryFilter(ctx.rhp.filters.FeesCollected(ctx.safeAddr, tokenId), -5)).slice(-1)[0]
            .args;
        expect(ev.fee0).to.equal(0n);
    });

    it("collectLp with feeCollectBps == 0 skims nothing (fee == 0 branch)", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await (await ctx.rhp.connect(ctx.deployer).setFeeCollectBps(0)).wait();
        const tokenId = await openLp(ctx);
        await (await ctx.npm.setOwed(tokenId, 800_000n, 400_000n)).wait();
        const tWeth0 = await ctx.weth.balanceOf(ctx.treasury.address);
        await (await ctx.rhp.connect(ctx.operatorEOA).collectLp(ctx.safeAddr, tokenId)).wait();
        const ev = (await ctx.rhp.queryFilter(ctx.rhp.filters.FeesCollected(ctx.safeAddr, tokenId), -5)).slice(-1)[0]
            .args;
        expect(ev.fee0).to.equal(0n);
        expect(ev.fee1).to.equal(0n);
        expect((await ctx.weth.balanceOf(ctx.treasury.address)) - tWeth0).to.equal(0n);
    });

    // ── rescueERC721 ────────────────────────────────────────────────────

    it("rescueERC721 transfers a stranded NFT and rejects zero addresses / non-admin", async function () {
        const ctx = await loadFixture(deployMockHarness);
        const ERC721 = await ethers.getContractFactory("MockERC721");
        const nft = await ERC721.deploy();
        await nft.waitForDeployment();
        const nftAddr = await nft.getAddress();
        await (await nft.mint(await ctx.rhp.getAddress(), 7n)).wait();

        await expect(ctx.rhp.connect(ctx.deployer).rescueERC721(nftAddr, 7n, ctx.stranger.address))
            .to.emit(ctx.rhp, "NftRescued")
            .withArgs(nftAddr, ctx.stranger.address, 7n);
        expect(await nft.ownerOf(7n)).to.equal(ctx.stranger.address);

        await expect(
            ctx.rhp.connect(ctx.deployer).rescueERC721(ZERO, 7n, ctx.stranger.address),
        ).to.be.revertedWithCustomError(ctx.rhp, "ZeroAddress");
        await expect(ctx.rhp.connect(ctx.deployer).rescueERC721(nftAddr, 7n, ZERO)).to.be.revertedWithCustomError(
            ctx.rhp,
            "ZeroAddress",
        );
        await expect(
            ctx.rhp.connect(ctx.stranger).rescueERC721(nftAddr, 7n, ctx.stranger.address),
        ).to.be.revertedWithCustomError(ctx.rhp, "AccessControlUnauthorizedAccount");
    });
});
