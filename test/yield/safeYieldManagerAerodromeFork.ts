import { expect } from "chai";
import { ethers, network } from "hardhat";
import {
    AERO_ADDRESS,
    AERODROME_CL_FACTORY_ADDRESS,
    AERODROME_SLIPSTREAM_NPM_ADDRESS,
    AERODROME_SLIPSTREAM_SWAP_ROUTER_ADDRESS,
    AERODROME_VOTER_ADDRESS,
    USDC_ADDRESS,
    WETH_ADDRESS,
} from "../../contractAddresses";
import { encodeAerodromePoolParam } from "../../contractAddresses";
import { ZERO_LEG, leg } from "../helpers/utils";
import { deployRealSafe, enableModuleOnSafe } from "../helpers/deployRealSafe";

const AERODROME = 1;
const TICK_SPACING = 100;
const AERO_TICK_SPACING = 50; // tick spacing of the live USDC/AERO CL pool
const FORK_BLOCK = Number(process.env.BASE_FORK_BLOCK_NUMBER ?? 49_470_000);
const POOL_PARAM = encodeAerodromePoolParam(WETH_ADDRESS, USDC_ADDRESS, TICK_SPACING);
// USDC < AERO, so USDC is token0 of the USDC/AERO CL pools — the pair
// ordering the WETH/USDC tests never exercise (funding token as token0,
// swap1 leg doing the real work). The ts-50 pool is nearly empty; ts 200
// is the deep USDC/AERO pool that can absorb LP-sized swaps.
const AERO_LP_TICK_SPACING = 200;
const AERO_POOL_PARAM = encodeAerodromePoolParam(USDC_ADDRESS, AERO_ADDRESS, AERO_LP_TICK_SPACING);

const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address,uint256) returns (bool)",
];
const FACTORY_ABI = ["function getPool(address,address,int24) view returns (address)"];
const POOL_ABI = [
    "function token0() view returns (address)",
    "function token1() view returns (address)",
    "function slot0() view returns (uint160,int24,uint16,uint16,uint16,bool)",
];
const NPM_ABI = ["function ownerOf(uint256) view returns (address)"];
const VOTER_ABI = ["function gauges(address) view returns (address)"];

async function deployAeroStack() {
    const [admin, operator, treasury, pauser] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("MockRegistry");
    const registry = await Registry.deploy();
    await registry.waitForDeployment();
    await (await registry.setOperator(operator.address)).wait();
    await (await registry.setWhitelisted(WETH_ADDRESS, true)).wait();
    await (await registry.setWhitelisted(USDC_ADDRESS, true)).wait();

    const safeAddress = await deployRealSafe(admin);

    const Handler = await ethers.getContractFactory("AerodromeYieldHandler");
    const handler = await Handler.deploy(
        AERODROME_SLIPSTREAM_NPM_ADDRESS,
        USDC_ADDRESS,
        AERODROME_SLIPSTREAM_SWAP_ROUTER_ADDRESS,
        AERODROME_CL_FACTORY_ADDRESS,
        AERODROME_VOTER_ADDRESS,
    );
    await handler.waitForDeployment();

    const Timelock = await ethers.getContractFactory("MockTimelockController");
    const timelock = await Timelock.deploy(1);
    await timelock.waitForDeployment();

    const Manager = await ethers.getContractFactory("SafeYieldManager");
    const manager = await Manager.deploy(
        await registry.getAddress(),
        USDC_ADDRESS,
        [AERODROME],
        [await handler.getAddress()],
        [[POOL_PARAM]],
        [0],
        [0],
        treasury.address,
        1_000,
        250,
        2_000,
        admin.address,
        await timelock.getAddress(),
        pauser.address,
    );
    await manager.waitForDeployment();

    await enableModuleOnSafe(safeAddress, admin, await manager.getAddress());

    return { operator, treasury, safeAddress, handler, manager, registry };
}

async function readAeroPool() {
    const factory = new ethers.Contract(AERODROME_CL_FACTORY_ADDRESS, FACTORY_ABI, ethers.provider);
    const poolAddress: string = await factory.getPool(WETH_ADDRESS, USDC_ADDRESS, TICK_SPACING);
    expect(poolAddress).to.not.equal(ethers.ZeroAddress);
    const pool = new ethers.Contract(poolAddress, POOL_ABI, ethers.provider);
    const [sqrtPriceRaw, tick] = await pool.slot0();
    const sqrtPriceX96 = BigInt(sqrtPriceRaw);
    const alignedTick = Math.floor(Number(tick) / TICK_SPACING) * TICK_SPACING;
    return { poolAddress, pool, sqrtPriceX96, alignedTick };
}

const ROUTER_ABI = [
    "function exactInputSingle((address,address,int24,address,uint256,uint256,uint256,uint160)) payable returns (uint256)",
];
const WETH_DEPOSIT_ABI = [
    "function deposit() payable",
    "function approve(address,uint256) returns (bool)",
    "function balanceOf(address) view returns (uint256)",
];

// Ping-pong real swaps through the WETH/USDC pool so in-range positions
// accrue genuine trading fees on the fork.
async function accrueSwapFees(rounds: number, wethPerSwap: bigint) {
    const trader = (await ethers.getSigners())[4];
    const weth = new ethers.Contract(WETH_ADDRESS, WETH_DEPOSIT_ABI, trader);
    const usdc = new ethers.Contract(
        USDC_ADDRESS,
        [...ERC20_ABI, "function approve(address,uint256) returns (bool)"],
        trader,
    );
    const router = new ethers.Contract(AERODROME_SLIPSTREAM_SWAP_ROUTER_ADDRESS, ROUTER_ABI, trader);
    await (await weth.deposit({ value: wethPerSwap * 2n })).wait();
    await (await weth.approve(AERODROME_SLIPSTREAM_SWAP_ROUTER_ADDRESS, ethers.MaxUint256)).wait();
    await (await usdc.approve(AERODROME_SLIPSTREAM_SWAP_ROUTER_ADDRESS, ethers.MaxUint256)).wait();
    for (let i = 0; i < rounds; i++) {
        const block = await ethers.provider.getBlock("latest");
        const deadline = BigInt(block!.timestamp + 600);
        await (
            await router.exactInputSingle([
                WETH_ADDRESS,
                USDC_ADDRESS,
                TICK_SPACING,
                trader.address,
                deadline,
                wethPerSwap,
                0n,
                0n,
            ])
        ).wait();
        const usdcBal: bigint = await usdc.balanceOf(trader.address);
        await (
            await router.exactInputSingle([
                USDC_ADDRESS,
                WETH_ADDRESS,
                TICK_SPACING,
                trader.address,
                deadline,
                usdcBal,
                0n,
                0n,
            ])
        ).wait();
    }
}

// Same ping-pong, but through the USDC/AERO ts-200 pool, with the trader's
// USDC capital pulled from the (separate) WETH/USDC pool.
async function accrueAeroSwapFees(wethUsdcPool: string, rounds: number, usdcCapital: bigint) {
    const trader = (await ethers.getSigners())[4];
    await fundSafeUsdc(wethUsdcPool, trader.address, usdcCapital);
    const approveAbi = ["function approve(address,uint256) returns (bool)"];
    const usdc = new ethers.Contract(USDC_ADDRESS, [...ERC20_ABI, ...approveAbi], trader);
    const aero = new ethers.Contract(AERO_ADDRESS, [...ERC20_ABI, ...approveAbi], trader);
    const router = new ethers.Contract(AERODROME_SLIPSTREAM_SWAP_ROUTER_ADDRESS, ROUTER_ABI, trader);
    await (await usdc.approve(AERODROME_SLIPSTREAM_SWAP_ROUTER_ADDRESS, ethers.MaxUint256)).wait();
    await (await aero.approve(AERODROME_SLIPSTREAM_SWAP_ROUTER_ADDRESS, ethers.MaxUint256)).wait();
    for (let i = 0; i < rounds; i++) {
        const block = await ethers.provider.getBlock("latest");
        const deadline = BigInt(block!.timestamp + 600);
        const usdcBal: bigint = await usdc.balanceOf(trader.address);
        await (
            await router.exactInputSingle([
                USDC_ADDRESS,
                AERO_ADDRESS,
                AERO_LP_TICK_SPACING,
                trader.address,
                deadline,
                usdcBal,
                0n,
                0n,
            ])
        ).wait();
        const aeroBal: bigint = await aero.balanceOf(trader.address);
        await (
            await router.exactInputSingle([
                AERO_ADDRESS,
                USDC_ADDRESS,
                AERO_LP_TICK_SPACING,
                trader.address,
                deadline,
                aeroBal,
                0n,
                0n,
            ])
        ).wait();
    }
}

// The live pool is a convenient deterministic USDC holder on the fork.
// Impersonation only mutates the disposable fork state.
async function fundSafeUsdc(poolAddress: string, safeAddress: string, amount: bigint) {
    await network.provider.send("hardhat_setBalance", [poolAddress, "0x8AC7230489E80000"]);
    const poolSigner = await ethers.getImpersonatedSigner(poolAddress);
    const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, ethers.provider);
    await (await (usdc.connect(poolSigner) as any).transfer(safeAddress, amount)).wait();
    await network.provider.send("hardhat_stopImpersonatingAccount", [poolAddress]);
    return usdc;
}

describe("SafeYieldManager + Aerodrome - integration (Base fork)", function () {
    this.timeout(300_000);

    beforeEach(async function () {
        await network.provider.request({
            method: "hardhat_reset",
            params: [
                {
                    forking: {
                        jsonRpcUrl: process.env.BASE_RPC_URL || "https://mainnet.base.org",
                        blockNumber: FORK_BLOCK,
                    },
                },
            ],
        });
    });

    it("opens, collects, partially closes, and fully closes a real Slipstream position", async function () {
        const { operator, safeAddress, manager } = await deployAeroStack();
        const { poolAddress, pool, sqrtPriceX96, alignedTick } = await readAeroPool();
        expect(await pool.token0()).to.equal(WETH_ADDRESS);
        expect(await pool.token1()).to.equal(USDC_ADDRESS);
        const spotUsdcToWeth = (amount: bigint) => (amount << 192n) / (sqrtPriceX96 * sqrtPriceX96);
        const spotWethToUsdc = (amount: bigint) => (amount * sqrtPriceX96 * sqrtPriceX96) >> 192n;

        const input = ethers.parseUnits("10", 6);
        const usdc = await fundSafeUsdc(poolAddress, safeAddress, input);

        const block = await ethers.provider.getBlock("latest");
        const deadline = BigInt(block!.timestamp + 3_600);
        const expectedSwapOut = spotUsdcToWeth(input / 2n);
        const openParams = {
            onBehalfOf: safeAddress,
            usdcAmount: input,
            tickLower: alignedTick - 1_000,
            tickUpper: alignedTick + 1_000,
            mintAmount0Min: 0,
            mintAmount1Min: 0,
            swap0: leg((expectedSwapOut * 9_900n) / 10_000n, expectedSwapOut, POOL_PARAM),
            swap1: ZERO_LEG,
            slippageBps: 100,
            deadline,
            lpPoolParam: POOL_PARAM,
            stake: false,
        };

        await expect(
            manager.connect(operator).openLp(AERODROME, {
                ...openParams,
                swap0: leg((expectedSwapOut * 2n * 9_900n) / 10_000n, expectedSwapOut * 2n, POOL_PARAM),
            }),
        ).to.be.revertedWith("Too little received");

        await expect(manager.connect(operator).openLp(AERODROME, openParams)).to.emit(manager, "PositionOpened");
        const openedEvents = await manager.queryFilter(manager.filters.PositionOpened(safeAddress), -5);
        const opened = openedEvents[openedEvents.length - 1];
        const tokenId = opened.args.tokenId;
        const npm = new ethers.Contract(AERODROME_SLIPSTREAM_NPM_ADDRESS, NPM_ABI, ethers.provider);
        expect(await npm.ownerOf(tokenId)).to.equal(safeAddress);
        const initialBasis = await manager.residualBasisUsd6Of(AERODROME, tokenId);
        expect(initialBasis).to.be.greaterThan(0);

        await expect(
            manager.connect(operator).collectLp(AERODROME, {
                onBehalfOf: safeAddress,
                tokenId,
                swapFeesToUsdc: false,
                swap0: ZERO_LEG,
                swap1: ZERO_LEG,
                swapRewardToUsdc: false,
                rewardSwap: ZERO_LEG,
                slippageBps: 0,
                deadline,
            }),
        ).to.emit(manager, "FeesCollected");

        const wethToLp: bigint = opened.args.amount0ToLp;
        const usdcToLp: bigint = opened.args.amount1ToLp;
        // shareOfOriginalBps: fraction of the ORIGINAL position this close
        // removes, driving spot-price estimates of the swap and total output.
        const closeParams = (exitBps: number, shareOfOriginalBps: bigint) => {
            const wethShare = (wethToLp * shareOfOriginalBps) / 10_000n;
            const usdcShare = (usdcToLp * shareOfOriginalBps) / 10_000n;
            const expectedOut = spotWethToUsdc(wethShare);
            return {
                onBehalfOf: safeAddress,
                tokenId,
                exitBps,
                swap0: leg((expectedOut * 9_700n) / 10_000n, expectedOut, POOL_PARAM),
                swap1: ZERO_LEG,
                slippageBps: 300,
                decreaseAmount0Min: 0,
                decreaseAmount1Min: 0,
                deadline,
                minUsdcOut: ((usdcShare + expectedOut) * 9_500n) / 10_000n,
            };
        };

        await expect(manager.connect(operator).closeLp(AERODROME, closeParams(5_000, 5_000n))).to.emit(
            manager,
            "PositionClosed",
        );
        expect(await npm.ownerOf(tokenId)).to.equal(safeAddress);
        expect(await manager.residualBasisUsd6Of(AERODROME, tokenId)).to.be.lessThan(initialBasis);

        await expect(manager.connect(operator).closeLp(AERODROME, closeParams(10_000, 5_000n))).to.emit(
            manager,
            "PositionClosed",
        );
        expect(await manager.residualBasisUsd6Of(AERODROME, tokenId)).to.equal(0);
        await expect(npm.ownerOf(tokenId)).to.be.reverted;
        expect(await usdc.balanceOf(safeAddress)).to.be.greaterThan(0);
    });

    it("stakes the minted position into the real Voter's stakePool and unstakes it on close", async function () {
        const { operator, safeAddress, manager } = await deployAeroStack();
        const { poolAddress, sqrtPriceX96, alignedTick } = await readAeroPool();
        const spotUsdcToWeth = (amount: bigint) => (amount << 192n) / (sqrtPriceX96 * sqrtPriceX96);
        const spotWethToUsdc = (amount: bigint) => (amount * sqrtPriceX96 * sqrtPriceX96) >> 192n;

        const voter = new ethers.Contract(AERODROME_VOTER_ADDRESS, VOTER_ABI, ethers.provider);
        const stakePoolAddress: string = await voter.gauges(poolAddress);
        expect(stakePoolAddress).to.not.equal(ethers.ZeroAddress);

        const input = ethers.parseUnits("10", 6);
        const usdc = await fundSafeUsdc(poolAddress, safeAddress, input);

        const block = await ethers.provider.getBlock("latest");
        const deadline = BigInt(block!.timestamp + 3_600);
        const expectedSwapOut = spotUsdcToWeth(input / 2n);
        const openParams = {
            onBehalfOf: safeAddress,
            usdcAmount: input,
            tickLower: alignedTick - 1_000,
            tickUpper: alignedTick + 1_000,
            mintAmount0Min: 0,
            mintAmount1Min: 0,
            swap0: leg((expectedSwapOut * 9_900n) / 10_000n, expectedSwapOut, POOL_PARAM),
            swap1: ZERO_LEG,
            slippageBps: 100,
            deadline,
            lpPoolParam: POOL_PARAM,
            stake: true,
        };

        await expect(manager.connect(operator).openLp(AERODROME, openParams)).to.emit(manager, "PositionOpened");
        const openedEvents = await manager.queryFilter(manager.filters.PositionOpened(safeAddress), -5);
        const opened = openedEvents[openedEvents.length - 1];
        const tokenId = opened.args.tokenId;
        const npm = new ethers.Contract(AERODROME_SLIPSTREAM_NPM_ADDRESS, NPM_ABI, ethers.provider);

        // Staked: the stakePool, not the Safe, holds the NFT after open.
        expect(await npm.ownerOf(tokenId)).to.equal(stakePoolAddress);
        const initialBasis = await manager.residualBasisUsd6Of(AERODROME, tokenId);
        expect(initialBasis).to.be.greaterThan(0);

        const wethToLp: bigint = opened.args.amount0ToLp;
        const usdcToLp: bigint = opened.args.amount1ToLp;
        const expectedOut = spotWethToUsdc(wethToLp);
        const closeParams = {
            onBehalfOf: safeAddress,
            tokenId,
            exitBps: 10_000,
            swap0: leg((expectedOut * 9_700n) / 10_000n, expectedOut, POOL_PARAM),
            swap1: ZERO_LEG,
            slippageBps: 300,
            decreaseAmount0Min: 0,
            decreaseAmount1Min: 0,
            deadline,
            minUsdcOut: ((usdcToLp + expectedOut) * 9_500n) / 10_000n,
        };

        // The handler unstakes from the stakePool before running the normal close
        // flow, so a fully staked position closes exactly like an unstaked one.
        await expect(manager.connect(operator).closeLp(AERODROME, closeParams)).to.emit(manager, "PositionClosed");
        expect(await manager.residualBasisUsd6Of(AERODROME, tokenId)).to.equal(0);
        await expect(npm.ownerOf(tokenId)).to.be.reverted;
        expect(await usdc.balanceOf(safeAddress)).to.be.greaterThan(0);
        // A burned position keeps no staking pin.
        expect(await manager.stakePoolOf(AERODROME, tokenId)).to.equal(ethers.ZeroAddress);
    });

    // M-03: real emissions, real gauge. Every route that can pay a reward — an
    // explicit collect, the gauge withdrawal inside a partial close, and the one
    // inside a full close — must hand feeCollectBps of the CLAIMED amount to the
    // treasury. Gross is measured as (Safe delta + treasury delta) so the assertion
    // is exact regardless of how much accrued.
    it("charges the collect fee on real gauge emissions for collect, partial close, and full close", async function () {
        const { operator, treasury, safeAddress, manager } = await deployAeroStack();
        const { poolAddress, sqrtPriceX96, alignedTick } = await readAeroPool();
        const spotUsdcToWeth = (amount: bigint) => (amount << 192n) / (sqrtPriceX96 * sqrtPriceX96);
        const spotWethToUsdc = (amount: bigint) => (amount * sqrtPriceX96 * sqrtPriceX96) >> 192n;

        const voter = new ethers.Contract(AERODROME_VOTER_ADDRESS, VOTER_ABI, ethers.provider);
        const stakePoolAddress: string = await voter.gauges(poolAddress);
        expect(stakePoolAddress).to.not.equal(ethers.ZeroAddress);
        const stakePool = new ethers.Contract(
            stakePoolAddress,
            [
                "function rewardToken() view returns (address)",
                "function earned(address,uint256) view returns (uint256)",
                "function periodFinish() view returns (uint256)",
            ],
            ethers.provider,
        );
        const aero = new ethers.Contract(await stakePool.rewardToken(), ERC20_ABI, ethers.provider);

        const input = ethers.parseUnits("10", 6);
        await fundSafeUsdc(poolAddress, safeAddress, input);
        const block = await ethers.provider.getBlock("latest");
        const deadline = BigInt(block!.timestamp + 30 * 86_400);
        const expectedSwapOut = spotUsdcToWeth(input / 2n);

        await expect(
            manager.connect(operator).openLp(AERODROME, {
                onBehalfOf: safeAddress,
                usdcAmount: input,
                tickLower: alignedTick - 1_000,
                tickUpper: alignedTick + 1_000,
                mintAmount0Min: 0,
                mintAmount1Min: 0,
                swap0: leg((expectedSwapOut * 9_900n) / 10_000n, expectedSwapOut, POOL_PARAM),
                swap1: ZERO_LEG,
                slippageBps: 100,
                deadline,
                lpPoolParam: POOL_PARAM,
                stake: true,
            }),
        ).to.emit(manager, "PositionOpened");

        const openedEvents = await manager.queryFilter(manager.filters.PositionOpened(safeAddress), -5);
        const opened = openedEvents[openedEvents.length - 1];
        const tokenId = opened.args.tokenId;

        /// Run `action`, then assert the treasury took exactly feeCollectBps of
        /// everything the gauge newly paid out.
        async function expectRewardFeeCharged(action: () => Promise<any>) {
            const safeBefore: bigint = await aero.balanceOf(safeAddress);
            const treasuryBefore: bigint = await aero.balanceOf(treasury.address);
            await (await action()).wait();
            const treasuryDelta: bigint = (await aero.balanceOf(treasury.address)) - treasuryBefore;
            const claimed: bigint = (await aero.balanceOf(safeAddress)) - safeBefore + treasuryDelta;
            expect(claimed).to.be.greaterThan(0n);
            expect(treasuryDelta).to.equal((claimed * 250n) / 10_000n);
        }

        // Emissions only accrue until the gauge's current epoch ends, so the three
        // claims below share the time that is actually left rather than warping a
        // fixed span and silently claiming nothing after the period finishes.
        const nowTs = (await ethers.provider.getBlock("latest"))!.timestamp;
        const periodFinish = Number(await stakePool.periodFinish());
        expect(periodFinish).to.be.greaterThan(nowTs + 4);
        const warpStep = Math.floor((periodFinish - nowTs) / 4);
        const warp = async () => {
            await network.provider.send("evm_increaseTime", [warpStep]);
            await network.provider.send("evm_mine");
        };

        const npmOwner = new ethers.Contract(AERODROME_SLIPSTREAM_NPM_ADDRESS, NPM_ABI, ethers.provider);
        expect(await npmOwner.ownerOf(tokenId)).to.equal(stakePoolAddress);

        await warp();
        expect(await stakePool.earned(safeAddress, tokenId)).to.be.greaterThan(0n);
        await expectRewardFeeCharged(() =>
            manager.connect(operator).collectLp(AERODROME, {
                onBehalfOf: safeAddress,
                tokenId,
                swapFeesToUsdc: false,
                swap0: ZERO_LEG,
                swap1: ZERO_LEG,
                swapRewardToUsdc: false,
                rewardSwap: ZERO_LEG,
                slippageBps: 0,
                deadline,
            }),
        );

        // Partial close: the gauge pays out on withdrawal, so that claim is taxed too.
        await warp();
        const halfOut = spotWethToUsdc(opened.args.amount0ToLp / 2n);
        await expectRewardFeeCharged(() =>
            manager.connect(operator).closeLp(AERODROME, {
                onBehalfOf: safeAddress,
                tokenId,
                exitBps: 5_000,
                swap0: leg((halfOut * 9_700n) / 10_000n, halfOut, POOL_PARAM),
                swap1: ZERO_LEG,
                slippageBps: 300,
                decreaseAmount0Min: 0,
                decreaseAmount1Min: 0,
                deadline,
                minUsdcOut: 0,
            }),
        );

        // Still staked after the partial close, so it keeps accruing for the final exit.
        await warp();
        const restOut = spotWethToUsdc(opened.args.amount0ToLp / 2n);
        await expectRewardFeeCharged(() =>
            manager.connect(operator).closeLp(AERODROME, {
                onBehalfOf: safeAddress,
                tokenId,
                exitBps: 10_000,
                swap0: leg((restOut * 9_700n) / 10_000n, restOut, POOL_PARAM),
                swap1: ZERO_LEG,
                slippageBps: 300,
                decreaseAmount0Min: 0,
                decreaseAmount1Min: 0,
                deadline,
                minUsdcOut: 0,
            }),
        );
    });

    // L-01: the mock can prove the restake call happens; only the fork can prove the
    // REAL gauge takes the NFT back and keeps paying emissions on the survivor.
    it("restakes into the same real gauge after a partial close and keeps accruing emissions", async function () {
        const { operator, safeAddress, manager } = await deployAeroStack();
        const { poolAddress, sqrtPriceX96, alignedTick } = await readAeroPool();
        const spotUsdcToWeth = (amount: bigint) => (amount << 192n) / (sqrtPriceX96 * sqrtPriceX96);
        const spotWethToUsdc = (amount: bigint) => (amount * sqrtPriceX96 * sqrtPriceX96) >> 192n;

        const voter = new ethers.Contract(AERODROME_VOTER_ADDRESS, VOTER_ABI, ethers.provider);
        const stakePoolAddress: string = await voter.gauges(poolAddress);
        expect(stakePoolAddress).to.not.equal(ethers.ZeroAddress);

        const input = ethers.parseUnits("10", 6);
        await fundSafeUsdc(poolAddress, safeAddress, input);
        const block = await ethers.provider.getBlock("latest");
        const deadline = BigInt(block!.timestamp + 3_600);
        const expectedSwapOut = spotUsdcToWeth(input / 2n);

        await expect(
            manager.connect(operator).openLp(AERODROME, {
                onBehalfOf: safeAddress,
                usdcAmount: input,
                tickLower: alignedTick - 1_000,
                tickUpper: alignedTick + 1_000,
                mintAmount0Min: 0,
                mintAmount1Min: 0,
                swap0: leg((expectedSwapOut * 9_900n) / 10_000n, expectedSwapOut, POOL_PARAM),
                swap1: ZERO_LEG,
                slippageBps: 100,
                deadline,
                lpPoolParam: POOL_PARAM,
                stake: true,
            }),
        ).to.emit(manager, "PositionOpened");

        const openedEvents = await manager.queryFilter(manager.filters.PositionOpened(safeAddress), -5);
        const opened = openedEvents[openedEvents.length - 1];
        const tokenId = opened.args.tokenId;
        const npm = new ethers.Contract(AERODROME_SLIPSTREAM_NPM_ADDRESS, NPM_ABI, ethers.provider);
        const npmPositions = new ethers.Contract(
            AERODROME_SLIPSTREAM_NPM_ADDRESS,
            [
                "function positions(uint256) view returns (uint96,address,address,address,int24,int24,int24,uint128,uint256,uint256,uint128,uint128)",
            ],
            ethers.provider,
        );
        expect(await npm.ownerOf(tokenId)).to.equal(stakePoolAddress);
        expect(await manager.stakePoolOf(AERODROME, tokenId)).to.equal(stakePoolAddress);
        const liquidityBefore: bigint = (await npmPositions.positions(tokenId))[7];

        const halfWethOut = spotWethToUsdc(opened.args.amount0ToLp / 2n);
        await expect(
            manager.connect(operator).closeLp(AERODROME, {
                onBehalfOf: safeAddress,
                tokenId,
                exitBps: 5_000,
                swap0: leg((halfWethOut * 9_700n) / 10_000n, halfWethOut, POOL_PARAM),
                swap1: ZERO_LEG,
                slippageBps: 300,
                decreaseAmount0Min: 0,
                decreaseAmount1Min: 0,
                deadline,
                minUsdcOut: 0,
            }),
        ).to.emit(manager, "PositionClosed");

        // The survivor is back in the SAME gauge, with the pin still pointing there.
        expect(await npm.ownerOf(tokenId)).to.equal(stakePoolAddress);
        expect(await manager.stakePoolOf(AERODROME, tokenId)).to.equal(stakePoolAddress);
        const liquidityAfter: bigint = (await npmPositions.positions(tokenId))[7];
        expect(liquidityAfter).to.be.greaterThan(0n);
        expect(liquidityAfter).to.be.lessThan(liquidityBefore);

        // Emissions resume: only a staked NFT earns, so this would read zero if the
        // partial close had left the position on the Safe.
        await network.provider.send("evm_increaseTime", [5 * 86_400]);
        await network.provider.send("evm_mine");
        const stakePool = new ethers.Contract(
            stakePoolAddress,
            ["function earned(address,uint256) view returns (uint256)"],
            ethers.provider,
        );
        expect(await stakePool.earned(safeAddress, tokenId)).to.be.greaterThan(0n);
    });

    it("collectLp on a staked position claims stakePool rewards only and leaves the NFT staked", async function () {
        const { operator, safeAddress, manager } = await deployAeroStack();
        const { poolAddress, sqrtPriceX96, alignedTick } = await readAeroPool();
        const spotUsdcToWeth = (amount: bigint) => (amount << 192n) / (sqrtPriceX96 * sqrtPriceX96);

        const voter = new ethers.Contract(AERODROME_VOTER_ADDRESS, VOTER_ABI, ethers.provider);
        const stakePoolAddress: string = await voter.gauges(poolAddress);
        expect(stakePoolAddress).to.not.equal(ethers.ZeroAddress);

        const input = ethers.parseUnits("10", 6);
        const usdc = await fundSafeUsdc(poolAddress, safeAddress, input);
        const block = await ethers.provider.getBlock("latest");
        const deadline = BigInt(block!.timestamp + 3_600);
        const expectedSwapOut = spotUsdcToWeth(input / 2n);

        await expect(
            manager.connect(operator).openLp(AERODROME, {
                onBehalfOf: safeAddress,
                usdcAmount: input,
                tickLower: alignedTick - 1_000,
                tickUpper: alignedTick + 1_000,
                mintAmount0Min: 0,
                mintAmount1Min: 0,
                swap0: leg((expectedSwapOut * 9_900n) / 10_000n, expectedSwapOut, POOL_PARAM),
                swap1: ZERO_LEG,
                slippageBps: 100,
                deadline,
                lpPoolParam: POOL_PARAM,
                stake: true,
            }),
        ).to.emit(manager, "PositionOpened");

        const openedEvents = await manager.queryFilter(manager.filters.PositionOpened(safeAddress), -5);
        const tokenId = openedEvents[openedEvents.length - 1].args.tokenId;
        const npm = new ethers.Contract(AERODROME_SLIPSTREAM_NPM_ADDRESS, NPM_ABI, ethers.provider);
        expect(await npm.ownerOf(tokenId)).to.equal(stakePoolAddress);
        const basisBefore = await manager.residualBasisUsd6Of(AERODROME, tokenId);

        // collectLp on a STAKED position goes through the real stakePool with
        // getReward ONLY: staked liquidity earns AERO emissions instead of
        // trading fees, so there is nothing to collect and no FeesCollected —
        // and, the assertion a mock can't prove, the NFT never leaves the
        // stakePool so the position keeps earning emissions.
        await expect(
            manager.connect(operator).collectLp(AERODROME, {
                onBehalfOf: safeAddress,
                tokenId,
                swapFeesToUsdc: false,
                swap0: ZERO_LEG,
                swap1: ZERO_LEG,
                swapRewardToUsdc: false,
                rewardSwap: ZERO_LEG,
                slippageBps: 0,
                deadline,
            }),
        ).to.not.emit(manager, "FeesCollected");

        expect(await npm.ownerOf(tokenId)).to.equal(stakePoolAddress); // still staked
        expect(await manager.residualBasisUsd6Of(AERODROME, tokenId)).to.equal(basisBefore); // collect doesn't touch basis

        // Accrue real AERO emissions, then harvest again with swapRewardToUsdc:
        // the newly claimed AERO — and ONLY the claimed delta — is swapped to
        // USDC through the allowed live USDC/AERO CL pool.
        await network.provider.send("evm_increaseTime", [5 * 86_400]);
        await network.provider.send("evm_mine");

        const stakePool = new ethers.Contract(
            stakePoolAddress,
            [
                "function rewardToken() view returns (address)",
                "function earned(address,uint256) view returns (uint256)",
            ],
            ethers.provider,
        );
        const aeroAddr: string = await stakePool.rewardToken();
        const aero = new ethers.Contract(aeroAddr, ERC20_ABI, ethers.provider);
        const earned: bigint = await stakePool.earned(safeAddress, tokenId);
        expect(earned).to.be.greaterThan(0n);

        const AERO_PARAM = encodeAerodromePoolParam(USDC_ADDRESS, aeroAddr, AERO_TICK_SPACING);
        const factory = new ethers.Contract(AERODROME_CL_FACTORY_ADDRESS, FACTORY_ABI, ethers.provider);
        const aeroPoolAddress: string = await factory.getPool(USDC_ADDRESS, aeroAddr, AERO_TICK_SPACING);
        expect(aeroPoolAddress).to.not.equal(ethers.ZeroAddress);
        const aeroPool = new ethers.Contract(aeroPoolAddress, POOL_ABI, ethers.provider);
        const [aeroSqrtRaw] = await aeroPool.slot0();
        const aeroSqrt = BigInt(aeroSqrtRaw);
        // AERO is token1 of the USDC/AERO pool: USDC out = AERO in * 2^192 / sqrtP^2.
        const expectedUsdcOut = (earned << 192n) / (aeroSqrt * aeroSqrt);
        expect(expectedUsdcOut).to.be.greaterThan(0n);
        await (await manager.setPoolParamAllowed(AERODROME, AERO_PARAM, true)).wait();

        const warpBlock = await ethers.provider.getBlock("latest");
        const deadline2 = BigInt(warpBlock!.timestamp + 3_600);
        const safeAeroBefore: bigint = await aero.balanceOf(safeAddress);
        const safeUsdcBefore: bigint = await usdc.balanceOf(safeAddress);
        await expect(
            manager.connect(operator).collectLp(AERODROME, {
                onBehalfOf: safeAddress,
                tokenId,
                swapFeesToUsdc: false,
                swap0: ZERO_LEG,
                swap1: ZERO_LEG,
                swapRewardToUsdc: true,
                rewardSwap: leg((expectedUsdcOut * 9_700n) / 10_000n, expectedUsdcOut, AERO_PARAM),
                slippageBps: 300,
                deadline: deadline2,
            }),
        ).to.not.emit(manager, "FeesCollected");

        // Only the claimed delta was swapped: AERO from the earlier claim stays
        // on the Safe, and the USDC output cleared the slippage floor.
        expect(await aero.balanceOf(safeAddress)).to.equal(safeAeroBefore);
        expect((await usdc.balanceOf(safeAddress)) - safeUsdcBefore).to.be.greaterThanOrEqual(
            (expectedUsdcOut * 9_700n) / 10_000n,
        );
        expect(await npm.ownerOf(tokenId)).to.equal(stakePoolAddress);

        // A full close still works from the staked state (unstake → close).
        const wethToLp: bigint = openedEvents[openedEvents.length - 1].args.amount0ToLp;
        const usdcToLp: bigint = openedEvents[openedEvents.length - 1].args.amount1ToLp;
        const expectedOut = (wethToLp * sqrtPriceX96 * sqrtPriceX96) >> 192n;
        await expect(
            manager.connect(operator).closeLp(AERODROME, {
                onBehalfOf: safeAddress,
                tokenId,
                exitBps: 10_000,
                swap0: leg((expectedOut * 9_700n) / 10_000n, expectedOut, POOL_PARAM),
                swap1: ZERO_LEG,
                slippageBps: 300,
                decreaseAmount0Min: 0,
                decreaseAmount1Min: 0,
                deadline: deadline2,
                minUsdcOut: ((usdcToLp + expectedOut) * 9_500n) / 10_000n,
            }),
        ).to.emit(manager, "PositionClosed");
        await expect(npm.ownerOf(tokenId)).to.be.reverted;
        expect(await usdc.balanceOf(safeAddress)).to.be.greaterThan(0);
    });

    it("opens, collects, partially closes, and fully closes a USDC/AERO position (USDC as token0)", async function () {
        const { operator, safeAddress, manager, registry } = await deployAeroStack();
        await (await registry.setWhitelisted(AERO_ADDRESS, true)).wait();
        await (await manager.setPoolParamAllowed(AERODROME, AERO_POOL_PARAM, true)).wait();

        const factory = new ethers.Contract(AERODROME_CL_FACTORY_ADDRESS, FACTORY_ABI, ethers.provider);
        const aeroPoolAddress: string = await factory.getPool(USDC_ADDRESS, AERO_ADDRESS, AERO_LP_TICK_SPACING);
        expect(aeroPoolAddress).to.not.equal(ethers.ZeroAddress);
        const aeroPool = new ethers.Contract(aeroPoolAddress, POOL_ABI, ethers.provider);
        expect(await aeroPool.token0()).to.equal(USDC_ADDRESS);
        expect(await aeroPool.token1()).to.equal(ethers.getAddress(AERO_ADDRESS));
        const [sqrtPriceRaw, tick] = await aeroPool.slot0();
        const sqrtPriceX96 = BigInt(sqrtPriceRaw);
        const alignedTick = Math.floor(Number(tick) / AERO_LP_TICK_SPACING) * AERO_LP_TICK_SPACING;
        // token0 == USDC here, so the spot formulas flip vs the WETH/USDC tests.
        const spotUsdcToAero = (amount: bigint) => (amount * sqrtPriceX96 * sqrtPriceX96) >> 192n;
        const spotAeroToUsdc = (amount: bigint) => (amount << 192n) / (sqrtPriceX96 * sqrtPriceX96);

        const { poolAddress: wethUsdcPool } = await readAeroPool();
        const input = ethers.parseUnits("10", 6);
        const usdc = await fundSafeUsdc(wethUsdcPool, safeAddress, input);
        const aero = new ethers.Contract(AERO_ADDRESS, ERC20_ABI, ethers.provider);

        const block = await ethers.provider.getBlock("latest");
        const deadline = BigInt(block!.timestamp + 3_600);
        const expectedSwapOut = spotUsdcToAero(input / 2n);
        const openParams = {
            onBehalfOf: safeAddress,
            usdcAmount: input,
            tickLower: alignedTick - 1_000,
            tickUpper: alignedTick + 1_000,
            mintAmount0Min: 0,
            mintAmount1Min: 0,
            // USDC is token0: the funding half stays put, swap1 acquires AERO.
            swap0: ZERO_LEG,
            swap1: leg((expectedSwapOut * 9_700n) / 10_000n, expectedSwapOut, AERO_POOL_PARAM),
            slippageBps: 300,
            deadline,
            lpPoolParam: AERO_POOL_PARAM,
            stake: false,
        };

        await expect(manager.connect(operator).openLp(AERODROME, openParams)).to.emit(manager, "PositionOpened");
        const openedEvents = await manager.queryFilter(manager.filters.PositionOpened(safeAddress), -5);
        const opened = openedEvents[openedEvents.length - 1];
        const tokenId = opened.args.tokenId;
        const npm = new ethers.Contract(AERODROME_SLIPSTREAM_NPM_ADDRESS, NPM_ABI, ethers.provider);
        expect(await npm.ownerOf(tokenId)).to.equal(safeAddress);
        const initialBasis = await manager.residualBasisUsd6Of(AERODROME, tokenId);
        expect(initialBasis).to.be.greaterThan(0);
        // AERO the mint could not consume stays on the Safe as dust.
        const aeroDustAfterOpen: bigint = await aero.balanceOf(safeAddress);

        await expect(
            manager.connect(operator).collectLp(AERODROME, {
                onBehalfOf: safeAddress,
                tokenId,
                swapFeesToUsdc: false,
                swap0: ZERO_LEG,
                swap1: ZERO_LEG,
                swapRewardToUsdc: false,
                rewardSwap: ZERO_LEG,
                slippageBps: 0,
                deadline,
            }),
        ).to.emit(manager, "FeesCollected");

        const usdcToLp: bigint = opened.args.amount0ToLp;
        const aeroToLp: bigint = opened.args.amount1ToLp;
        const closeParams = (exitBps: number, shareOfOriginalBps: bigint) => {
            const usdcShare = (usdcToLp * shareOfOriginalBps) / 10_000n;
            const aeroShare = (aeroToLp * shareOfOriginalBps) / 10_000n;
            const expectedOut = spotAeroToUsdc(aeroShare);
            return {
                onBehalfOf: safeAddress,
                tokenId,
                exitBps,
                swap0: ZERO_LEG,
                swap1: leg((expectedOut * 9_700n) / 10_000n, expectedOut, AERO_POOL_PARAM),
                slippageBps: 300,
                decreaseAmount0Min: 0,
                decreaseAmount1Min: 0,
                deadline,
                minUsdcOut: ((usdcShare + expectedOut) * 9_500n) / 10_000n,
            };
        };

        await expect(manager.connect(operator).closeLp(AERODROME, closeParams(5_000, 5_000n))).to.emit(
            manager,
            "PositionClosed",
        );
        expect(await npm.ownerOf(tokenId)).to.equal(safeAddress);
        expect(await manager.residualBasisUsd6Of(AERODROME, tokenId)).to.be.lessThan(initialBasis);

        await expect(manager.connect(operator).closeLp(AERODROME, closeParams(10_000, 5_000n))).to.emit(
            manager,
            "PositionClosed",
        );
        expect(await manager.residualBasisUsd6Of(AERODROME, tokenId)).to.equal(0);
        await expect(npm.ownerOf(tokenId)).to.be.reverted;
        // Closes swap only the AERO they withdraw (delta-measured), so the
        // open-mint AERO dust is left untouched; realized USDC lands on the Safe.
        expect(await aero.balanceOf(safeAddress)).to.equal(aeroDustAfterOpen);
        expect(await usdc.balanceOf(safeAddress)).to.be.greaterThan(0);
    });

    it("skims feeCollectBps of real accrued fees to the treasury and swaps the rest to USDC", async function () {
        const { operator, treasury, safeAddress, manager } = await deployAeroStack();
        const { poolAddress, sqrtPriceX96, alignedTick } = await readAeroPool();
        const spotUsdcToWeth = (amount: bigint) => (amount << 192n) / (sqrtPriceX96 * sqrtPriceX96);

        const input = ethers.parseUnits("10000", 6);
        const usdc = await fundSafeUsdc(poolAddress, safeAddress, input);
        const weth = new ethers.Contract(WETH_ADDRESS, ERC20_ABI, ethers.provider);

        const block = await ethers.provider.getBlock("latest");
        const deadline = BigInt(block!.timestamp + 3_600);
        const expectedSwapOut = spotUsdcToWeth(input / 2n);
        // A narrow in-range position so the Safe's liquidity earns a
        // meaningful share of the wash-trade fees below.
        await expect(
            manager.connect(operator).openLp(AERODROME, {
                onBehalfOf: safeAddress,
                usdcAmount: input,
                tickLower: alignedTick - TICK_SPACING,
                tickUpper: alignedTick + 2 * TICK_SPACING,
                mintAmount0Min: 0,
                mintAmount1Min: 0,
                swap0: leg((expectedSwapOut * 9_700n) / 10_000n, expectedSwapOut, POOL_PARAM),
                swap1: ZERO_LEG,
                slippageBps: 300,
                deadline,
                lpPoolParam: POOL_PARAM,
                stake: false,
            }),
        ).to.emit(manager, "PositionOpened");
        const openedEvents = await manager.queryFilter(manager.filters.PositionOpened(safeAddress), -5);
        const tokenId = openedEvents[openedEvents.length - 1].args.tokenId;

        await accrueSwapFees(10, ethers.parseEther("5"));

        const safeWethBefore: bigint = await weth.balanceOf(safeAddress);
        const safeUsdcBefore: bigint = await usdc.balanceOf(safeAddress);
        const treasuryWethBefore: bigint = await weth.balanceOf(treasury.address);
        const treasuryUsdcBefore: bigint = await usdc.balanceOf(treasury.address);

        const collectBlock = await ethers.provider.getBlock("latest");
        // The collected fee amounts are unknowable up front, so the legs carry
        // nominal floors; the assertions below pin the exact skim instead.
        await expect(
            manager.connect(operator).collectLp(AERODROME, {
                onBehalfOf: safeAddress,
                tokenId,
                swapFeesToUsdc: true,
                swap0: leg(1n, 1n, POOL_PARAM),
                swap1: leg(1n, 1n, POOL_PARAM),
                swapRewardToUsdc: false,
                rewardSwap: ZERO_LEG,
                slippageBps: 300,
                deadline: BigInt(collectBlock!.timestamp + 3_600),
            }),
        ).to.emit(manager, "FeesCollected");

        const feeEvents = await manager.queryFilter(manager.filters.FeesCollected(safeAddress), -5);
        const collected = feeEvents[feeEvents.length - 1].args;
        expect(collected.collected0).to.be.greaterThan(0n);
        expect(collected.collected1).to.be.greaterThan(0n);
        expect(collected.fee0).to.equal((collected.collected0 * 250n) / 10_000n);
        expect(collected.fee1).to.equal((collected.collected1 * 250n) / 10_000n);

        // feeCollectBps is skimmed in kind before the swap-to-USDC leg runs.
        expect((await weth.balanceOf(treasury.address)) - treasuryWethBefore).to.equal(collected.fee0);
        expect((await usdc.balanceOf(treasury.address)) - treasuryUsdcBefore).to.equal(collected.fee1);
        // The Safe's WETH share was swapped away entirely; USDC grew by its
        // own fee share plus the swap output.
        expect(await weth.balanceOf(safeAddress)).to.equal(safeWethBefore);
        expect((await usdc.balanceOf(safeAddress)) - safeUsdcBefore).to.be.greaterThan(
            collected.collected1 - collected.fee1,
        );
    });

    // Runs against the USDC/AERO ts-200 pool: its 0.3% fee and moderate depth
    // let a narrow $10k position earn fees that clearly outrun the open/close
    // swap costs — the deep WETH/USDC pool dilutes the Safe's fee share so far
    // that no realistic wash volume produces a profit there.
    it("charges the performance fee on a profitable close", async function () {
        const { operator, treasury, safeAddress, manager, registry } = await deployAeroStack();
        await (await registry.setWhitelisted(AERO_ADDRESS, true)).wait();
        await (await manager.setPoolParamAllowed(AERODROME, AERO_POOL_PARAM, true)).wait();

        const factory = new ethers.Contract(AERODROME_CL_FACTORY_ADDRESS, FACTORY_ABI, ethers.provider);
        const aeroPoolAddress: string = await factory.getPool(USDC_ADDRESS, AERO_ADDRESS, AERO_LP_TICK_SPACING);
        const aeroPool = new ethers.Contract(aeroPoolAddress, POOL_ABI, ethers.provider);
        const [sqrtPriceRaw, tick] = await aeroPool.slot0();
        const sqrtPriceX96 = BigInt(sqrtPriceRaw);
        const alignedTick = Math.floor(Number(tick) / AERO_LP_TICK_SPACING) * AERO_LP_TICK_SPACING;
        const spotUsdcToAero = (amount: bigint) => (amount * sqrtPriceX96 * sqrtPriceX96) >> 192n;

        const { poolAddress: wethUsdcPool } = await readAeroPool();
        const input = ethers.parseUnits("10000", 6);
        const usdc = await fundSafeUsdc(wethUsdcPool, safeAddress, input);
        const aero = new ethers.Contract(AERO_ADDRESS, ERC20_ABI, ethers.provider);

        const block = await ethers.provider.getBlock("latest");
        const deadline = BigInt(block!.timestamp + 3_600);
        const expectedSwapOut = spotUsdcToAero(input / 2n);
        await expect(
            manager.connect(operator).openLp(AERODROME, {
                onBehalfOf: safeAddress,
                usdcAmount: input,
                tickLower: alignedTick - 2 * AERO_LP_TICK_SPACING,
                tickUpper: alignedTick + 3 * AERO_LP_TICK_SPACING,
                mintAmount0Min: 0,
                mintAmount1Min: 0,
                swap0: ZERO_LEG,
                swap1: leg((expectedSwapOut * 9_700n) / 10_000n, expectedSwapOut, AERO_POOL_PARAM),
                slippageBps: 300,
                deadline,
                lpPoolParam: AERO_POOL_PARAM,
                stake: false,
            }),
        ).to.emit(manager, "PositionOpened");
        const openedEvents = await manager.queryFilter(manager.filters.PositionOpened(safeAddress), -5);
        const opened = openedEvents[openedEvents.length - 1];
        const tokenId = opened.args.tokenId;
        const npm = new ethers.Contract(AERODROME_SLIPSTREAM_NPM_ADDRESS, NPM_ABI, ethers.provider);

        // Enough wash-trade volume that the position's fee income outruns the
        // open/close swap costs and realizes an actual profit over basis.
        await accrueAeroSwapFees(wethUsdcPool, 25, ethers.parseUnits("30000", 6));

        const safeUsdcBefore: bigint = await usdc.balanceOf(safeAddress);
        const treasuryAeroBefore: bigint = await aero.balanceOf(treasury.address);
        const treasuryUsdcBefore: bigint = await usdc.balanceOf(treasury.address);

        // Re-read the price after the wash trades for the close estimates.
        const [postSqrtRaw] = await aeroPool.slot0();
        const postSqrt = BigInt(postSqrtRaw);
        const spotAeroToUsdcPost = (amount: bigint) => (amount << 192n) / (postSqrt * postSqrt);
        const usdcToLp: bigint = opened.args.amount0ToLp;
        const aeroToLp: bigint = opened.args.amount1ToLp;
        const expectedOut = spotAeroToUsdcPost(aeroToLp);
        const closeBlock = await ethers.provider.getBlock("latest");
        await expect(
            manager.connect(operator).closeLp(AERODROME, {
                onBehalfOf: safeAddress,
                tokenId,
                exitBps: 10_000,
                swap0: ZERO_LEG,
                swap1: leg((expectedOut * 9_700n) / 10_000n, expectedOut, AERO_POOL_PARAM),
                slippageBps: 300,
                decreaseAmount0Min: 0,
                decreaseAmount1Min: 0,
                deadline: BigInt(closeBlock!.timestamp + 3_600),
                minUsdcOut: ((usdcToLp + expectedOut) * 9_500n) / 10_000n,
            }),
        ).to.emit(manager, "PositionClosed");

        const closedEvents = await manager.queryFilter(manager.filters.PositionClosed(safeAddress), -5);
        const closed = closedEvents[closedEvents.length - 1].args;
        expect(closed.currentValueUsd6).to.be.greaterThan(closed.basisUsd6);
        expect(closed.feeUsd6).to.be.greaterThan(0n);
        expect(closed.feeUsd6).to.equal(((closed.currentValueUsd6 - closed.basisUsd6) * 1_000n) / 10_000n);

        // The close harvests pending fees first (in-kind feeCollectBps skim —
        // token0 is USDC here, token1 is AERO), then pulls the USDC
        // performance fee: the treasury receives both.
        const feeEvents = await manager.queryFilter(manager.filters.FeesCollected(safeAddress), -5);
        const collected = feeEvents[feeEvents.length - 1].args;
        expect((await aero.balanceOf(treasury.address)) - treasuryAeroBefore).to.equal(collected.fee1);
        expect((await usdc.balanceOf(treasury.address)) - treasuryUsdcBefore).to.equal(collected.fee0 + closed.feeUsd6);

        // The Safe keeps the realized value net of the performance fee.
        expect((await usdc.balanceOf(safeAddress)) - safeUsdcBefore).to.equal(closed.currentValueUsd6 - closed.feeUsd6);
        expect(await manager.residualBasisUsd6Of(AERODROME, tokenId)).to.equal(0);
        await expect(npm.ownerOf(tokenId)).to.be.reverted;
    });
});
