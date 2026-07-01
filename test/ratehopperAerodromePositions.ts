import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

// ─────────────────────────────────────────────────────────────────────────
//  Mock-driven unit/branch-coverage suite for RatehopperAerodromePositions.
//
//  RatehopperAerodromePositions is a near-clone of RatehopperUniV3Positions for
//  Aerodrome Slipstream (CL) pools, so this suite mirrors
//  ratehopperUniV3PositionsMocks.ts — wiring the helper to fully-controlled CL
//  mocks (a Safe-module executor, a Slipstream swap router, a CL NPM, a CL
//  factory/pool, and ERC20s) so the entire openLp / closeLp / collectLp
//  lifecycle AND every defensive revert branch run deterministically with no
//  external dependencies.
//
//  Slipstream-specific coverage on top of the Uniswap suite:
//    - pools are keyed by `int24 tickSpacing` (not `uint24 fee`); the disallowed
//      path reverts `TickSpacingNotAllowed`;
//    - the swap router's `exactInputSingle` carries `tickSpacing` + `deadline`,
//      so its compiler-derived selector IS the recomputed `0xa026383e` — the
//      mock only dispatches if the helper's pinned selector matches, making
//      every successful swap an implicit selector check.
// ─────────────────────────────────────────────────────────────────────────

const ZERO = "0x0000000000000000000000000000000000000000";
const DEADLINE = ethers.MaxUint256;
const SLIP = 100; // 1%
const PERF_FEE_BPS = 1000n; // 10%
const COLLECT_FEE_BPS = 250n; // 2.5%
const MAX_FEE_BPS = 2000;
const Q96 = 1n << 96n;

// Allowed (default) vs disallowed Slipstream tick spacings. Defaults are
// {100, 200}; 60 is a Uniswap-style spacing that is NOT in the allow-list.
const TS = 100;
const BAD_TS = 60;

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
    // The helper requires WETH < USDC by address.
    const [weth, usdc] = addrA < addrB ? [tokenA, tokenB] : [tokenB, tokenA];
    const wethAddr = await weth.getAddress();
    const usdcAddr = await usdc.getAddress();

    const Pool = await ethers.getContractFactory("MockCLPool");
    const validPool = await Pool.deploy(wethAddr, usdcAddr, Q96, 10n ** 18n);
    await validPool.waitForDeployment();

    const Factory = await ethers.getContractFactory("MockCLFactory");
    const factory = await Factory.deploy();
    await factory.waitForDeployment();
    await (await factory.setPool(await validPool.getAddress())).wait();

    const NPM = await ethers.getContractFactory("MockCLNonfungiblePositionManager");
    const npm = await NPM.deploy();
    await npm.waitForDeployment();

    const Router = await ethers.getContractFactory("MockSlipstreamSwapRouter");
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

    const RHA = await ethers.getContractFactory("RatehopperAerodromePositions");
    const rha = await RHA.deploy(
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
    await rha.waitForDeployment();

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
        rha,
    };
}

type Ctx = Awaited<ReturnType<typeof deployMockHarness>>;

// openLp via the operator on behalf of the mock Safe. Returns the tokenId.
async function openLp(ctx: Ctx, opts: { usdcAmount?: bigint; wethOut?: bigint } = {}): Promise<bigint> {
    const usdcAmount = opts.usdcAmount ?? USDC_AMOUNT;
    await (await ctx.router.setOutput(opts.wethOut ?? WETH_OUT)).wait();
    await (
        await ctx.rha
            .connect(ctx.operatorEOA)
            .openLp(ctx.safeAddr, usdcAmount, 0, 0, TS, 0, 0, TS, 1n, 1n, SLIP, DEADLINE)
    ).wait();
    const ev = await ctx.rha.queryFilter(ctx.rha.filters.PositionOpened(ctx.safeAddr), -5);
    return ev[ev.length - 1].args.tokenId as bigint;
}

function openLpCall(ctx: Ctx) {
    return ctx.rha
        .connect(ctx.operatorEOA)
        .openLp(ctx.safeAddr, USDC_AMOUNT, 0, 0, TS, 0, 0, TS, 1n, 1n, SLIP, DEADLINE);
}

function closeLpCall(ctx: Ctx, tokenId: bigint, exitBps = 10_000) {
    return ctx.rha
        .connect(ctx.operatorEOA)
        .closeLp(ctx.safeAddr, tokenId, TS, 1n, 1n, SLIP, exitBps, 0, 0, DEADLINE, 0);
}

function collectLpCall(
    ctx: Ctx,
    tokenId: bigint,
    opts: {
        swap?: boolean;
        tickSpacing?: number;
        amountOutMin?: bigint;
        expectedOut?: bigint;
        slippage?: number;
        deadline?: bigint;
    } = {},
) {
    return ctx.rha
        .connect(ctx.operatorEOA)
        .collectLp(
            ctx.safeAddr,
            tokenId,
            opts.swap ?? true,
            opts.tickSpacing ?? TS,
            opts.amountOutMin ?? 1n,
            opts.expectedOut ?? 1n,
            opts.slippage ?? SLIP,
            opts.deadline ?? DEADLINE,
        );
}

describe("RatehopperAerodromePositions - mock harness (no fork)", function () {
    // ── selector / defaults sanity ──────────────────────────────────────

    it("defaults allow tick spacings 100 and 200, not 60", async function () {
        const ctx = await loadFixture(deployMockHarness);
        expect(await ctx.rha.allowedTickSpacing(100)).to.equal(true);
        expect(await ctx.rha.allowedTickSpacing(200)).to.equal(true);
        expect(await ctx.rha.allowedTickSpacing(60)).to.equal(false);
    });

    // ── _validatePool branches (revert before any Safe interaction) ──────

    it("openLp reverts PoolDoesNotExist when the factory returns address(0)", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await (await ctx.factory.setPool(ZERO)).wait();
        await expect(openLpCall(ctx)).to.be.revertedWithCustomError(ctx.rha, "PoolDoesNotExist");
    });

    it("openLp reverts WrongTokenPair when the pool's tokens are not WETH/USDC", async function () {
        const ctx = await loadFixture(deployMockHarness);
        const Pool = await ethers.getContractFactory("MockCLPool");
        // token0 = USDC (wrong; should be WETH).
        const badPool = await Pool.deploy(ctx.usdcAddr, ctx.usdcAddr, Q96, 10n ** 18n);
        await (await ctx.factory.setPool(await badPool.getAddress())).wait();
        await expect(openLpCall(ctx)).to.be.revertedWithCustomError(ctx.rha, "WrongTokenPair");
    });

    it("openLp reverts PoolNotInitialized when slot0 sqrtPriceX96 == 0", async function () {
        const ctx = await loadFixture(deployMockHarness);
        const Pool = await ethers.getContractFactory("MockCLPool");
        const uninit = await Pool.deploy(ctx.wethAddr, ctx.usdcAddr, 0n, 10n ** 18n);
        await (await ctx.factory.setPool(await uninit.getAddress())).wait();
        await expect(openLpCall(ctx)).to.be.revertedWithCustomError(ctx.rha, "PoolNotInitialized");
    });

    it("openLp reverts PoolTooThin when pool liquidity is below minPoolLiquidity", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await (await ctx.rha.connect(ctx.deployer).setMinPoolLiquidity(2n ** 127n)).wait();
        await expect(openLpCall(ctx)).to.be.revertedWithCustomError(ctx.rha, "PoolTooThin");
    });

    // ── openLp swap / mint defensive branches ───────────────────────────

    it("openLp reverts SwapFailed when the swap yields zero WETH", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await (await ctx.router.setOutput(0n)).wait();
        await expect(openLpCall(ctx)).to.be.revertedWithCustomError(ctx.rha, "SwapFailed");
    });

    it("openLp reverts LpNotOnSafe when the minted NFT is not owned by the Safe", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await (await ctx.router.setOutput(WETH_OUT)).wait();
        await (await ctx.npm.setMintOwnerOverride(ctx.stranger.address)).wait();
        await expect(openLpCall(ctx)).to.be.revertedWithCustomError(ctx.rha, "LpNotOnSafe");
    });

    it("openLp reverts PositionLiquidityTooLow when minted liquidity is below the floor", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await (await ctx.router.setOutput(WETH_OUT)).wait();
        await (await ctx.rha.connect(ctx.deployer).setMinPositionLiquidity(2n ** 120n)).wait();
        await (await ctx.npm.setMintLiquidity(1n)).wait();
        await expect(openLpCall(ctx)).to.be.revertedWithCustomError(ctx.rha, "PositionLiquidityTooLow");
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
        await expect(openLpCall(ctx)).to.be.revertedWithCustomError(ctx.rha, "ModuleCallFailed").withArgs(20);
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
        await expect(openLpCall(ctx)).to.be.revertedWithCustomError(ctx.rha, "ModuleCallFailed").withArgs(3);
    });

    it("openLp reverts ModuleCallFailed(4) when the mint module call fails", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await (await ctx.router.setOutput(WETH_OUT)).wait();
        await (await ctx.safe.setFail(await ctx.npm.getAddress(), 1)).wait();
        await expect(openLpCall(ctx)).to.be.revertedWithCustomError(ctx.rha, "ModuleCallFailed").withArgs(4);
    });

    // ── closeLp / collectLp defensive branches ──────────────────────────

    it("collectLp reverts WrongTokenPair when the position is not a WETH/USDC pair", async function () {
        const ctx = await loadFixture(deployMockHarness);
        const tokenId = await openLp(ctx);
        await (await ctx.npm.setTokens(tokenId, ctx.stranger.address, ctx.usdcAddr)).wait();
        await expect(
            ctx.rha.connect(ctx.operatorEOA).collectLp(ctx.safeAddr, tokenId, false, TS, 1n, 1n, SLIP, DEADLINE),
        ).to.be.revertedWithCustomError(ctx.rha, "WrongTokenPair");
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

        await expect(
            ctx.rha.connect(ctx.operatorEOA).collectLp(ctx.safeAddr, tokenId, false, TS, 1n, 1n, SLIP, DEADLINE),
        )
            .to.emit(ctx.rha, "CollectFeeTransferFailed")
            .withArgs(ctx.safeAddr, tokenId, ctx.wethAddr, (owed0 * COLLECT_FEE_BPS) / 10_000n);

        const ev = (await ctx.rha.queryFilter(ctx.rha.filters.FeesCollected(ctx.safeAddr, tokenId), -5)).slice(-1)[0]
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
        expect(await ctx.rha.residualBasisUsd6Of(tokenId)).to.equal(USDC_AMOUNT);
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

        await (
            await ctx.rha.connect(ctx.operatorEOA).collectLp(ctx.safeAddr, tokenId, false, TS, 1n, 1n, SLIP, DEADLINE)
        ).wait();

        const fee0 = (owed0 * COLLECT_FEE_BPS) / 10_000n;
        const fee1 = (owed1 * COLLECT_FEE_BPS) / 10_000n;
        expect((await ctx.weth.balanceOf(ctx.treasury.address)) - tWeth0).to.equal(fee0);
        expect((await ctx.usdc.balanceOf(ctx.treasury.address)) - tUsdc0).to.equal(fee1);
        expect((await ctx.weth.balanceOf(ctx.safeAddr)) - sWeth0).to.equal(owed0 - fee0);
        expect((await ctx.usdc.balanceOf(ctx.safeAddr)) - sUsdc0).to.equal(owed1 - fee1);
        // Position stays open.
        expect(await ctx.npm.ownerOf(tokenId)).to.equal(ctx.safeAddr);
        expect(await ctx.rha.residualBasisUsd6Of(tokenId)).to.equal(USDC_AMOUNT);
        // RHA keeps no residual of either leg.
        expect(await ctx.weth.balanceOf(await ctx.rha.getAddress())).to.equal(0n);
        expect(await ctx.usdc.balanceOf(await ctx.rha.getAddress())).to.equal(0n);
    });

    it("closeLp (full) charges a performance fee on net profit and burns the NFT", async function () {
        const ctx = await loadFixture(deployMockHarness);
        const tokenId = await openLp(ctx);

        // Realized USDC = 500_000 (principal) + closeOutput. basis = 1_000_000.
        const closeOutput = 1_000_000n;
        await (await ctx.router.setOutput(closeOutput)).wait();

        const tUsdc0 = await ctx.usdc.balanceOf(ctx.treasury.address);
        await (await closeLpCall(ctx, tokenId)).wait();

        const ev = (await ctx.rha.queryFilter(ctx.rha.filters.PositionClosed(ctx.safeAddr, tokenId), -5)).slice(-1)[0]
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
        expect(await ctx.rha.residualBasisUsd6Of(tokenId)).to.equal(0n);
        expect(await ctx.npm.ownerOf(tokenId)).to.equal(ZERO);
    });

    it("closeLp (full) charges no performance fee at break-even / loss", async function () {
        const ctx = await loadFixture(deployMockHarness);
        const tokenId = await openLp(ctx);

        // Realized = 500_000 + 400_000 = 900_000 < basis 1_000_000 → no fee.
        await (await ctx.router.setOutput(400_000n)).wait();
        const tUsdc0 = await ctx.usdc.balanceOf(ctx.treasury.address);
        await (await closeLpCall(ctx, tokenId)).wait();

        const ev = (await ctx.rha.queryFilter(ctx.rha.filters.PositionClosed(ctx.safeAddr, tokenId), -5)).slice(-1)[0]
            .args;
        expect(ev.feeUsd6).to.equal(0n);
        expect((await ctx.usdc.balanceOf(ctx.treasury.address)) - tUsdc0).to.equal(0n);
        expect(await ctx.rha.residualBasisUsd6Of(tokenId)).to.equal(0n);
    });

    it("closeLp (partial) decrements basis pro-rata and keeps the position open", async function () {
        const ctx = await loadFixture(deployMockHarness);
        const tokenId = await openLp(ctx);
        await (await ctx.router.setOutput(300_000n)).wait();

        await (await closeLpCall(ctx, tokenId, 5_000)).wait();

        const ev = (await ctx.rha.queryFilter(ctx.rha.filters.PositionClosed(ctx.safeAddr, tokenId), -5)).slice(-1)[0]
            .args;
        expect(Number(ev.exitBps)).to.equal(5_000);
        expect(ev.basisUsd6).to.equal(USDC_AMOUNT / 2n);
        // Residual basis halved; NFT still on the Safe (not burned).
        expect(await ctx.rha.residualBasisUsd6Of(tokenId)).to.equal(USDC_AMOUNT / 2n);
        expect(await ctx.npm.ownerOf(tokenId)).to.equal(ctx.safeAddr);
    });

    it("handles a USDC-only position: collectLp (collected0 == 0) and closeLp (wethToSwap == 0)", async function () {
        const ctx = await loadFixture(deployMockHarness);
        const tokenId = await openLp(ctx);
        // Reshape the position to be USDC-only (no WETH principal); basis stays
        // in RHA storage from openLp.
        await (
            await ctx.npm.seedPosition(tokenId, ctx.safeAddr, ctx.wethAddr, ctx.usdcAddr, TS, 1_000_000n, 0n, 500_000n)
        ).wait();

        // collectLp with only USDC owed → _collectLp `collected0 == 0` branch.
        await (await ctx.npm.setOwed(tokenId, 0n, 300_000n)).wait();
        await (
            await ctx.rha.connect(ctx.operatorEOA).collectLp(ctx.safeAddr, tokenId, false, TS, 1n, 1n, SLIP, DEADLINE)
        ).wait();
        const cev = (await ctx.rha.queryFilter(ctx.rha.filters.FeesCollected(ctx.safeAddr, tokenId), -5)).slice(-1)[0]
            .args;
        expect(cev.collected0).to.equal(0n);
        expect(cev.collected1).to.equal(300_000n);

        // closeLp full → no WETH collected → `wethToSwap == 0` (swap skipped).
        await (await ctx.router.setOutput(0n)).wait();
        await (await closeLpCall(ctx, tokenId)).wait();
        const ev = (await ctx.rha.queryFilter(ctx.rha.filters.PositionClosed(ctx.safeAddr, tokenId), -5)).slice(-1)[0]
            .args;
        expect(Number(ev.exitBps)).to.equal(10_000);
        expect(await ctx.rha.residualBasisUsd6Of(tokenId)).to.equal(0n);
    });

    // ── Access-control modifier branches ────────────────────────────────

    it("openLp reverts ZeroAddress when _onBehalfOf is the zero address", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await expect(
            ctx.rha.connect(ctx.operatorEOA).openLp(ZERO, USDC_AMOUNT, 0, 0, TS, 0, 0, TS, 1n, 1n, SLIP, DEADLINE),
        ).to.be.revertedWithCustomError(ctx.rha, "ZeroAddress");
    });

    it("openLp reverts NotAuthorized for a caller that is neither operator nor Safe", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await expect(
            ctx.rha.connect(ctx.stranger).openLp(ctx.safeAddr, USDC_AMOUNT, 0, 0, TS, 0, 0, TS, 1n, 1n, SLIP, DEADLINE),
        ).to.be.revertedWithCustomError(ctx.rha, "NotAuthorized");
    });

    it("closeLp reverts ZeroAddress when _onBehalfOf is the zero address", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await expect(
            ctx.rha.connect(ctx.operatorEOA).closeLp(ZERO, 1n, TS, 1n, 1n, SLIP, 5_000, 0, 0, DEADLINE, 0),
        ).to.be.revertedWithCustomError(ctx.rha, "ZeroAddress");
    });

    it("closeLp reverts NotAuthorized for a caller that is neither operator nor Safe", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await expect(
            ctx.rha.connect(ctx.stranger).closeLp(ctx.safeAddr, 1n, TS, 1n, 1n, SLIP, 5_000, 0, 0, DEADLINE, 0),
        ).to.be.revertedWithCustomError(ctx.rha, "NotAuthorized");
    });

    it("collectLp reverts ZeroAddress when _onBehalfOf is the zero address", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await expect(
            ctx.rha.connect(ctx.operatorEOA).collectLp(ZERO, 1n, false, TS, 1n, 1n, SLIP, DEADLINE),
        ).to.be.revertedWithCustomError(ctx.rha, "ZeroAddress");
    });

    it("collectLp reverts NotAuthorized for a caller that is neither operator nor Safe", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await expect(
            ctx.rha.connect(ctx.stranger).collectLp(ctx.safeAddr, 1n, false, TS, 1n, 1n, SLIP, DEADLINE),
        ).to.be.revertedWithCustomError(ctx.rha, "NotAuthorized");
    });

    // ── Remaining openLp entry guards ───────────────────────────────────

    it("openLp reverts InvalidUsdcAmount when usdcAmount == 0", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await expect(
            ctx.rha.connect(ctx.operatorEOA).openLp(ctx.safeAddr, 0, 0, 0, TS, 0, 0, TS, 1n, 1n, SLIP, DEADLINE),
        ).to.be.revertedWithCustomError(ctx.rha, "InvalidUsdcAmount");
    });

    it("openLp reverts SlippageAboveMax when slippageBps exceeds maxSlippageBps", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await expect(
            ctx.rha
                .connect(ctx.operatorEOA)
                .openLp(ctx.safeAddr, USDC_AMOUNT, 0, 0, TS, 0, 0, TS, 1n, 1n, 9999, DEADLINE),
        ).to.be.revertedWithCustomError(ctx.rha, "SlippageAboveMax");
    });

    it("openLp reverts TickSpacingNotAllowed for a disallowed LP tick spacing", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await expect(
            ctx.rha
                .connect(ctx.operatorEOA)
                .openLp(ctx.safeAddr, USDC_AMOUNT, 0, 0, BAD_TS, 0, 0, TS, 1n, 1n, SLIP, DEADLINE),
        ).to.be.revertedWithCustomError(ctx.rha, "TickSpacingNotAllowed");
    });

    it("openLp checks the LP tick spacing before swapAmountOutMin (revert-order lock)", async function () {
        const ctx = await loadFixture(deployMockHarness);
        // Disallowed LP spacing AND swapAmountOutMin == 0: the LP-spacing check
        // sits before the swap-min check, so TickSpacingNotAllowed must win.
        await expect(
            ctx.rha
                .connect(ctx.operatorEOA)
                .openLp(ctx.safeAddr, USDC_AMOUNT, 0, 0, BAD_TS, 0, 0, TS, 0n, 1n, SLIP, DEADLINE),
        ).to.be.revertedWithCustomError(ctx.rha, "TickSpacingNotAllowed");
    });

    it("openLp reverts TickSpacingNotAllowed for a disallowed swap tick spacing", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await expect(
            ctx.rha
                .connect(ctx.operatorEOA)
                .openLp(ctx.safeAddr, USDC_AMOUNT, 0, 0, TS, 0, 0, BAD_TS, 1n, 1n, SLIP, DEADLINE),
        ).to.be.revertedWithCustomError(ctx.rha, "TickSpacingNotAllowed");
    });

    it("openLp reverts InvalidSwapAmountOutMin when swapAmountOutMin == 0", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await expect(
            ctx.rha
                .connect(ctx.operatorEOA)
                .openLp(ctx.safeAddr, USDC_AMOUNT, 0, 0, TS, 0, 0, TS, 0n, 1n, SLIP, DEADLINE),
        ).to.be.revertedWithCustomError(ctx.rha, "InvalidSwapAmountOutMin");
    });

    it("openLp reverts WrongTokenPair when only the pool's token1 is wrong (second operand)", async function () {
        const ctx = await loadFixture(deployMockHarness);
        const Pool = await ethers.getContractFactory("MockCLPool");
        const badPool = await Pool.deploy(ctx.wethAddr, ctx.stranger.address, Q96, 10n ** 18n);
        await (await ctx.factory.setPool(await badPool.getAddress())).wait();
        await expect(openLpCall(ctx)).to.be.revertedWithCustomError(ctx.rha, "WrongTokenPair");
    });

    // ── closeLp entry guards ────────────────────────────────────────────

    it("closeLp reverts InvalidExitBps for exitBps == 0 and exitBps > 10_000", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await expect(closeLpCall(ctx, 1n, 0)).to.be.revertedWithCustomError(ctx.rha, "InvalidExitBps");
        await expect(closeLpCall(ctx, 1n, 10_001)).to.be.revertedWithCustomError(ctx.rha, "InvalidExitBps");
    });

    it("closeLp reverts SlippageAboveMax when slippageBps exceeds maxSlippageBps", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await expect(
            ctx.rha.connect(ctx.operatorEOA).closeLp(ctx.safeAddr, 1n, TS, 1n, 1n, 9999, 5_000, 0, 0, DEADLINE, 0),
        ).to.be.revertedWithCustomError(ctx.rha, "SlippageAboveMax");
    });

    it("closeLp reverts TickSpacingNotAllowed for a disallowed swap tick spacing", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await expect(
            ctx.rha.connect(ctx.operatorEOA).closeLp(ctx.safeAddr, 1n, BAD_TS, 1n, 1n, SLIP, 5_000, 0, 0, DEADLINE, 0),
        ).to.be.revertedWithCustomError(ctx.rha, "TickSpacingNotAllowed");
    });

    it("closeLp reverts InvalidSwapAmountOutMin when swapAmountOutMin == 0", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await expect(
            ctx.rha.connect(ctx.operatorEOA).closeLp(ctx.safeAddr, 1n, TS, 0n, 1n, SLIP, 5_000, 0, 0, DEADLINE, 0),
        ).to.be.revertedWithCustomError(ctx.rha, "InvalidSwapAmountOutMin");
    });

    it("closeLp reverts UnknownPosition for a tokenId never opened via this contract", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await expect(closeLpCall(ctx, 999n)).to.be.revertedWithCustomError(ctx.rha, "UnknownPosition");
    });

    it("collectLp reverts UnknownPosition for a tokenId never opened via this contract", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await expect(
            ctx.rha.connect(ctx.operatorEOA).collectLp(ctx.safeAddr, 999n, false, TS, 1n, 1n, SLIP, DEADLINE),
        ).to.be.revertedWithCustomError(ctx.rha, "UnknownPosition");
    });

    it("collectLp reverts LpNotOnSafe when the position is owned by another address", async function () {
        const ctx = await loadFixture(deployMockHarness);
        const tokenId = await openLp(ctx);
        await (await ctx.npm.setOwner(tokenId, ctx.stranger.address)).wait();
        await expect(
            ctx.rha.connect(ctx.operatorEOA).collectLp(ctx.safeAddr, tokenId, false, TS, 1n, 1n, SLIP, DEADLINE),
        ).to.be.revertedWithCustomError(ctx.rha, "LpNotOnSafe");
    });

    it("collectLp reverts WrongTokenPair when only token1 is wrong (second operand)", async function () {
        const ctx = await loadFixture(deployMockHarness);
        const tokenId = await openLp(ctx);
        await (await ctx.npm.setTokens(tokenId, ctx.wethAddr, ctx.stranger.address)).wait();
        await expect(
            ctx.rha.connect(ctx.operatorEOA).collectLp(ctx.safeAddr, tokenId, false, TS, 1n, 1n, SLIP, DEADLINE),
        ).to.be.revertedWithCustomError(ctx.rha, "WrongTokenPair");
    });

    it("closeLp reverts MinUsdcOutNotMet when realized USDC is below minUsdcOut", async function () {
        const ctx = await loadFixture(deployMockHarness);
        const tokenId = await openLp(ctx);
        await (await ctx.router.setOutput(1_000_000n)).wait();
        await expect(
            ctx.rha
                .connect(ctx.operatorEOA)
                .closeLp(ctx.safeAddr, tokenId, TS, 1n, 1n, SLIP, 10_000, 0, 0, DEADLINE, 10n ** 18n),
        ).to.be.revertedWithCustomError(ctx.rha, "MinUsdcOutNotMet");
    });

    it("closeLp reverts InvalidExitBps (dust) when a partial exit would remove zero liquidity", async function () {
        const ctx = await loadFixture(deployMockHarness);
        const tokenId = await openLp(ctx);
        // Tiny-liquidity position → liquidityToRemove truncates to 0 while
        // basisForExit stays > 0.
        await (
            await ctx.npm.seedPosition(tokenId, ctx.safeAddr, ctx.wethAddr, ctx.usdcAddr, TS, 1n, 0n, 500_000n)
        ).wait();
        await expect(closeLpCall(ctx, tokenId, 5_000)).to.be.revertedWithCustomError(ctx.rha, "InvalidExitBps");
    });

    it("closeLp partial dust no-op: zero basisForExit and zero liquidityToRemove leaves the position untouched", async function () {
        const ctx = await loadFixture(deployMockHarness);
        // basis = 2 (usdcAmount = 2) and liquidity = 1, so a 1-bps exit floors
        // both basisForExit and liquidityToRemove to 0 → the dust guard does not
        // fire (basisForExit == 0) and the decrease block is skipped.
        await (await ctx.npm.setMintLiquidity(1n)).wait();
        const tokenId = await openLp(ctx, { usdcAmount: 2n });
        expect(await ctx.rha.residualBasisUsd6Of(tokenId)).to.equal(2n);

        await (await ctx.router.setOutput(0n)).wait();
        await (await closeLpCall(ctx, tokenId, 1)).wait();

        // No basis drawn down, position untouched and still open.
        expect(await ctx.rha.residualBasisUsd6Of(tokenId)).to.equal(2n);
        expect(await ctx.npm.ownerOf(tokenId)).to.equal(ctx.safeAddr);
    });

    it("closeLp charges no performance fee when the profit rounds the fee to zero", async function () {
        const ctx = await loadFixture(deployMockHarness);
        const tokenId = await openLp(ctx);
        // currentValue = 500_000 + 500_005 = 1_000_005; profit = 5; fee = 5*1000/10000 = 0.
        await (await ctx.router.setOutput(500_005n)).wait();
        await (await closeLpCall(ctx, tokenId)).wait();
        const ev = (await ctx.rha.queryFilter(ctx.rha.filters.PositionClosed(ctx.safeAddr, tokenId), -5)).slice(-1)[0]
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
        await expect(closeLpCall(ctx, tokenId)).to.emit(ctx.rha, "FeeTransferFailed");
        const ev = (await ctx.rha.queryFilter(ctx.rha.filters.PositionClosed(ctx.safeAddr, tokenId), -5)).slice(-1)[0]
            .args;
        expect(ev.feeUsd6).to.equal(0n);
        expect((await ctx.usdc.balanceOf(ctx.treasury.address)) - tUsdc0).to.equal(0n);
    });

    it("collectLp surfaces CollectFeeTransferFailed (catch branch) when the fee transfer reverts", async function () {
        const ctx = await loadFixture(deployMockHarness);
        const tokenId = await openLp(ctx);
        await (await ctx.npm.setOwed(tokenId, 1_000_000n, 1_000_000n)).wait();
        await (await ctx.weth.setRevertTransferTo(ctx.treasury.address)).wait();
        await expect(
            ctx.rha.connect(ctx.operatorEOA).collectLp(ctx.safeAddr, tokenId, false, TS, 1n, 1n, SLIP, DEADLINE),
        )
            .to.emit(ctx.rha, "CollectFeeTransferFailed")
            .withArgs(ctx.safeAddr, tokenId, ctx.wethAddr, (1_000_000n * COLLECT_FEE_BPS) / 10_000n);
        const ev = (await ctx.rha.queryFilter(ctx.rha.filters.FeesCollected(ctx.safeAddr, tokenId), -5)).slice(-1)[0]
            .args;
        expect(ev.fee0).to.equal(0n);
    });

    it("collectLp with feeCollectBps == 0 skims nothing (fee == 0 branch)", async function () {
        const ctx = await loadFixture(deployMockHarness);
        await (await ctx.rha.connect(ctx.deployer).setFeeCollectBps(0)).wait();
        const tokenId = await openLp(ctx);
        await (await ctx.npm.setOwed(tokenId, 800_000n, 400_000n)).wait();
        const tWeth0 = await ctx.weth.balanceOf(ctx.treasury.address);
        await (
            await ctx.rha.connect(ctx.operatorEOA).collectLp(ctx.safeAddr, tokenId, false, TS, 1n, 1n, SLIP, DEADLINE)
        ).wait();
        const ev = (await ctx.rha.queryFilter(ctx.rha.filters.FeesCollected(ctx.safeAddr, tokenId), -5)).slice(-1)[0]
            .args;
        expect(ev.fee0).to.equal(0n);
        expect(ev.fee1).to.equal(0n);
        expect((await ctx.weth.balanceOf(ctx.treasury.address)) - tWeth0).to.equal(0n);
    });

    // ── collectLp swapWethToUsdc flag ───────────────────────────────────

    it("collectLp swap=true: WETH fee→treasury, WETH remainder swapped, USDC = remainder + router output", async function () {
        const ctx = await loadFixture(deployMockHarness);
        const tokenId = await openLp(ctx);
        const owed0 = 800_000n;
        const owed1 = 400_000n;
        const routerOut = 600_000n;
        await (await ctx.npm.setOwed(tokenId, owed0, owed1)).wait();
        await (await ctx.router.setOutput(routerOut)).wait();

        const tWeth0 = await ctx.weth.balanceOf(ctx.treasury.address);
        const sWeth0 = await ctx.weth.balanceOf(ctx.safeAddr);
        const sUsdc0 = await ctx.usdc.balanceOf(ctx.safeAddr);

        await (await collectLpCall(ctx, tokenId, { swap: true })).wait();

        const fee0 = (owed0 * COLLECT_FEE_BPS) / 10_000n;
        const fee1 = (owed1 * COLLECT_FEE_BPS) / 10_000n;
        expect((await ctx.weth.balanceOf(ctx.treasury.address)) - tWeth0).to.equal(fee0);
        // WETH remainder forwarded to the Safe was fully swapped away.
        expect((await ctx.weth.balanceOf(ctx.safeAddr)) - sWeth0).to.equal(0n);
        expect((await ctx.usdc.balanceOf(ctx.safeAddr)) - sUsdc0).to.equal(owed1 - fee1 + routerOut);
        // Position stays open.
        expect(await ctx.npm.ownerOf(tokenId)).to.equal(ctx.safeAddr);
        expect(await ctx.rha.residualBasisUsd6Of(tokenId)).to.equal(USDC_AMOUNT);
    });

    it("collectLp swap=false: WETH remainder stays on the Safe, no swap", async function () {
        const ctx = await loadFixture(deployMockHarness);
        const tokenId = await openLp(ctx);
        const owed0 = 800_000n;
        const owed1 = 400_000n;
        await (await ctx.npm.setOwed(tokenId, owed0, owed1)).wait();
        // Router output set non-zero to prove it is NOT consumed on this path.
        await (await ctx.router.setOutput(999_999n)).wait();

        const sWeth0 = await ctx.weth.balanceOf(ctx.safeAddr);
        const sUsdc0 = await ctx.usdc.balanceOf(ctx.safeAddr);

        await (await collectLpCall(ctx, tokenId, { swap: false })).wait();

        const fee0 = (owed0 * COLLECT_FEE_BPS) / 10_000n;
        const fee1 = (owed1 * COLLECT_FEE_BPS) / 10_000n;
        expect((await ctx.weth.balanceOf(ctx.safeAddr)) - sWeth0).to.equal(owed0 - fee0);
        expect((await ctx.usdc.balanceOf(ctx.safeAddr)) - sUsdc0).to.equal(owed1 - fee1);
        expect(await ctx.npm.ownerOf(tokenId)).to.equal(ctx.safeAddr);
    });

    it("collectLp swap=true with USDC-only fees (wethDelta == 0): swap skipped, no revert, USDC forwarded", async function () {
        const ctx = await loadFixture(deployMockHarness);
        const tokenId = await openLp(ctx);
        const owed1 = 300_000n;
        await (await ctx.npm.setOwed(tokenId, 0n, owed1)).wait();
        await (await ctx.router.setOutput(0n)).wait();

        const sUsdc0 = await ctx.usdc.balanceOf(ctx.safeAddr);
        await (await collectLpCall(ctx, tokenId, { swap: true })).wait();

        const fee1 = (owed1 * COLLECT_FEE_BPS) / 10_000n;
        expect((await ctx.usdc.balanceOf(ctx.safeAddr)) - sUsdc0).to.equal(owed1 - fee1);
        expect(await ctx.npm.ownerOf(tokenId)).to.equal(ctx.safeAddr);
    });

    it("collectLp swap=true validates each swap-param guard", async function () {
        const ctx = await loadFixture(deployMockHarness);
        const tokenId = await openLp(ctx);
        await (await ctx.npm.setOwed(tokenId, 800_000n, 400_000n)).wait();

        await expect(collectLpCall(ctx, tokenId, { swap: true, deadline: 0n })).to.be.revertedWithCustomError(
            ctx.rha,
            "DeadlineExpired",
        );
        await expect(collectLpCall(ctx, tokenId, { swap: true, slippage: 9999 })).to.be.revertedWithCustomError(
            ctx.rha,
            "SlippageAboveMax",
        );
        await expect(collectLpCall(ctx, tokenId, { swap: true, tickSpacing: BAD_TS })).to.be.revertedWithCustomError(
            ctx.rha,
            "TickSpacingNotAllowed",
        );
        await expect(collectLpCall(ctx, tokenId, { swap: true, amountOutMin: 0n })).to.be.revertedWithCustomError(
            ctx.rha,
            "InvalidSwapAmountOutMin",
        );
        await expect(collectLpCall(ctx, tokenId, { swap: true, expectedOut: 0n })).to.be.revertedWithCustomError(
            ctx.rha,
            "InvalidExpectedSwapOut",
        );
        await expect(
            collectLpCall(ctx, tokenId, { swap: true, amountOutMin: 1n, expectedOut: 1_000_000n }),
        ).to.be.revertedWithCustomError(ctx.rha, "SwapMinBelowSlippageFloor");
    });

    it("collectLp swap=false ignores garbage swap params (validation skipped)", async function () {
        const ctx = await loadFixture(deployMockHarness);
        const tokenId = await openLp(ctx);
        await (await ctx.npm.setOwed(tokenId, 800_000n, 400_000n)).wait();
        // Disallowed spacing, zero swapAmountOutMin, zero expectedOut, zero slippage,
        // expired deadline — all meaningless on the no-swap path.
        await expect(
            ctx.rha.connect(ctx.operatorEOA).collectLp(ctx.safeAddr, tokenId, false, BAD_TS, 0n, 0n, 0, 0n),
        ).to.emit(ctx.rha, "FeesCollected");
        expect(await ctx.npm.ownerOf(tokenId)).to.equal(ctx.safeAddr);
    });

    // ── setTickSpacingAllowed ───────────────────────────────────────────

    it("setTickSpacingAllowed flips a spacing and gates new spacings", async function () {
        const ctx = await loadFixture(deployMockHarness);
        // 60 is disallowed by default → enabling it lets openLp use it.
        await expect(ctx.rha.connect(ctx.deployer).setTickSpacingAllowed(BAD_TS, true))
            .to.emit(ctx.rha, "TickSpacingAllowedUpdated")
            .withArgs(BAD_TS, false, true);
        expect(await ctx.rha.allowedTickSpacing(BAD_TS)).to.equal(true);

        // Disabling the default 100 spacing makes openLp revert on it.
        await (await ctx.rha.connect(ctx.deployer).setTickSpacingAllowed(TS, false)).wait();
        await expect(openLpCall(ctx)).to.be.revertedWithCustomError(ctx.rha, "TickSpacingNotAllowed");

        // Non-admin cannot flip.
        await expect(ctx.rha.connect(ctx.stranger).setTickSpacingAllowed(BAD_TS, false)).to.be.revertedWithCustomError(
            ctx.rha,
            "AccessControlUnauthorizedAccount",
        );
    });

    // ── rescueERC721 ────────────────────────────────────────────────────

    it("rescueERC721 transfers a stranded NFT and rejects zero addresses / non-admin", async function () {
        const ctx = await loadFixture(deployMockHarness);
        const ERC721 = await ethers.getContractFactory("MockERC721");
        const nft = await ERC721.deploy();
        await nft.waitForDeployment();
        const nftAddr = await nft.getAddress();
        await (await nft.mint(await ctx.rha.getAddress(), 7n)).wait();

        await expect(ctx.rha.connect(ctx.deployer).rescueERC721(nftAddr, 7n, ctx.stranger.address))
            .to.emit(ctx.rha, "NftRescued")
            .withArgs(nftAddr, ctx.stranger.address, 7n);
        expect(await nft.ownerOf(7n)).to.equal(ctx.stranger.address);

        await expect(
            ctx.rha.connect(ctx.deployer).rescueERC721(ZERO, 7n, ctx.stranger.address),
        ).to.be.revertedWithCustomError(ctx.rha, "ZeroAddress");
        await expect(ctx.rha.connect(ctx.deployer).rescueERC721(nftAddr, 7n, ZERO)).to.be.revertedWithCustomError(
            ctx.rha,
            "ZeroAddress",
        );
        await expect(
            ctx.rha.connect(ctx.stranger).rescueERC721(nftAddr, 7n, ctx.stranger.address),
        ).to.be.revertedWithCustomError(ctx.rha, "AccessControlUnauthorizedAccount");
    });
});
