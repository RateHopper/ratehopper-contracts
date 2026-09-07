import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import {
    YieldProtocol,
    encodeAerodromePoolParam,
    encodeUniV3PoolParam,
    encodeUniV4PoolParam,
} from "../../contractAddresses";
import { ZERO_LEG, leg } from "../helpers/utils";

// ─────────────────────────────────────────────────────────────────────────
//  Mock-driven suite for UniV4YieldHandler behind SafeYieldManager.
//
//  Uses the V4 stack from RatehopperUniV4Mocks.sol (MockPermit2 with real
//  two-hop allowance enforcement, an actions-decoding MockV4PositionManager,
//  a V4_SWAP MockUniversalRouter, MockStateView) plus the shared mocks from
//  RatehopperMocks.sol. Covers ERC20 (WETH/USDC-shaped) and native ETH
//  (currency0 == address(0)) pools through the full openLp / closeLp /
//  collectLp lifecycle, every handler revert branch, the Permit2/ERC20
//  approval-reset invariant, the Safe-side collect-fee skim, and V3<->V4 /
//  Aerodrome<->V4 switchLp through the untouched manager.
// ─────────────────────────────────────────────────────────────────────────

const ZERO = "0x0000000000000000000000000000000000000000";
const DEADLINE = ethers.MaxUint256;
const SLIP = 100; // 1%
const PERF_FEE_BPS = 1000n; // 10%
const COLLECT_FEE_BPS = 250n; // 2.5%
const MAX_FEE_BPS = 2000;
const Q96 = 1n << 96n;
const TWAP_WINDOW = 1800;
const TWAP_CARDINALITY = 60;

function timelockCall(timelock: any, manager: any, functionName: string, args: any[]) {
    return timelock.execute(manager.target, manager.interface.encodeFunctionData(functionName, args));
}

const twapSeed = (token: string, pool: string) => ({
    token,
    config: { pool, window: TWAP_WINDOW, minCardinality: TWAP_CARDINALITY },
});

const UNISWAP_V3 = YieldProtocol.UNISWAP_V3;
const AERODROME = YieldProtocol.AERODROME;
const UNISWAP_V4 = YieldProtocol.UNISWAP_V4;

let FEE_TIER: string; // Uniswap V3 pool param (switch tests)
let TICK_SPACING: string; // Aerodrome pool param (switch tests)
let V4_KEY: string; // ERC20 pair PoolKey param
let V4_NATIVE_KEY: string; // native ETH pair PoolKey param
let V4_UNINIT_KEY: string; // allow-listed but never initialized in StateView
let V4_BAD_KEY: string; // never allow-listed
let V4_USDC0_KEY: string; // pair where USDC sorts as currency0
let V4_WRONG1_KEY: string; // trades {WETH, other} — wrong currency1 for a WETH/USDC leg

const USDC_AMOUNT = 1_000_000n;
const HALF = USDC_AMOUNT / 2n;
const WETH_OUT = 2_000_000n; // token/ETH produced by the openLp swap
const CLOSE_OUT = 600_000n; // USDC produced by a close/collect swap

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
        swap0: leg(CLOSE_OUT, poolParam),
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
        swap0: leg(CLOSE_OUT, poolParam),
        swap1: ZERO_LEG,
        swapRewardToUsdc: false,
        rewardSwap: ZERO_LEG,
        slippageBps: SLIP,
        deadline: DEADLINE,
        ...overrides,
    };
}

async function deployUniV4Harness() {
    const [deployer, operatorEOA, treasury, stranger, pauser] = await ethers.getSigners();

    const ERC = await ethers.getContractFactory("MockERC20");
    const usdc = await ERC.deploy("USD Coin", "USDC", 6);
    await usdc.waitForDeployment();
    const usdcAddr = await usdc.getAddress();

    // WETH must sort BELOW USDC (currency0 side) and expose deposit/withdraw
    // for the V4 handler's in-kind wrap/unwrap; place MockWETH code at
    // usdc - 1 directly — deterministically the next address down.
    const WETHFactory = await ethers.getContractFactory("MockWETH");
    const wethImpl = await WETHFactory.deploy();
    await wethImpl.waitForDeployment();
    const wethAddr = ethers.getAddress(ethers.toBeHex(BigInt(usdcAddr) - 1n, 20));
    await network.provider.send("hardhat_setCode", [wethAddr, await ethers.provider.getCode(wethImpl)]);
    const weth = await ethers.getContractAt("MockWETH", wethAddr);

    // A token that sorts ABOVE USDC, so a {USDC, tokenC} pool has USDC as
    // currency0 (drives the currency0-is-USDC branches). Deployed addresses
    // are nonce-derived and can land anywhere, so place the code at
    // usdc + 1 directly — deterministically the next address up.
    const tokenCAddr = ethers.getAddress(ethers.toBeHex(BigInt(usdcAddr) + 1n, 20));
    await network.provider.send("hardhat_setCode", [tokenCAddr, await ethers.provider.getCode(usdcAddr)]);
    const tokenC = await ethers.getContractAt("MockERC20", tokenCAddr);

    FEE_TIER = encodeUniV3PoolParam(wethAddr, usdcAddr, 500);
    TICK_SPACING = encodeAerodromePoolParam(wethAddr, usdcAddr, 100);
    V4_KEY = encodeUniV4PoolParam(wethAddr, usdcAddr, 500, 10, ZERO);
    V4_NATIVE_KEY = encodeUniV4PoolParam(ZERO, usdcAddr, 500, 10, ZERO);
    V4_UNINIT_KEY = encodeUniV4PoolParam(wethAddr, usdcAddr, 3000, 60, ZERO);
    V4_BAD_KEY = encodeUniV4PoolParam(wethAddr, usdcAddr, 10000, 200, ZERO);
    V4_USDC0_KEY = encodeUniV4PoolParam(usdcAddr, tokenCAddr, 500, 10, ZERO);
    V4_WRONG1_KEY = encodeUniV4PoolParam(wethAddr, tokenCAddr, 500, 10, ZERO);

    // Uniswap V3 side (switchLp counterparty)
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

    // Aerodrome side (switchLp counterparty)
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

    // Uniswap V4 side
    const Permit2 = await ethers.getContractFactory("MockPermit2");
    const permit2 = await Permit2.deploy();
    await permit2.waitForDeployment();
    const StateView = await ethers.getContractFactory("MockStateView");
    const stateView = await StateView.deploy();
    await stateView.waitForDeployment();
    const V4PM = await ethers.getContractFactory("MockV4PositionManager");
    const v4Pm = await V4PM.deploy(await permit2.getAddress());
    await v4Pm.waitForDeployment();
    const UR = await ethers.getContractFactory("MockUniversalRouter");
    const universalRouter = await UR.deploy(await permit2.getAddress());
    await universalRouter.waitForDeployment();

    await (await stateView.setPool(ethers.keccak256(V4_KEY), Q96, 10n ** 18n)).wait();
    await (await stateView.setPool(ethers.keccak256(V4_NATIVE_KEY), Q96, 10n ** 18n)).wait();
    await (await stateView.setPool(ethers.keccak256(V4_USDC0_KEY), Q96, 10n ** 18n)).wait();
    await (await stateView.setPool(ethers.keccak256(V4_WRONG1_KEY), Q96, 10n ** 18n)).wait();

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
    await (await reg.setWhitelisted(tokenCAddr, true)).wait();

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

    const V4Handler = await ethers.getContractFactory("UniV4YieldHandler");
    const v4Handler = await V4Handler.deploy(
        await v4Pm.getAddress(),
        await universalRouter.getAddress(),
        await permit2.getAddress(),
        await stateView.getAddress(),
        usdcAddr,
        wethAddr,
    );
    await v4Handler.waitForDeployment();

    const Timelock = await ethers.getContractFactory("MockTimelockController");
    const timelock = await Timelock.deploy(1);
    await timelock.waitForDeployment();

    const Manager = await ethers.getContractFactory("SafeYieldManager");
    // Price references, seeded at construction. Native ETH carries its OWN key,
    // address(0), pointed at a WETH/USDC pool — WETH is substituted only for the
    // tick math. Both keys are needed: swaps on a native pool read address(0),
    // while the in-kind switch values its residue under WETH, because
    // `withdrawLp` hands a native side back wrapped.
    const [c0, c1] =
        tokenCAddr.toLowerCase() < usdcAddr.toLowerCase() ? [tokenCAddr, usdcAddr] : [usdcAddr, tokenCAddr];
    const tokenCRef = await UniPool.deploy(c0, c1, Q96, 10n ** 18n);
    await tokenCRef.waitForDeployment();
    const uniPoolAddr = await uniPool.getAddress();
    const tokenCRefAddr = await tokenCRef.getAddress();

    const manager = await Manager.deploy(
        await reg.getAddress(),
        usdcAddr,
        wethAddr,
        [UNISWAP_V3, AERODROME, UNISWAP_V4],
        [await uniHandler.getAddress(), await aeroHandler.getAddress(), await v4Handler.getAddress()],
        [[FEE_TIER], [TICK_SPACING], [V4_KEY, V4_NATIVE_KEY, V4_UNINIT_KEY, V4_USDC0_KEY, V4_WRONG1_KEY]],
        [0, 0, 0],
        [0, 0, 0],
        [twapSeed(wethAddr, uniPoolAddr), twapSeed(ZERO, uniPoolAddr), twapSeed(tokenCAddr, tokenCRefAddr)],
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
    for (const target of [uniRouter, clRouter, uniNpm, clNpm, universalRouter, v4Pm]) {
        await (await weth.mint(await target.getAddress(), 10n ** 24n)).wait();
        await (await usdc.mint(await target.getAddress(), 10n ** 18n)).wait();
        await (await tokenC.mint(await target.getAddress(), 10n ** 24n)).wait();
    }
    // Native ETH liquidity for the router (swap output), the PM (fee/principal
    // takes), and MockWETH (honouring `withdraw` for minted balances).
    await (await deployer.sendTransaction({ to: await universalRouter.getAddress(), value: 10n ** 18n })).wait();
    await (await deployer.sendTransaction({ to: await v4Pm.getAddress(), value: 10n ** 18n })).wait();
    await (await deployer.sendTransaction({ to: wethAddr, value: 10n ** 18n })).wait();
    await (await uniRouter.setOutput(WETH_OUT)).wait();
    await (await clRouter.setOutput(WETH_OUT)).wait();
    await (await universalRouter.setOutput(WETH_OUT)).wait();

    return {
        deployer,
        operatorEOA,
        treasury,
        stranger,
        pauser,
        timelock,
        weth,
        usdc,
        tokenC,
        wethAddr,
        usdcAddr,
        tokenCAddr,
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
        permit2,
        stateView,
        v4Pm,
        universalRouter,
        safe,
        safeAddr,
        reg,
        uniHandler,
        aeroHandler,
        v4Handler,
        manager,
    };
}

describe("SafeYieldManager + UniV4YieldHandler", function () {
    describe("deployment & registration", function () {
        it("registers the V4 handler with separate ERC20 and native reference keys", async function () {
            const { manager, v4Handler, uniPool, wethAddr } = await loadFixture(deployUniV4Harness);

            expect(await v4Handler.PROTOCOL()).to.equal(UNISWAP_V4);
            expect(await manager.yieldHandlers(UNISWAP_V4)).to.equal(await v4Handler.getAddress());
            expect(await manager.protocolEnabledForOpen(UNISWAP_V4)).to.equal(true);
            expect(await manager.protocolEnabledForClose(UNISWAP_V4)).to.equal(true);
            expect(await manager.isPoolParamAllowed(UNISWAP_V4, V4_KEY)).to.equal(true);
            expect(await manager.isPoolParamAllowed(UNISWAP_V4, V4_NATIVE_KEY)).to.equal(true);
            expect(await manager.isPoolParamAllowed(UNISWAP_V4, V4_BAD_KEY)).to.equal(false);
            expect((await manager.twapConfigOf(wethAddr)).pool).to.equal(await uniPool.getAddress());
            expect((await manager.twapConfigOf(ZERO)).pool).to.equal(await uniPool.getAddress());
        });

        it("rejects registering the V4 handler under a foreign id", async function () {
            const { manager, timelock, v4Handler } = await loadFixture(deployUniV4Harness);
            await expect(timelockCall(timelock, manager, "setYieldHandler", [1, await v4Handler.getAddress()]))
                .to.be.revertedWithCustomError(manager, "HandlerProtocolMismatch")
                .withArgs(1, UNISWAP_V4);
        });

        it("rejects zero addresses in the handler constructor", async function () {
            const { v4Pm, universalRouter, permit2, stateView, usdcAddr, wethAddr, v4Handler } =
                await loadFixture(deployUniV4Harness);
            const V4Handler = await ethers.getContractFactory("UniV4YieldHandler");
            const args = [
                await v4Pm.getAddress(),
                await universalRouter.getAddress(),
                await permit2.getAddress(),
                await stateView.getAddress(),
                usdcAddr,
                wethAddr,
            ];
            for (let i = 0; i < args.length; i++) {
                const bad = [...args];
                bad[i] = ZERO;
                await expect(
                    V4Handler.deploy(bad[0], bad[1], bad[2], bad[3], bad[4], bad[5]),
                ).to.be.revertedWithCustomError(v4Handler, "ZeroAddress");
            }
        });

        it("rejects direct (non-delegatecall) entry", async function () {
            const { v4Handler, safeAddr } = await loadFixture(deployUniV4Harness);
            await expect(v4Handler.openLp(openParams(safeAddr, V4_KEY))).to.be.revertedWithCustomError(
                v4Handler,
                "OnlyDelegatecall",
            );
            await expect(v4Handler.closeLp(closeParams(safeAddr, 1, V4_KEY), 0)).to.be.revertedWithCustomError(
                v4Handler,
                "OnlyDelegatecall",
            );
            await expect(v4Handler.collectLp(collectParams(safeAddr, 1, V4_KEY))).to.be.revertedWithCustomError(
                v4Handler,
                "OnlyDelegatecall",
            );
            await expect(
                v4Handler.withdrawLp({
                    onBehalfOf: safeAddr,
                    tokenId: 1,
                    decreaseAmount0Min: 0,
                    decreaseAmount1Min: 0,
                    deadline: DEADLINE,
                }),
            ).to.be.revertedWithCustomError(v4Handler, "OnlyDelegatecall");
            await expect(
                v4Handler.openLpInKind({
                    onBehalfOf: safeAddr,
                    token0: safeAddr,
                    token1: safeAddr,
                    amount0: 0,
                    amount1: 0,
                    tickLower: -100,
                    tickUpper: 100,
                    mintAmount0Min: 0,
                    mintAmount1Min: 0,
                    lpPoolParam: V4_KEY,
                    deadline: DEADLINE,
                }),
            ).to.be.revertedWithCustomError(v4Handler, "OnlyDelegatecall");
        });

        it("admits a hooked pool key only through the timelock", async function () {
            const f = await loadFixture(deployUniV4Harness);
            const hooked = encodeUniV4PoolParam(f.wethAddr, f.usdcAddr, 500, 10, f.safeAddr);
            await (await f.stateView.setPool(ethers.keccak256(hooked), Q96, 10n ** 18n)).wait();
            expect(await f.v4Handler.poolParamHasHooks(hooked)).to.equal(true);
            expect(await f.v4Handler.poolParamHasHooks(V4_KEY)).to.equal(false);
            expect(await f.uniHandler.poolParamHasHooks(FEE_TIER)).to.equal(false);

            await expect(
                f.manager.connect(f.deployer).setPoolParamAllowed(UNISWAP_V4, hooked, true),
            ).to.be.revertedWithCustomError(f.manager, "HookedPoolParamNeedsTimelock");
            const Manager = await ethers.getContractFactory("SafeYieldManager");
            await expect(
                Manager.deploy(
                    await f.reg.getAddress(),
                    f.usdcAddr,
                    f.wethAddr,
                    [UNISWAP_V4],
                    [await f.v4Handler.getAddress()],
                    [[hooked]],
                    [0],
                    [0],
                    [twapSeed(f.wethAddr, f.uniPoolAddr)],
                    f.treasury.address,
                    Number(PERF_FEE_BPS),
                    Number(COLLECT_FEE_BPS),
                    MAX_FEE_BPS,
                    f.deployer.address,
                    await f.timelock.getAddress(),
                    f.pauser.address,
                ),
            ).to.be.revertedWithCustomError(f.manager, "HookedPoolParamNeedsTimelock");

            await expect(timelockCall(f.timelock, f.manager, "allowHookedPoolParam", [UNISWAP_V4, hooked]))
                .to.emit(f.manager, "PoolParamAllowedUpdated")
                .withArgs(UNISWAP_V4, hooked, false, true);
            expect(await f.manager.isPoolParamAllowed(UNISWAP_V4, hooked)).to.equal(true);

            await (await f.manager.connect(f.deployer).setPoolParamAllowed(UNISWAP_V4, hooked, false)).wait();
            expect(await f.manager.isPoolParamAllowed(UNISWAP_V4, hooked)).to.equal(false);
        });

        it("routes an exit through a hooked pool only once the timelock has admitted it", async function () {
            const {
                manager,
                operatorEOA,
                safeAddr,
                v4Handler,
                stateView,
                universalRouter,
                timelock,
                wethAddr,
                usdcAddr,
            } = await loadFixture(deployUniV4Harness);
            const hooked = encodeUniV4PoolParam(wethAddr, usdcAddr, 500, 10, safeAddr);
            await (await stateView.setPool(ethers.keccak256(hooked), Q96, 10n ** 18n)).wait();
            await manager.connect(operatorEOA).openLp(UNISWAP_V4, openParams(safeAddr, V4_KEY));
            await (await universalRouter.setOutputFor(usdcAddr, CLOSE_OUT)).wait();

            await expect(
                manager
                    .connect(operatorEOA)
                    .closeLp(UNISWAP_V4, closeParams(safeAddr, 1, V4_KEY, { swap0: leg(CLOSE_OUT, hooked) })),
            ).to.be.revertedWithCustomError(v4Handler, "PoolParamNotAllowed");

            await (await timelockCall(timelock, manager, "allowHookedPoolParam", [UNISWAP_V4, hooked])).wait();
            await expect(
                manager
                    .connect(operatorEOA)
                    .closeLp(UNISWAP_V4, closeParams(safeAddr, 1, V4_KEY, { swap0: leg(CLOSE_OUT, hooked) })),
            ).to.emit(manager, "PositionClosed");
        });

        it("L-3: allow-lists a native pool only when both the native and the WETH reference answer", async function () {
            const f = await loadFixture(deployUniV4Harness);
            const Manager = await ethers.getContractFactory("SafeYieldManager");
            const deployWith = async (seeds: { token: string; config: any }[], allowed: string[]) =>
                Manager.deploy(
                    await f.reg.getAddress(),
                    f.usdcAddr,
                    f.wethAddr,
                    [UNISWAP_V4],
                    [await f.v4Handler.getAddress()],
                    [allowed],
                    [0],
                    [0],
                    seeds,
                    f.treasury.address,
                    Number(PERF_FEE_BPS),
                    Number(COLLECT_FEE_BPS),
                    MAX_FEE_BPS,
                    f.deployer.address,
                    await f.timelock.getAddress(),
                    f.pauser.address,
                );

            await expect(deployWith([twapSeed(ZERO, f.uniPoolAddr)], [V4_NATIVE_KEY]))
                .to.be.revertedWithCustomError(f.manager, "TwapNotConfigured")
                .withArgs(f.wethAddr);
            await expect(deployWith([twapSeed(f.wethAddr, f.uniPoolAddr)], [V4_NATIVE_KEY]))
                .to.be.revertedWithCustomError(f.manager, "TwapNotConfigured")
                .withArgs(ZERO);

            const nativeOnly = await deployWith([twapSeed(ZERO, f.uniPoolAddr)], []);
            await nativeOnly.waitForDeployment();
            await expect(nativeOnly.connect(f.deployer).setPoolParamAllowed(UNISWAP_V4, V4_NATIVE_KEY, true))
                .to.be.revertedWithCustomError(f.manager, "TwapNotConfigured")
                .withArgs(f.wethAddr);

            expect(await f.manager.isPoolParamAllowed(UNISWAP_V4, V4_NATIVE_KEY)).to.equal(true);
        });
    });

    describe("openLp (ERC20 pair)", function () {
        it("opens a V4 position: swap leg, liquidity mint, basis at executed rate", async function () {
            const { manager, operatorEOA, safeAddr, v4Pm, weth, usdc } = await loadFixture(deployUniV4Harness);

            await expect(manager.connect(operatorEOA).openLp(UNISWAP_V4, openParams(safeAddr, V4_KEY)))
                .to.emit(manager, "PositionOpened")
                .withArgs(safeAddr, UNISWAP_V4, 1n, USDC_AMOUNT, WETH_OUT, HALF, USDC_AMOUNT);

            expect(await manager.residualBasisUsd6Of(UNISWAP_V4, 1)).to.equal(USDC_AMOUNT);
            expect(await manager.positionHandlerOf(UNISWAP_V4, 1)).to.equal(await manager.yieldHandlers(UNISWAP_V4));
            expect(await v4Pm.ownerOf(1)).to.equal(safeAddr);
            expect(await v4Pm.getPositionLiquidity(1)).to.be.gt(0n);
        });

        it("resets both Permit2 hops after the mint", async function () {
            const { manager, operatorEOA, safeAddr, permit2, v4Pm, universalRouter, weth, usdc, wethAddr, usdcAddr } =
                await loadFixture(deployUniV4Harness);
            await manager.connect(operatorEOA).openLp(UNISWAP_V4, openParams(safeAddr, V4_KEY));

            const pmAddr = await v4Pm.getAddress();
            const urAddr = await universalRouter.getAddress();
            const permit2Addr = await permit2.getAddress();
            for (const token of [wethAddr, usdcAddr]) {
                const [pmAmount] = await permit2.allowance(safeAddr, token, pmAddr);
                const [urAmount] = await permit2.allowance(safeAddr, token, urAddr);
                expect(pmAmount).to.equal(0n);
                expect(urAmount).to.equal(0n);
            }
            expect(await weth.allowance(safeAddr, permit2Addr)).to.equal(0n);
            expect(await usdc.allowance(safeAddr, permit2Addr)).to.equal(0n);
        });

        it("enforces the caller's mint minimums post-hoc (V4 has only settle caps)", async function () {
            const { manager, operatorEOA, safeAddr, v4Pm, v4Handler } = await loadFixture(deployUniV4Harness);
            // PM consumes only half the acquired token0 — below the min.
            await (await v4Pm.setMintUse(1_000_000n, (1n << 128n) - 1n)).wait();
            await expect(
                manager
                    .connect(operatorEOA)
                    .openLp(UNISWAP_V4, openParams(safeAddr, V4_KEY, { mintAmount0Min: WETH_OUT })),
            ).to.be.revertedWithCustomError(v4Handler, "MintAmountBelowMin");
        });

        it("rejects staking (V4 has no stakePool)", async function () {
            const { manager, operatorEOA, safeAddr, v4Handler } = await loadFixture(deployUniV4Harness);
            await expect(
                manager.connect(operatorEOA).openLp(UNISWAP_V4, openParams(safeAddr, V4_KEY, { stake: true })),
            ).to.be.revertedWithCustomError(v4Handler, "StakingNotSupported");
        });

        it("rejects a pool param outside the allow-list", async function () {
            const { manager, operatorEOA, safeAddr, v4Handler } = await loadFixture(deployUniV4Harness);
            await expect(
                manager.connect(operatorEOA).openLp(UNISWAP_V4, openParams(safeAddr, V4_BAD_KEY)),
            ).to.be.revertedWithCustomError(v4Handler, "PoolParamNotAllowed");
        });

        it("rejects an uninitialized pool (lazy V4 pools read a zero sqrt price)", async function () {
            const { manager, operatorEOA, safeAddr, v4Handler } = await loadFixture(deployUniV4Harness);
            await expect(
                manager.connect(operatorEOA).openLp(UNISWAP_V4, openParams(safeAddr, V4_UNINIT_KEY)),
            ).to.be.revertedWithCustomError(v4Handler, "PoolNotInitialized");
        });

        it("rejects a pool below the liquidity floor", async function () {
            const { manager, operatorEOA, deployer, safeAddr, v4Handler } = await loadFixture(deployUniV4Harness);
            await (await manager.connect(deployer).setMinPoolLiquidity(UNISWAP_V4, 10n ** 19n)).wait();
            await expect(
                manager.connect(operatorEOA).openLp(UNISWAP_V4, openParams(safeAddr, V4_KEY)),
            ).to.be.revertedWithCustomError(v4Handler, "PoolTooThin");
        });

        it("rejects a mint below the position-liquidity floor", async function () {
            const { manager, operatorEOA, deployer, safeAddr, v4Handler } = await loadFixture(deployUniV4Harness);
            await (await manager.connect(deployer).setMinPositionLiquidity(UNISWAP_V4, (1n << 127n) - 1n)).wait();
            await expect(
                manager.connect(operatorEOA).openLp(UNISWAP_V4, openParams(safeAddr, V4_KEY)),
            ).to.be.revertedWithCustomError(v4Handler, "PositionLiquidityTooLow");
        });

        it("rejects a mint whose computed liquidity is zero", async function () {
            const { manager, operatorEOA, safeAddr, stateView, v4Handler } = await loadFixture(deployUniV4Harness);
            // Price pinned one unit above MIN_SQRT_PRICE: over the full range
            // the token0 side yields zero liquidity for any realistic amount.
            await (await stateView.setPool(ethers.keccak256(V4_KEY), 4_295_128_740n, 10n ** 18n)).wait();
            await expect(
                manager
                    .connect(operatorEOA)
                    .openLp(UNISWAP_V4, openParams(safeAddr, V4_KEY, { tickLower: -887_200, tickUpper: 887_200 })),
            ).to.be.revertedWithCustomError(v4Handler, "PositionLiquidityTooLow");
        });

        it("enforces the token1-side mint minimum too", async function () {
            const { manager, operatorEOA, safeAddr, v4Pm, v4Handler } = await loadFixture(deployUniV4Harness);
            await (await v4Pm.setMintUse((1n << 128n) - 1n, 100_000n)).wait();
            await expect(
                manager
                    .connect(operatorEOA)
                    .openLp(UNISWAP_V4, openParams(safeAddr, V4_KEY, { mintAmount1Min: 200_000n })),
            ).to.be.revertedWithCustomError(v4Handler, "MintAmountBelowMin");
        });

        it("rejects a leg pool with the right currency0 but wrong currency1", async function () {
            const { manager, operatorEOA, safeAddr, v4Handler } = await loadFixture(deployUniV4Harness);
            await expect(
                manager
                    .connect(operatorEOA)
                    .openLp(UNISWAP_V4, openParams(safeAddr, V4_KEY, { swap0: leg(WETH_OUT, V4_WRONG1_KEY) })),
            ).to.be.revertedWithCustomError(v4Handler, "WrongTokenPair");
        });

        it("rejects a zero-output swap", async function () {
            const { manager, operatorEOA, safeAddr, universalRouter, v4Handler } =
                await loadFixture(deployUniV4Harness);
            await (await universalRouter.setOutput(0)).wait();
            await expect(
                manager.connect(operatorEOA).openLp(UNISWAP_V4, openParams(safeAddr, V4_KEY)),
            ).to.be.revertedWithCustomError(v4Handler, "SwapFailed");
        });

        it("rejects a mint that does not land on the Safe", async function () {
            const { manager, operatorEOA, safeAddr, stranger, v4Pm, v4Handler } = await loadFixture(deployUniV4Harness);
            await (await v4Pm.setMintOwnerOverride(stranger.address)).wait();
            await expect(
                manager.connect(operatorEOA).openLp(UNISWAP_V4, openParams(safeAddr, V4_KEY)),
            ).to.be.revertedWithCustomError(v4Handler, "LpNotOnSafe");
        });

        it("validates the swap leg: slippage bounds and route", async function () {
            const { manager, operatorEOA, safeAddr, v4Handler } = await loadFixture(deployUniV4Harness);
            const open = (overrides: Record<string, any>) =>
                manager.connect(operatorEOA).openLp(UNISWAP_V4, openParams(safeAddr, V4_KEY, overrides));

            await expect(open({ slippageBps: 0 })).to.be.revertedWithCustomError(v4Handler, "SlippageTooLow");
            await expect(open({ slippageBps: 301 })).to.be.revertedWithCustomError(v4Handler, "SlippageAboveMax");
            // Leg pool must trade the {token, USDC} pair — the native pool does not.
            await expect(open({ swap0: leg(WETH_OUT, V4_NATIVE_KEY) })).to.be.revertedWithCustomError(
                v4Handler,
                "WrongTokenPair",
            );
            // Leg pool param must itself be allow-listed.
            await expect(open({ swap0: leg(WETH_OUT, V4_BAD_KEY) })).to.be.revertedWithCustomError(
                v4Handler,
                "PoolParamNotAllowed",
            );
        });

        it("floors the UniversalRouter minimum at the V3 reference TWAP", async function () {
            const { manager, operatorEOA, safeAddr, universalRouter } = await loadFixture(deployUniV4Harness);
            // A V4 swap priced off Uniswap V3 history: the reference follows the
            // token, not the venue it trades on.
            const halfUsdc = USDC_AMOUNT / 2n;
            const floor = (halfUsdc * (10_000n - BigInt(SLIP))) / 10_000n;
            await (
                await manager
                    .connect(operatorEOA)
                    .openLp(UNISWAP_V4, openParams(safeAddr, V4_KEY, { swap0: leg(1n, V4_KEY) }))
            ).wait();
            expect(await universalRouter.lastAmountIn()).to.equal(halfUsdc);
            expect(await universalRouter.lastAmountOutMinimum()).to.equal(floor);
        });

        it("reverts one unit below the V4 effective floor and succeeds exactly at it", async function () {
            const { manager, operatorEOA, safeAddr, universalRouter } = await loadFixture(deployUniV4Harness);
            const floor = ((USDC_AMOUNT / 2n) * (10_000n - BigInt(SLIP))) / 10_000n;
            await (await universalRouter.setEnforceMinOut(true)).wait();
            await (await universalRouter.setOutput(floor - 1n)).wait();

            await expect(
                manager
                    .connect(operatorEOA)
                    .openLp(UNISWAP_V4, openParams(safeAddr, V4_KEY, { swap0: leg(1n, V4_KEY) })),
            ).to.be.revertedWith("ur: too little received");

            await (await universalRouter.setOutput(floor)).wait();
            await expect(
                manager
                    .connect(operatorEOA)
                    .openLp(UNISWAP_V4, openParams(safeAddr, V4_KEY, { swap0: leg(1n, V4_KEY) })),
            ).to.emit(manager, "PositionOpened");
            expect(await universalRouter.lastAmountOutMinimum()).to.equal(floor);
        });

        it("refuses an open leg whose reference floor rounds to zero", async function () {
            const { manager, operatorEOA, safeAddr, uniPool, v4Handler } = await loadFixture(deployUniV4Harness);
            await (await uniPool.setTwapTick(800_000)).wait();
            await expect(
                manager
                    .connect(operatorEOA)
                    .openLp(UNISWAP_V4, openParams(safeAddr, V4_KEY, { swap0: leg(0, V4_KEY) })),
            ).to.be.revertedWithCustomError(v4Handler, "InvalidSwapAmountOutMin");
        });

        it("maps module-call failures to their step codes", async function () {
            const { manager, operatorEOA, safeAddr, safe, usdcAddr, permit2, universalRouter, v4Pm, v4Handler } =
                await loadFixture(deployUniV4Harness);
            const open = () => manager.connect(operatorEOA).openLp(UNISWAP_V4, openParams(safeAddr, V4_KEY));

            // Leg swap: ERC20 approve USDC -> Permit2 is the first module call.
            await (await safe.setFail(usdcAddr, 1)).wait();
            await expect(open()).to.be.revertedWithCustomError(v4Handler, "ModuleCallFailed").withArgs(41);
            await (await safe.setFail(usdcAddr, 0)).wait();

            await (await safe.setFail(await permit2.getAddress(), 1)).wait();
            await expect(open()).to.be.revertedWithCustomError(v4Handler, "ModuleCallFailed").withArgs(42);
            await (await safe.setFail(await permit2.getAddress(), 0)).wait();

            await (await safe.setFail(await universalRouter.getAddress(), 1)).wait();
            await expect(open()).to.be.revertedWithCustomError(v4Handler, "ModuleCallFailed").withArgs(43);
            await (await safe.setFail(await universalRouter.getAddress(), 0)).wait();

            await (await safe.setFail(await v4Pm.getAddress(), 1)).wait();
            await expect(open()).to.be.revertedWithCustomError(v4Handler, "ModuleCallFailed").withArgs(55);
        });

        it("bubbles a module inner revert with returndata", async function () {
            const { manager, operatorEOA, safeAddr, safe, universalRouter } = await loadFixture(deployUniV4Harness);
            const reason = ethers.concat([
                "0x08c379a0",
                ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["boom"]),
            ]);
            await (await safe.setFailData(reason)).wait();
            await (await safe.setFail(await universalRouter.getAddress(), 2)).wait();
            await expect(
                manager.connect(operatorEOA).openLp(UNISWAP_V4, openParams(safeAddr, V4_KEY)),
            ).to.be.revertedWith("boom");
        });

        it("rejects an approve that returns false", async function () {
            const { manager, operatorEOA, safeAddr, usdc, v4Handler, usdcAddr } = await loadFixture(deployUniV4Harness);
            // The zero-reset after the leg swap returns false — must revert.
            await (await usdc.setFalseApproveZero(true)).wait();
            await expect(manager.connect(operatorEOA).openLp(UNISWAP_V4, openParams(safeAddr, V4_KEY)))
                .to.be.revertedWithCustomError(v4Handler, "TokenApprovalFailed")
                .withArgs(usdcAddr);
        });
    });

    describe("openLp (native ETH pair)", function () {
        it("opens a native position: ETH swap output, value-settled mint", async function () {
            const { manager, operatorEOA, safeAddr, v4Pm } = await loadFixture(deployUniV4Harness);

            await expect(manager.connect(operatorEOA).openLp(UNISWAP_V4, openParams(safeAddr, V4_NATIVE_KEY)))
                .to.emit(manager, "PositionOpened")
                .withArgs(safeAddr, UNISWAP_V4, 1n, USDC_AMOUNT, WETH_OUT, HALF, USDC_AMOUNT);

            expect(await v4Pm.ownerOf(1)).to.equal(safeAddr);
            // All acquired ETH went into the mint.
            expect(await ethers.provider.getBalance(safeAddr)).to.equal(0n);
        });

        it("sweeps unconsumed mint value back to the Safe and prices basis on used amounts", async function () {
            const { manager, operatorEOA, safeAddr, v4Pm } = await loadFixture(deployUniV4Harness);
            // The mint consumes only 1.5M of the 2M wei acquired; 0.5M is swept back.
            await (await v4Pm.setMintUse(1_500_000n, (1n << 128n) - 1n)).wait();

            // basis = 1.5M * (500k USDC / 2M wei) + 500k = 875k
            await expect(manager.connect(operatorEOA).openLp(UNISWAP_V4, openParams(safeAddr, V4_NATIVE_KEY)))
                .to.emit(manager, "PositionOpened")
                .withArgs(safeAddr, UNISWAP_V4, 1n, USDC_AMOUNT, 1_500_000n, HALF, 875_000n);

            expect(await ethers.provider.getBalance(safeAddr)).to.equal(500_000n);
        });
    });

    describe("closeLp (ERC20 pair)", function () {
        async function openedFixture() {
            const ctx = await loadFixture(deployUniV4Harness);
            await ctx.manager.connect(ctx.operatorEOA).openLp(UNISWAP_V4, openParams(ctx.safeAddr, V4_KEY));
            await (await ctx.universalRouter.setOutputFor(ctx.usdcAddr, CLOSE_OUT)).wait();
            return ctx;
        }

        it("fully closes: fees skimmed first, burn, swap back, performance fee", async function () {
            const ctx = await openedFixture();
            const { manager, operatorEOA, safeAddr, treasury, v4Pm, weth, usdc } = ctx;
            await (await v4Pm.setOwed(1, 40_000n, 20_000n)).wait();

            const usdcBefore = await usdc.balanceOf(safeAddr);
            const tx = manager.connect(operatorEOA).closeLp(UNISWAP_V4, closeParams(safeAddr, 1, V4_KEY));

            // collected 40k WETH / 20k USDC, 2.5% skim = 1000 / 500
            await expect(tx)
                .to.emit(manager, "FeesCollected")
                .withArgs(safeAddr, UNISWAP_V4, 1n, ctx.wethAddr, 40_000n, 1_000n, ctx.usdcAddr, 20_000n, 500n);
            // value = 19.5k fee USDC + 500k principal USDC + 600k swap out = 1_119_500
            // perf fee = 10% of (1_119_500 - 1_000_000) = 11_950
            await expect(tx)
                .to.emit(manager, "PositionClosed")
                .withArgs(safeAddr, UNISWAP_V4, 1n, USDC_AMOUNT, 1_119_500n, 11_950n, 10_000, 0n);

            expect(await usdc.balanceOf(safeAddr)).to.equal(usdcBefore + 1_119_500n - 11_950n);
            expect(await weth.balanceOf(treasury.address)).to.equal(1_000n);
            expect(await usdc.balanceOf(treasury.address)).to.equal(500n + 11_950n);
            expect(await manager.residualBasisUsd6Of(UNISWAP_V4, 1)).to.equal(0n);
            expect(await manager.positionHandlerOf(UNISWAP_V4, 1)).to.equal(ZERO);
            await expect(v4Pm.ownerOf(1)).to.be.revertedWith("ERC721: invalid token");
        });

        it("partially closes and decrements basis pro-rata", async function () {
            const ctx = await openedFixture();
            const { manager, operatorEOA, safeAddr, v4Pm } = ctx;

            await expect(
                manager.connect(operatorEOA).closeLp(UNISWAP_V4, closeParams(safeAddr, 1, V4_KEY, { exitBps: 5000 })),
            )
                .to.emit(manager, "PositionClosed")
                .withArgs(safeAddr, UNISWAP_V4, 1n, HALF, anyValue, anyValue, 5000, 0n);

            expect(await manager.residualBasisUsd6Of(UNISWAP_V4, 1)).to.equal(HALF);
            expect(await v4Pm.getPositionLiquidity(1)).to.be.gt(0n);
        });

        it("rejects a partial exit whose rounded liquidity is zero", async function () {
            const { manager, operatorEOA, safeAddr, v4Handler, universalRouter, usdcAddr } =
                await loadFixture(deployUniV4Harness);
            // Full-range small mint => liquidity (~5000) far below basis (10_000),
            // so exitBps=1 rounds liquidity to 0 while basisForExit is 1.
            await manager.connect(operatorEOA).openLp(
                UNISWAP_V4,
                openParams(safeAddr, V4_KEY, {
                    usdcAmount: 10_000n,
                    tickLower: -887_200,
                    tickUpper: 887_200,
                }),
            );
            await (await universalRouter.setOutputFor(usdcAddr, CLOSE_OUT)).wait();
            await expect(
                manager.connect(operatorEOA).closeLp(UNISWAP_V4, closeParams(safeAddr, 1, V4_KEY, { exitBps: 1 })),
            ).to.be.revertedWithCustomError(v4Handler, "InvalidExitBps");
        });

        it("enforces minUsdcOut on the gross realized value", async function () {
            const ctx = await openedFixture();
            const { manager, operatorEOA, safeAddr, v4Handler } = ctx;
            await expect(
                manager
                    .connect(operatorEOA)
                    .closeLp(UNISWAP_V4, closeParams(safeAddr, 1, V4_KEY, { minUsdcOut: 10n ** 12n })),
            ).to.be.revertedWithCustomError(v4Handler, "MinUsdcOutNotMet");
        });

        it("waives the collect fee when the treasury transfer reverts or returns false", async function () {
            const ctx = await openedFixture();
            const { manager, operatorEOA, safeAddr, treasury, v4Pm, weth, usdc } = ctx;
            await (await v4Pm.setOwed(1, 40_000n, 20_000n)).wait();
            await (await weth.setRevertTransferTo(treasury.address)).wait();
            await (await usdc.setFalseTransferTo(treasury.address)).wait();

            const tx = manager.connect(operatorEOA).closeLp(UNISWAP_V4, closeParams(safeAddr, 1, V4_KEY));
            await expect(tx).to.emit(manager, "CollectFeeTransferFailed").withArgs(safeAddr, 1n, ctx.wethAddr, 1_000n);
            await expect(tx).to.emit(manager, "CollectFeeTransferFailed").withArgs(safeAddr, 1n, ctx.usdcAddr, 500n);
            await expect(tx)
                .to.emit(manager, "FeesCollected")
                .withArgs(safeAddr, UNISWAP_V4, 1n, ctx.wethAddr, 40_000n, 0n, ctx.usdcAddr, 20_000n, 0n);
            expect(await weth.balanceOf(treasury.address)).to.equal(0n);
        });

        it("maps the fee-harvest and principal module calls to steps 60-62", async function () {
            const ctx = await openedFixture();
            const { manager, operatorEOA, safeAddr, safe, v4Pm, v4Handler } = ctx;
            await (await safe.setFail(await v4Pm.getAddress(), 1)).wait();
            await expect(manager.connect(operatorEOA).closeLp(UNISWAP_V4, closeParams(safeAddr, 1, V4_KEY)))
                .to.be.revertedWithCustomError(v4Handler, "ModuleCallFailed")
                .withArgs(60);
        });

        it("M-1: keeps the V4 USDC exit working after the swap leg's pool key is de-listed", async function () {
            const ctx = await openedFixture();
            const { manager, operatorEOA, deployer, safeAddr, v4Pm } = ctx;
            await (await manager.connect(deployer).setPoolParamAllowed(UNISWAP_V4, V4_KEY, false)).wait();
            expect(await manager.isPoolParamAllowed(UNISWAP_V4, V4_KEY)).to.equal(false);

            await (await v4Pm.setOwed(1, 40_000n, 0n)).wait();
            await expect(
                manager
                    .connect(operatorEOA)
                    .collectLp(
                        UNISWAP_V4,
                        collectParams(safeAddr, 1, V4_KEY, { swapFeesToUsdc: true, swap0: leg(0, V4_KEY) }),
                    ),
            ).to.emit(manager, "FeesCollected");
            await expect(manager.connect(operatorEOA).closeLp(UNISWAP_V4, closeParams(safeAddr, 1, V4_KEY))).to.emit(
                manager,
                "PositionClosed",
            );
        });

        it("L-1: leaves a V4 close delta in kind when its floor rounds to zero instead of reverting", async function () {
            const ctx = await openedFixture();
            const { manager, operatorEOA, safeAddr, v4Pm, universalRouter, weth, wethAddr, usdcAddr } = ctx;
            const key = { currency0: wethAddr, currency1: usdcAddr, fee: 500, tickSpacing: 10, hooks: ZERO };
            await (await v4Pm.seedPosition(1, safeAddr, key, 1_000_000n, 1n, 500_000n)).wait();
            const callsBefore = await universalRouter.callCount();
            const wethBefore = await weth.balanceOf(safeAddr);

            const tx = manager
                .connect(operatorEOA)
                .closeLp(UNISWAP_V4, closeParams(safeAddr, 1, V4_KEY, { swap0: leg(0, V4_KEY) }));
            await expect(tx)
                .to.emit(manager, "PositionClosed")
                .withArgs(safeAddr, UNISWAP_V4, 1n, USDC_AMOUNT, 500_000n, 0n, 10_000, 0n);
            await expect(tx).to.emit(manager, "SwapSkippedBelowFloor").withArgs(safeAddr, wethAddr, 1n);

            expect(await universalRouter.callCount()).to.equal(callsBefore);
            expect(await weth.balanceOf(safeAddr)).to.equal(wethBefore + 1n);
        });
    });

    describe("closeLp (native ETH pair)", function () {
        async function openedNativeFixture() {
            const ctx = await loadFixture(deployUniV4Harness);
            await ctx.manager.connect(ctx.operatorEOA).openLp(UNISWAP_V4, openParams(ctx.safeAddr, V4_NATIVE_KEY));
            await (await ctx.universalRouter.setOutputFor(ctx.usdcAddr, CLOSE_OUT)).wait();
            return ctx;
        }

        it("fully closes a native position: ETH fees skimmed, ETH principal swapped back", async function () {
            const ctx = await openedNativeFixture();
            const { manager, operatorEOA, safeAddr, treasury, v4Pm, usdc } = ctx;
            await (await v4Pm.setOwed(1, 40_000n, 20_000n)).wait();

            const treasuryEthBefore = await ethers.provider.getBalance(treasury.address);
            const tx = manager.connect(operatorEOA).closeLp(UNISWAP_V4, closeParams(safeAddr, 1, V4_NATIVE_KEY));

            await expect(tx)
                .to.emit(manager, "FeesCollected")
                .withArgs(safeAddr, UNISWAP_V4, 1n, ZERO, 40_000n, 1_000n, ctx.usdcAddr, 20_000n, 500n);
            await expect(tx)
                .to.emit(manager, "PositionClosed")
                .withArgs(safeAddr, UNISWAP_V4, 1n, USDC_AMOUNT, 1_119_500n, 11_950n, 10_000, 0n);

            // ETH fee skim landed on the treasury; the Safe holds no stray ETH.
            expect(await ethers.provider.getBalance(treasury.address)).to.equal(treasuryEthBefore + 1_000n);
            expect(await ethers.provider.getBalance(safeAddr)).to.equal(0n);
            await expect(v4Pm.ownerOf(1)).to.be.revertedWith("ERC721: invalid token");
        });

        it("waives the native fee when the treasury cannot receive ETH", async function () {
            const ctx = await openedNativeFixture();
            const { manager, operatorEOA, timelock, safeAddr, v4Pm, reg } = ctx;
            // MockRegistry has no receive() — the ETH skim call fails.
            await (await timelockCall(timelock, manager, "setTreasury", [await reg.getAddress()])).wait();
            await (await v4Pm.setOwed(1, 40_000n, 0n)).wait();

            const tx = manager.connect(operatorEOA).closeLp(UNISWAP_V4, closeParams(safeAddr, 1, V4_NATIVE_KEY));
            await expect(tx).to.emit(manager, "CollectFeeTransferFailed").withArgs(safeAddr, 1n, ZERO, 1_000n);
            await expect(tx)
                .to.emit(manager, "FeesCollected")
                .withArgs(safeAddr, UNISWAP_V4, 1n, ZERO, 40_000n, 0n, ctx.usdcAddr, 0n, 0n);
        });
    });

    describe("collectLp", function () {
        async function openedWithFees() {
            const ctx = await loadFixture(deployUniV4Harness);
            await ctx.manager.connect(ctx.operatorEOA).openLp(UNISWAP_V4, openParams(ctx.safeAddr, V4_KEY));
            await (await ctx.v4Pm.setOwed(1, 40_000n, 20_000n)).wait();
            return ctx;
        }

        it("harvests fees to the Safe with the treasury skim, no swap", async function () {
            const ctx = await openedWithFees();
            const { manager, operatorEOA, safeAddr, treasury, weth, usdc } = ctx;
            const wethBefore = await weth.balanceOf(safeAddr);
            const usdcBefore = await usdc.balanceOf(safeAddr);

            await expect(manager.connect(operatorEOA).collectLp(UNISWAP_V4, collectParams(safeAddr, 1, V4_KEY)))
                .to.emit(manager, "FeesCollected")
                .withArgs(safeAddr, UNISWAP_V4, 1n, ctx.wethAddr, 40_000n, 1_000n, ctx.usdcAddr, 20_000n, 500n);

            expect(await weth.balanceOf(safeAddr)).to.equal(wethBefore + 39_000n);
            expect(await usdc.balanceOf(safeAddr)).to.equal(usdcBefore + 19_500n);
            expect(await weth.balanceOf(treasury.address)).to.equal(1_000n);
            expect(await usdc.balanceOf(treasury.address)).to.equal(500n);
        });

        it("swaps harvested fees to USDC on request", async function () {
            const ctx = await openedWithFees();
            const { manager, operatorEOA, safeAddr, universalRouter, usdc, usdcAddr, weth } = ctx;
            await (await universalRouter.setOutputFor(usdcAddr, CLOSE_OUT)).wait();
            const wethBefore = await weth.balanceOf(safeAddr);
            const usdcBefore = await usdc.balanceOf(safeAddr);

            await manager
                .connect(operatorEOA)
                .collectLp(UNISWAP_V4, collectParams(safeAddr, 1, V4_KEY, { swapFeesToUsdc: true }));

            // 39k net WETH fees swapped for 600k USDC + 19.5k net USDC fees.
            expect(await weth.balanceOf(safeAddr)).to.equal(wethBefore);
            expect(await usdc.balanceOf(safeAddr)).to.equal(usdcBefore + CLOSE_OUT + 19_500n);
        });

        it("leaves a dynamic V4 fee delta in kind when its independent floor rounds to zero", async function () {
            const ctx = await loadFixture(deployUniV4Harness);
            const { manager, operatorEOA, safeAddr, universalRouter, v4Pm, weth } = ctx;
            await manager.connect(operatorEOA).openLp(UNISWAP_V4, openParams(safeAddr, V4_KEY));
            await (await v4Pm.setOwed(1, 1n, 0n)).wait();
            const callsBefore = await universalRouter.callCount();
            const wethBefore = await weth.balanceOf(safeAddr);

            await expect(
                manager.connect(operatorEOA).collectLp(
                    UNISWAP_V4,
                    collectParams(safeAddr, 1, V4_KEY, {
                        swapFeesToUsdc: true,
                        swap0: leg(0, V4_KEY),
                    }),
                ),
            ).to.emit(manager, "FeesCollected");

            expect(await universalRouter.callCount()).to.equal(callsBefore);
            expect(await weth.balanceOf(safeAddr)).to.equal(wethBefore + 1n);
        });

        it("rejects an expired deadline on the swap path only", async function () {
            const ctx = await openedWithFees();
            const { manager, operatorEOA, safeAddr, v4Handler } = ctx;
            await expect(
                manager
                    .connect(operatorEOA)
                    .collectLp(UNISWAP_V4, collectParams(safeAddr, 1, V4_KEY, { swapFeesToUsdc: true, deadline: 1 })),
            ).to.be.revertedWithCustomError(v4Handler, "DeadlineExpired");
            // The no-swap path ignores the stale deadline.
            await expect(
                manager.connect(operatorEOA).collectLp(UNISWAP_V4, collectParams(safeAddr, 1, V4_KEY, { deadline: 1 })),
            ).to.emit(manager, "FeesCollected");
        });

        it("handles a fee-less harvest and a skim rounded to zero", async function () {
            const ctx = await loadFixture(deployUniV4Harness);
            const { manager, operatorEOA, safeAddr, v4Pm, treasury, usdc } = ctx;
            await manager.connect(operatorEOA).openLp(UNISWAP_V4, openParams(safeAddr, V4_KEY));

            // No fees at all: amounts 0, fee 0.
            await expect(manager.connect(operatorEOA).collectLp(UNISWAP_V4, collectParams(safeAddr, 1, V4_KEY)))
                .to.emit(manager, "FeesCollected")
                .withArgs(safeAddr, UNISWAP_V4, 1n, ctx.wethAddr, 0n, 0n, ctx.usdcAddr, 0n, 0n);

            // 39 * 250 / 10000 = 0 — fee rounds to zero, nothing skimmed.
            await (await v4Pm.setOwed(1, 0n, 39n)).wait();
            await expect(manager.connect(operatorEOA).collectLp(UNISWAP_V4, collectParams(safeAddr, 1, V4_KEY)))
                .to.emit(manager, "FeesCollected")
                .withArgs(safeAddr, UNISWAP_V4, 1n, ctx.wethAddr, 0n, 0n, ctx.usdcAddr, 39n, 0n);
            expect(await usdc.balanceOf(treasury.address)).to.equal(0n);
        });

        it("rejects collect for a position the Safe does not own", async function () {
            const ctx = await openedWithFees();
            const { manager, operatorEOA, safeAddr, stranger, v4Pm, v4Handler } = ctx;
            await (await v4Pm.setOwner(1, stranger.address)).wait();
            await expect(
                manager.connect(operatorEOA).collectLp(UNISWAP_V4, collectParams(safeAddr, 1, V4_KEY)),
            ).to.be.revertedWithCustomError(v4Handler, "LpNotOnSafe");
        });

        it("harvests native ETH fees", async function () {
            const ctx = await loadFixture(deployUniV4Harness);
            const { manager, operatorEOA, safeAddr, v4Pm, treasury } = ctx;
            await manager.connect(operatorEOA).openLp(UNISWAP_V4, openParams(ctx.safeAddr, V4_NATIVE_KEY));
            await (await v4Pm.setOwed(1, 40_000n, 0n)).wait();
            const treasuryEthBefore = await ethers.provider.getBalance(treasury.address);

            await expect(manager.connect(operatorEOA).collectLp(UNISWAP_V4, collectParams(safeAddr, 1, V4_NATIVE_KEY)))
                .to.emit(manager, "FeesCollected")
                .withArgs(safeAddr, UNISWAP_V4, 1n, ZERO, 40_000n, 1_000n, ctx.usdcAddr, 0n, 0n);

            expect(await ethers.provider.getBalance(safeAddr)).to.equal(39_000n);
            expect(await ethers.provider.getBalance(treasury.address)).to.equal(treasuryEthBefore + 1_000n);
        });
    });

    describe("USDC-as-currency0 pair", function () {
        // {USDC, tokenC} sorts USDC first, flipping every currency0/currency1
        // USDC-side branch relative to the WETH/USDC pair.
        function usdc0Open(safeAddr: string, overrides: Record<string, any> = {}) {
            return openParams(safeAddr, V4_USDC0_KEY, {
                swap0: ZERO_LEG,
                swap1: leg(WETH_OUT, V4_USDC0_KEY),
                ...overrides,
            });
        }

        it("runs the full lifecycle with the swap on the currency1 side", async function () {
            const { manager, operatorEOA, safeAddr, universalRouter, usdcAddr, tokenC, tokenCAddr, v4Pm, usdc } =
                await loadFixture(deployUniV4Harness);

            await expect(manager.connect(operatorEOA).openLp(UNISWAP_V4, usdc0Open(safeAddr)))
                .to.emit(manager, "PositionOpened")
                .withArgs(safeAddr, UNISWAP_V4, 1n, USDC_AMOUNT, HALF, WETH_OUT, USDC_AMOUNT);

            await (await v4Pm.setOwed(1, 20_000n, 40_000n)).wait();
            await (await universalRouter.setOutputFor(usdcAddr, CLOSE_OUT)).wait();

            // Harvest with the tokenC (currency1) fees swapped to USDC.
            const usdcBefore = await usdc.balanceOf(safeAddr);
            await expect(
                manager.connect(operatorEOA).collectLp(
                    UNISWAP_V4,
                    collectParams(safeAddr, 1, V4_USDC0_KEY, {
                        swapFeesToUsdc: true,
                        swap0: ZERO_LEG,
                        swap1: leg(CLOSE_OUT, V4_USDC0_KEY),
                    }),
                ),
            )
                .to.emit(manager, "FeesCollected")
                .withArgs(safeAddr, UNISWAP_V4, 1n, usdcAddr, 20_000n, 500n, tokenCAddr, 40_000n, 1_000n);
            // 19.5k net USDC fees + 39k tokenC fees swapped for 600k USDC.
            expect(await usdc.balanceOf(safeAddr)).to.equal(usdcBefore + 19_500n + CLOSE_OUT);

            await expect(
                manager.connect(operatorEOA).closeLp(
                    UNISWAP_V4,
                    closeParams(safeAddr, 1, V4_USDC0_KEY, {
                        swap0: ZERO_LEG,
                        swap1: leg(CLOSE_OUT, V4_USDC0_KEY),
                    }),
                ),
            ).to.emit(manager, "PositionClosed");
            expect(await tokenC.balanceOf(safeAddr)).to.equal(0n);
        });
    });

    describe("partial close with zero rounded liquidity and zero basis slice", function () {
        it("skips the decrease and settles at zero value without reverting", async function () {
            const { manager, operatorEOA, safeAddr, universalRouter, usdcAddr, v4Pm } =
                await loadFixture(deployUniV4Harness);
            // Full-range mint => liquidity (~4000) below basis (8000); exitBps=1
            // rounds BOTH the liquidity and the basis slice to zero.
            await manager.connect(operatorEOA).openLp(
                UNISWAP_V4,
                openParams(safeAddr, V4_KEY, {
                    usdcAmount: 8_000n,
                    tickLower: -887_200,
                    tickUpper: 887_200,
                }),
            );
            await (await universalRouter.setOutputFor(usdcAddr, CLOSE_OUT)).wait();
            const liquidityBefore = await v4Pm.getPositionLiquidity(1);

            await expect(
                manager.connect(operatorEOA).closeLp(UNISWAP_V4, closeParams(safeAddr, 1, V4_KEY, { exitBps: 1 })),
            )
                .to.emit(manager, "PositionClosed")
                .withArgs(safeAddr, UNISWAP_V4, 1n, 0n, 0n, 0n, 1, 0n);

            expect(await v4Pm.getPositionLiquidity(1)).to.equal(liquidityBefore);
            expect(await manager.residualBasisUsd6Of(UNISWAP_V4, 1)).to.equal(8_000n);
        });
    });

    describe("switchLp across V3, Aerodrome and V4", function () {
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

        it("switches V3 -> V4 in kind with zero manager changes", async function () {
            const { manager, operatorEOA, safeAddr, v4Handler, v4Pm } = await loadFixture(deployUniV4Harness);
            await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER));

            await expect(
                manager.connect(operatorEOA).switchLp(UNISWAP_V3, UNISWAP_V4, switchParams(safeAddr, 1, V4_KEY)),
            )
                .to.emit(manager, "PositionSwitched")
                .withArgs(safeAddr, UNISWAP_V3, UNISWAP_V4, 1n, 1n, USDC_AMOUNT, WETH_OUT, HALF, WETH_OUT, HALF);

            expect(await manager.residualBasisUsd6Of(UNISWAP_V3, 1)).to.equal(0n);
            expect(await manager.residualBasisUsd6Of(UNISWAP_V4, 1)).to.equal(USDC_AMOUNT);
            expect(await manager.positionHandlerOf(UNISWAP_V4, 1)).to.equal(await v4Handler.getAddress());
            expect(await v4Pm.ownerOf(1)).to.equal(safeAddr);
        });

        it("switches V3 -> native V4, unwrapping the withdrawn WETH", async function () {
            const { manager, operatorEOA, safeAddr, weth, v4Pm } = await loadFixture(deployUniV4Harness);
            await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER));

            await expect(
                manager.connect(operatorEOA).switchLp(UNISWAP_V3, UNISWAP_V4, switchParams(safeAddr, 1, V4_NATIVE_KEY)),
            )
                .to.emit(manager, "PositionSwitched")
                .withArgs(safeAddr, UNISWAP_V3, UNISWAP_V4, 1n, 1n, USDC_AMOUNT, WETH_OUT, HALF, WETH_OUT, HALF);

            expect(await manager.residualBasisUsd6Of(UNISWAP_V4, 1)).to.equal(USDC_AMOUNT);
            expect(await v4Pm.ownerOf(1)).to.equal(safeAddr);
            expect(await weth.balanceOf(safeAddr)).to.equal(0n);
        });

        it("switches V4 -> V3, wrapping the native side of the withdrawal", async function () {
            const { manager, operatorEOA, safeAddr, weth, uniHandler, uniNpm } = await loadFixture(deployUniV4Harness);
            await manager.connect(operatorEOA).openLp(UNISWAP_V4, openParams(safeAddr, V4_NATIVE_KEY));

            await expect(
                manager.connect(operatorEOA).switchLp(UNISWAP_V4, UNISWAP_V3, switchParams(safeAddr, 1, FEE_TIER)),
            )
                .to.emit(manager, "PositionSwitched")
                .withArgs(safeAddr, UNISWAP_V4, UNISWAP_V3, 1n, 1n, USDC_AMOUNT, WETH_OUT, HALF, WETH_OUT, HALF);

            expect(await manager.residualBasisUsd6Of(UNISWAP_V4, 1)).to.equal(0n);
            expect(await manager.residualBasisUsd6Of(UNISWAP_V3, 1)).to.equal(USDC_AMOUNT);
            expect(await manager.positionHandlerOf(UNISWAP_V3, 1)).to.equal(await uniHandler.getAddress());
            expect(await uniNpm.ownerOf(1)).to.equal(safeAddr);
            expect(await weth.balanceOf(safeAddr)).to.equal(0n);
        });

        it("switches Aerodrome -> V4 in kind with zero manager changes", async function () {
            const { manager, operatorEOA, safeAddr, v4Handler, v4Pm } = await loadFixture(deployUniV4Harness);
            await manager.connect(operatorEOA).openLp(AERODROME, openParams(safeAddr, TICK_SPACING));

            await expect(
                manager.connect(operatorEOA).switchLp(AERODROME, UNISWAP_V4, switchParams(safeAddr, 1, V4_KEY)),
            )
                .to.emit(manager, "PositionSwitched")
                .withArgs(safeAddr, AERODROME, UNISWAP_V4, 1n, 1n, USDC_AMOUNT, WETH_OUT, HALF, WETH_OUT, HALF);

            expect(await manager.residualBasisUsd6Of(AERODROME, 1)).to.equal(0n);
            expect(await manager.residualBasisUsd6Of(UNISWAP_V4, 1)).to.equal(USDC_AMOUNT);
            expect(await manager.positionHandlerOf(UNISWAP_V4, 1)).to.equal(await v4Handler.getAddress());
            expect(await v4Pm.ownerOf(1)).to.equal(safeAddr);
        });

        it("switches V4 -> Aerodrome, wrapping the native side of the withdrawal", async function () {
            const { manager, operatorEOA, safeAddr, aeroHandler, clNpm } = await loadFixture(deployUniV4Harness);
            await manager.connect(operatorEOA).openLp(UNISWAP_V4, openParams(safeAddr, V4_NATIVE_KEY));

            await expect(
                manager.connect(operatorEOA).switchLp(UNISWAP_V4, AERODROME, switchParams(safeAddr, 1, TICK_SPACING)),
            )
                .to.emit(manager, "PositionSwitched")
                .withArgs(safeAddr, UNISWAP_V4, AERODROME, 1n, 1n, USDC_AMOUNT, WETH_OUT, HALF, WETH_OUT, HALF);

            expect(await manager.residualBasisUsd6Of(UNISWAP_V4, 1)).to.equal(0n);
            expect(await manager.residualBasisUsd6Of(AERODROME, 1)).to.equal(USDC_AMOUNT);
            expect(await manager.positionHandlerOf(AERODROME, 1)).to.equal(await aeroHandler.getAddress());
            expect(await clNpm.ownerOf(1)).to.equal(safeAddr);
        });

        it("rejects an in-kind open whose tokens do not match the destination pool", async function () {
            const { manager, operatorEOA, safeAddr, v4Handler } = await loadFixture(deployUniV4Harness);
            await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER));

            // currency1 mismatch: the destination trades {WETH, tokenC}, not {WETH, USDC}.
            await expect(
                manager.connect(operatorEOA).switchLp(UNISWAP_V3, UNISWAP_V4, switchParams(safeAddr, 1, V4_WRONG1_KEY)),
            ).to.be.revertedWithCustomError(v4Handler, "WrongTokenPair");

            // currency0 mismatch: the destination's currency0 is USDC, the withdrawal delivered WETH.
            await expect(
                manager.connect(operatorEOA).switchLp(UNISWAP_V3, UNISWAP_V4, switchParams(safeAddr, 1, V4_USDC0_KEY)),
            ).to.be.revertedWithCustomError(v4Handler, "WrongTokenPair");
        });

        it("switches an ERC20-currency0 V4 position out without wrapping", async function () {
            const { manager, operatorEOA, safeAddr, uniHandler, uniNpm, weth } = await loadFixture(deployUniV4Harness);
            await manager.connect(operatorEOA).openLp(UNISWAP_V4, openParams(safeAddr, V4_KEY));
            const safeWethBefore = await weth.balanceOf(safeAddr);

            await expect(
                manager.connect(operatorEOA).switchLp(UNISWAP_V4, UNISWAP_V3, switchParams(safeAddr, 1, FEE_TIER)),
            )
                .to.emit(manager, "PositionSwitched")
                .withArgs(safeAddr, UNISWAP_V4, UNISWAP_V3, 1n, 1n, USDC_AMOUNT, WETH_OUT, HALF, WETH_OUT, HALF);

            expect(await manager.positionHandlerOf(UNISWAP_V3, 1)).to.equal(await uniHandler.getAddress());
            expect(await uniNpm.ownerOf(1)).to.equal(safeAddr);
            // The WETH went straight from the V4 burn into the V3 mint — never parked on the Safe.
            expect(await weth.balanceOf(safeAddr)).to.equal(safeWethBefore);
        });

        it("rejects a destination mint below the position-liquidity floor", async function () {
            const { manager, deployer, operatorEOA, safeAddr } = await loadFixture(deployUniV4Harness);
            await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER));
            await (await manager.connect(deployer).setMinPositionLiquidity(UNISWAP_V4, 10n ** 18n)).wait();

            await expect(
                manager.connect(operatorEOA).switchLp(UNISWAP_V3, UNISWAP_V4, switchParams(safeAddr, 1, V4_KEY)),
            ).to.be.revertedWithCustomError(manager, "PositionLiquidityTooLow");
        });

        it("enforces the destination mint minimums on each side", async function () {
            const { manager, operatorEOA, safeAddr, v4Handler } = await loadFixture(deployUniV4Harness);
            await manager.connect(operatorEOA).openLp(UNISWAP_V3, openParams(safeAddr, FEE_TIER));

            await expect(
                manager
                    .connect(operatorEOA)
                    .switchLp(
                        UNISWAP_V3,
                        UNISWAP_V4,
                        switchParams(safeAddr, 1, V4_KEY, { mintAmount0Min: WETH_OUT + 1n }),
                    ),
            ).to.be.revertedWithCustomError(v4Handler, "MintAmountBelowMin");

            await expect(
                manager
                    .connect(operatorEOA)
                    .switchLp(UNISWAP_V3, UNISWAP_V4, switchParams(safeAddr, 1, V4_KEY, { mintAmount1Min: HALF + 1n })),
            ).to.be.revertedWithCustomError(v4Handler, "MintAmountBelowMin");
        });
    });
});
