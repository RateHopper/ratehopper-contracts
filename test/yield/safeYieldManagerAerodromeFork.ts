import { expect } from "chai";
import { ethers, network } from "hardhat";
import {
    AERODROME_CL_FACTORY_ADDRESS,
    AERODROME_SLIPSTREAM_NPM_ADDRESS,
    AERODROME_SLIPSTREAM_SWAP_ROUTER_ADDRESS,
    AERODROME_VOTER_ADDRESS,
    USDC_ADDRESS,
    WETH_ADDRESS,
} from "../../contractAddresses";
import { encodeAerodromePoolParam } from "../../contractAddresses";
import { ZERO_LEG, leg } from "../helpers/utils";

const AERODROME = 1;
const TICK_SPACING = 100;
const FORK_BLOCK = Number(process.env.BASE_FORK_BLOCK_NUMBER ?? 49_470_000);
const POOL_PARAM = encodeAerodromePoolParam(WETH_ADDRESS, USDC_ADDRESS, TICK_SPACING);

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

    const Safe = await ethers.getContractFactory("MockSafeHarness");
    const safe = await Safe.deploy();
    await safe.waitForDeployment();
    const safeAddress = await safe.getAddress();

    const Handler = await ethers.getContractFactory("AerodromeYieldHandler");
    const handler = await Handler.deploy(
        AERODROME_SLIPSTREAM_NPM_ADDRESS,
        USDC_ADDRESS,
        AERODROME_SLIPSTREAM_SWAP_ROUTER_ADDRESS,
        AERODROME_CL_FACTORY_ADDRESS,
        AERODROME_VOTER_ADDRESS,
    );
    await handler.waitForDeployment();

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
        admin.address,
        pauser.address,
    );
    await manager.waitForDeployment();

    return { operator, treasury, safeAddress, handler, manager };
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
            stakeInGauge: false,
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

    it("stakes the minted position into the real Voter's gauge and unstakes it on close", async function () {
        const { operator, safeAddress, manager } = await deployAeroStack();
        const { poolAddress, sqrtPriceX96, alignedTick } = await readAeroPool();
        const spotUsdcToWeth = (amount: bigint) => (amount << 192n) / (sqrtPriceX96 * sqrtPriceX96);
        const spotWethToUsdc = (amount: bigint) => (amount * sqrtPriceX96 * sqrtPriceX96) >> 192n;

        const voter = new ethers.Contract(AERODROME_VOTER_ADDRESS, VOTER_ABI, ethers.provider);
        const gaugeAddress: string = await voter.gauges(poolAddress);
        expect(gaugeAddress).to.not.equal(ethers.ZeroAddress);

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
            stakeInGauge: true,
        };

        await expect(manager.connect(operator).openLp(AERODROME, openParams)).to.emit(manager, "PositionOpened");
        const openedEvents = await manager.queryFilter(manager.filters.PositionOpened(safeAddress), -5);
        const opened = openedEvents[openedEvents.length - 1];
        const tokenId = opened.args.tokenId;
        const npm = new ethers.Contract(AERODROME_SLIPSTREAM_NPM_ADDRESS, NPM_ABI, ethers.provider);

        // Staked: the gauge, not the Safe, holds the NFT after open.
        expect(await npm.ownerOf(tokenId)).to.equal(gaugeAddress);
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

        // The handler unstakes from the gauge before running the normal close
        // flow, so a fully staked position closes exactly like an unstaked one.
        await expect(manager.connect(operator).closeLp(AERODROME, closeParams)).to.emit(manager, "PositionClosed");
        expect(await manager.residualBasisUsd6Of(AERODROME, tokenId)).to.equal(0);
        await expect(npm.ownerOf(tokenId)).to.be.reverted;
        expect(await usdc.balanceOf(safeAddress)).to.be.greaterThan(0);
    });
});
