import { expect } from "chai";
import { ethers, network } from "hardhat";
import {
    UNISWAP_V3_FACTORY_ADDRESS,
    UNISWAP_V3_NPM_ADDRESS,
    UNISWAP_V3_SWAP_ROUTER_ADDRESS,
    USDC_ADDRESS,
    WETH_ADDRESS,
    TWAP_REF_WETH_USDC_POOL,
    TWAP_WINDOW,
    TWAP_CARDINALITY,
} from "../../contractAddresses";
import { encodeUniV3PoolParam } from "../../contractAddresses";
import { ZERO_LEG, leg } from "../helpers/utils";
import { deployRealSafe, enableModuleOnSafe } from "../helpers/deployRealSafe";

const UNISWAP_V3 = 0;
const FEE_TIER = 500;
// Uniswap V3 tick spacing for the 0.05% fee tier.
const TICK_SPACING = 10;
const FORK_BLOCK = Number(process.env.BASE_FORK_BLOCK_NUMBER ?? 49_470_000);
const POOL_PARAM = encodeUniV3PoolParam(WETH_ADDRESS, USDC_ADDRESS, FEE_TIER);

const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address,uint256) returns (bool)",
];
const FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
const POOL_ABI = [
    "function token0() view returns (address)",
    "function token1() view returns (address)",
    "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
];
const NPM_ABI = ["function ownerOf(uint256) view returns (address)"];

describe("SafeYieldManager + Uniswap V3 - integration (Base fork)", function () {
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

    it("opens, collects, partially closes, and fully closes a real Uniswap V3 position", async function () {
        const [admin, operator, treasury, pauser] = await ethers.getSigners();

        const Registry = await ethers.getContractFactory("MockRegistry");
        const registry = await Registry.deploy();
        await registry.waitForDeployment();
        await (await registry.setOperator(operator.address)).wait();
        await (await registry.setWhitelisted(WETH_ADDRESS, true)).wait();
        await (await registry.setWhitelisted(USDC_ADDRESS, true)).wait();

        const safeAddress = await deployRealSafe(admin);

        const Handler = await ethers.getContractFactory("UniV3YieldHandler");
        const handler = await Handler.deploy(
            UNISWAP_V3_NPM_ADDRESS,
            USDC_ADDRESS,
            UNISWAP_V3_SWAP_ROUTER_ADDRESS,
            UNISWAP_V3_FACTORY_ADDRESS,
        );
        await handler.waitForDeployment();

        const Timelock = await ethers.getContractFactory("MockTimelockController");
        const timelock = await Timelock.deploy(1);
        await timelock.waitForDeployment();

        const Manager = await ethers.getContractFactory("SafeYieldManager");
        const manager = await Manager.deploy(
            await registry.getAddress(),
            USDC_ADDRESS,
            [UNISWAP_V3],
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
        // Price reference for the swap floor (H-01).
        await (
            await manager.setTwapConfig(WETH_ADDRESS, TWAP_REF_WETH_USDC_POOL, TWAP_WINDOW, TWAP_CARDINALITY)
        ).wait();

        await enableModuleOnSafe(safeAddress, admin, await manager.getAddress());

        const factory = new ethers.Contract(UNISWAP_V3_FACTORY_ADDRESS, FACTORY_ABI, ethers.provider);
        const poolAddress: string = await factory.getPool(WETH_ADDRESS, USDC_ADDRESS, FEE_TIER);
        expect(poolAddress).to.not.equal(ethers.ZeroAddress);

        const pool = new ethers.Contract(poolAddress, POOL_ABI, ethers.provider);
        expect(await pool.token0()).to.equal(WETH_ADDRESS);
        expect(await pool.token1()).to.equal(USDC_ADDRESS);
        const [sqrtPriceRaw, tick] = await pool.slot0();
        const sqrtPriceX96 = BigInt(sqrtPriceRaw);
        const alignedTick = Math.floor(Number(tick) / TICK_SPACING) * TICK_SPACING;
        const spotUsdcToWeth = (amount: bigint) => (amount << 192n) / (sqrtPriceX96 * sqrtPriceX96);
        const spotWethToUsdc = (amount: bigint) => (amount * sqrtPriceX96 * sqrtPriceX96) >> 192n;

        // The live pool is a convenient deterministic USDC holder on the
        // fork. Impersonation only mutates the disposable fork state.
        await network.provider.send("hardhat_setBalance", [poolAddress, "0x8AC7230489E80000"]);
        const poolSigner = await ethers.getImpersonatedSigner(poolAddress);
        const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, ethers.provider);
        const input = ethers.parseUnits("10", 6);
        await (await (usdc.connect(poolSigner) as any).transfer(safeAddress, input)).wait();
        await network.provider.send("hardhat_stopImpersonatingAccount", [poolAddress]);

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
            swap0: leg((expectedSwapOut * 9_900n) / 10_000n, POOL_PARAM),
            swap1: ZERO_LEG,
            slippageBps: 100,
            deadline,
            lpPoolParam: POOL_PARAM,
            stake: false,
        };

        await expect(
            manager.connect(operator).openLp(UNISWAP_V3, {
                ...openParams,
                swap0: leg((expectedSwapOut * 2n * 9_900n) / 10_000n, POOL_PARAM),
            }),
        ).to.be.revertedWith("Too little received");

        await expect(manager.connect(operator).openLp(UNISWAP_V3, openParams)).to.emit(manager, "PositionOpened");
        const openedEvents = await manager.queryFilter(manager.filters.PositionOpened(safeAddress), -5);
        const opened = openedEvents[openedEvents.length - 1];
        const tokenId = opened.args.tokenId;
        const npm = new ethers.Contract(UNISWAP_V3_NPM_ADDRESS, NPM_ABI, ethers.provider);
        expect(await npm.ownerOf(tokenId)).to.equal(safeAddress);
        const initialBasis = await manager.residualBasisUsd6Of(UNISWAP_V3, tokenId);
        expect(initialBasis).to.be.greaterThan(0);

        await expect(
            manager.connect(operator).collectLp(UNISWAP_V3, {
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
                swap0: {
                    amountOutMin: (expectedOut * 9_700n) / 10_000n,
                    poolParam: POOL_PARAM,
                },
                swap1: ZERO_LEG,
                slippageBps: 300,
                decreaseAmount0Min: 0,
                decreaseAmount1Min: 0,
                deadline,
                minUsdcOut: ((usdcShare + expectedOut) * 9_500n) / 10_000n,
            };
        };

        await expect(manager.connect(operator).closeLp(UNISWAP_V3, closeParams(5_000, 5_000n))).to.emit(
            manager,
            "PositionClosed",
        );
        expect(await npm.ownerOf(tokenId)).to.equal(safeAddress);
        expect(await manager.residualBasisUsd6Of(UNISWAP_V3, tokenId)).to.be.lessThan(initialBasis);

        await expect(manager.connect(operator).closeLp(UNISWAP_V3, closeParams(10_000, 5_000n))).to.emit(
            manager,
            "PositionClosed",
        );
        expect(await manager.residualBasisUsd6Of(UNISWAP_V3, tokenId)).to.equal(0);
        await expect(npm.ownerOf(tokenId)).to.be.reverted;
        expect(await usdc.balanceOf(safeAddress)).to.be.greaterThan(0);
    });
});
