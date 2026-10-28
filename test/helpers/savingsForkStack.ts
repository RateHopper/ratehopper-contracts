import { ethers, network } from "hardhat";
import { clearSnapshots, time } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import {
    CHAINLINK_SUSDS_USDS_FEED,
    OSERO_REFERRAL_CODE,
    SPARK_PSM3_ADDRESS,
    SPARK_SSR_ORACLE_ADDRESS,
    USDC_ADDRESS,
    WETH_ADDRESS,
    encodeSkySavingsPoolParam,
    sUSDS_ADDRESS,
} from "../../contractAddresses";
import { dealToken } from "./utils";
import { deployRealSafe, enableModuleOnSafe } from "./deployRealSafe";
import {
    COLLECT_FEE_BPS,
    MAX_DISAGREEMENT_BPS,
    MAX_EXPOSURE_BPS,
    MAX_FEE_BPS,
    MAX_FEED_AGE,
    MAX_RATE,
    MAX_TOLERANCE_BPS,
    PERF_FEE_BPS,
    SKY,
    USDC,
} from "./savingsHarness";

// ─────────────────────────────────────────────────────────────────────────
//  A fresh SafeYieldManager with the savings handler against the REAL Spark
//  PSM3, sUSDS, Chainlink sUSDS/USDS feed and SSR oracle on a Base fork,
//  shared by the fork integration suite and the recovery-script tests.
// ─────────────────────────────────────────────────────────────────────────

export const FORK_BLOCK = Number(process.env.BASE_FORK_BLOCK_NUMBER ?? 53_100_000);
export const USDC_ADDR = ethers.getAddress(USDC_ADDRESS);
export const SUSDS_ADDR = ethers.getAddress(sUSDS_ADDRESS);
export const PSM3_ADDR = ethers.getAddress(SPARK_PSM3_ADDRESS);
export const SKY_PARAM = encodeSkySavingsPoolParam(SPARK_PSM3_ADDRESS, sUSDS_ADDRESS);
export const AMOUNT = USDC(1_000);
export const FUNDING = USDC(10_000);
export const HOUR = 3_600;

const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
];
const PSM3_ABI = [
    "function pocket() view returns (address)",
    "function previewSwapExactIn(address,address,uint256) view returns (uint256)",
    "event Swap(address indexed assetIn, address indexed assetOut, address sender, address indexed receiver, uint256 amountIn, uint256 amountOut, uint256 referralCode)",
];
const FEED_ABI = [
    "function decimals() view returns (uint8)",
    "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
];
const SSR_ABI = ["function getConversionRate() view returns (uint256)"];

export const usdc = new ethers.Contract(USDC_ADDR, ERC20_ABI, ethers.provider);
export const susds = new ethers.Contract(SUSDS_ADDR, ERC20_ABI, ethers.provider);
export const psm3 = new ethers.Contract(PSM3_ADDR, PSM3_ABI, ethers.provider);
export const feed = new ethers.Contract(CHAINLINK_SUSDS_USDS_FEED, FEED_ABI, ethers.provider);
export const ssr = new ethers.Contract(SPARK_SSR_ORACLE_ADDRESS, SSR_ABI, ethers.provider);

export async function deployStack() {
    const [admin, operator, treasury, pauser, owner2] = await ethers.getSigners();

    const Provider = await ethers.getContractFactory("ChainlinkSsrRateProvider");
    const provider = await Provider.deploy(
        CHAINLINK_SUSDS_USDS_FEED,
        SPARK_SSR_ORACLE_ADDRESS,
        SUSDS_ADDR,
        MAX_FEED_AGE,
        MAX_DISAGREEMENT_BPS,
        MAX_RATE,
    );
    await provider.waitForDeployment();
    const providerAddr = await provider.getAddress();

    const Handler = await ethers.getContractFactory("SkySavingsYieldHandler");
    const deployBuild = async (exposureBps = MAX_EXPOSURE_BPS, rateProvider = providerAddr) => {
        const build = await Handler.deploy(
            USDC_ADDR,
            rateProvider,
            MAX_TOLERANCE_BPS,
            exposureBps,
            PSM3_ADDR,
            SUSDS_ADDR,
            OSERO_REFERRAL_CODE,
        );
        await build.waitForDeployment();
        return build;
    };
    const handler = await deployBuild();
    const handlerAddr = await handler.getAddress();
    // A build whose Chainlink input sits `offsetBps` away from the live SSR rate
    // (inside MAX_DISAGREEMENT_BPS, so the provider accepts it) over the REAL SSR
    // oracle: the only way to put the oracle floor on the wrong side of what PSM3 pays.
    const deployOffsetBuild = async (offsetBps: number) => {
        const ssrRate = (await ssr.getConversionRate()) / 10n ** 9n;
        const Feed = await ethers.getContractFactory("MockAggregatorV3");
        const offsetFeed = await Feed.deploy();
        await offsetFeed.waitForDeployment();
        await (await offsetFeed.set((ssrRate * BigInt(10_000 + offsetBps)) / 10_000n, await time.latest())).wait();
        const offsetProvider = await Provider.deploy(
            await offsetFeed.getAddress(),
            SPARK_SSR_ORACLE_ADDRESS,
            SUSDS_ADDR,
            MAX_FEED_AGE,
            MAX_DISAGREEMENT_BPS,
            MAX_RATE,
        );
        await offsetProvider.waitForDeployment();
        return deployBuild(MAX_EXPOSURE_BPS, await offsetProvider.getAddress());
    };

    const Registry = await ethers.getContractFactory("MockRegistry");
    const registry = await Registry.deploy();
    await registry.waitForDeployment();
    await (await registry.setOperator(operator.address)).wait();
    await (await registry.setWhitelisted(USDC_ADDR, true)).wait();

    const Timelock = await ethers.getContractFactory("MockTimelockController");
    const timelock = await Timelock.deploy(1);
    await timelock.waitForDeployment();

    const Manager = await ethers.getContractFactory("SafeYieldManager");
    const manager = await Manager.deploy(
        await registry.getAddress(),
        USDC_ADDR,
        WETH_ADDRESS,
        [SKY],
        [handlerAddr],
        [[SKY_PARAM]],
        [0],
        [0],
        [],
        treasury.address,
        Number(PERF_FEE_BPS),
        Number(COLLECT_FEE_BPS),
        MAX_FEE_BPS,
        admin.address,
        await timelock.getAddress(),
        pauser.address,
    );
    await manager.waitForDeployment();
    const managerAddr = await manager.getAddress();
    const managerEvents = await ethers.getContractAt("SkySavingsYieldHandler", managerAddr);

    const fundSafe = async (owner: HardhatEthersSigner) => {
        const safeAddr = await deployRealSafe(owner);
        await enableModuleOnSafe(safeAddr, owner, managerAddr);
        await dealToken(USDC_ADDR, safeAddr, FUNDING);
        return safeAddr;
    };
    const safeAddr = await fundSafe(admin);
    const safe2Addr = await fundSafe(owner2);

    return {
        admin,
        operator,
        treasury,
        pauser,
        provider,
        handler,
        handlerAddr,
        deployBuild,
        deployOffsetBuild,
        registry,
        timelock,
        manager,
        managerAddr,
        managerEvents,
        safeAddr,
        safe2Addr,
    };
}

export type Stack = Awaited<ReturnType<typeof deployStack>>;

/** Resets the fork to `blockNumber` and drops network-helpers' fixture snapshot registry
 *  (module-global), so a later file's loadFixture never reverts to an id from this node. */
export async function resetFork(blockNumber: number | undefined) {
    await network.provider.request({
        method: "hardhat_reset",
        params: [{ forking: { jsonRpcUrl: process.env.BASE_RPC_URL || "https://mainnet.base.org", blockNumber } }],
    });
    await clearSnapshots();
}
