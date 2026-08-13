import { expect } from "chai";
import { ethers, network } from "hardhat";
import {
    AERODROME_CL_FACTORY_ADDRESS,
    AERODROME_SLIPSTREAM_NPM_ADDRESS,
    AERODROME_SLIPSTREAM_SWAP_ROUTER_ADDRESS,
    AERODROME_VOTER_ADDRESS,
    PERMIT2_ADDRESS,
    UNISWAP_V3_FACTORY_ADDRESS,
    UNISWAP_V3_NPM_ADDRESS,
    UNISWAP_V3_SWAP_ROUTER_ADDRESS,
    UNISWAP_V4_POSITION_MANAGER_ADDRESS,
    UNISWAP_V4_STATE_VIEW_ADDRESS,
    UNIVERSAL_ROUTER_ADDRESS,
    USDC_ADDRESS,
    WETH_ADDRESS,
} from "../../contractAddresses";
import { encodeAerodromePoolParam, encodeUniV3PoolParam, encodeUniV4PoolParam } from "../../contractAddresses";
import { ZERO_LEG, leg } from "../helpers/utils";
import { deployRealSafe, enableModuleOnSafe } from "../helpers/deployRealSafe";

const UNISWAP_V3 = 0;
const AERODROME = 1;
const UNISWAP_V4 = 2;
const FEE_TIER = 500;
const FEE_TIER_3000 = 3_000;
const UNIV3_TICK_SPACING = 10;
const UNIV3_TICK_SPACING_3000 = 60;
const AERO_TICK_SPACING = 100;
const UNIV4_TICK_SPACING = 10;
const FORK_BLOCK = Number(process.env.BASE_FORK_BLOCK_NUMBER ?? 49_470_000);
const UNIV3_POOL_PARAM = encodeUniV3PoolParam(WETH_ADDRESS, USDC_ADDRESS, FEE_TIER);
const UNIV3_POOL_PARAM_3000 = encodeUniV3PoolParam(WETH_ADDRESS, USDC_ADDRESS, FEE_TIER_3000);
const AERO_POOL_PARAM = encodeAerodromePoolParam(WETH_ADDRESS, USDC_ADDRESS, AERO_TICK_SPACING);
// Native ETH/USDC — the deepest V4 pool on Base; currency0 == address(0).
const UNIV4_POOL_PARAM = encodeUniV4PoolParam(
    ethers.ZeroAddress,
    USDC_ADDRESS,
    FEE_TIER,
    UNIV4_TICK_SPACING,
    ethers.ZeroAddress,
);
const UNIV4_POOL_ID = ethers.keccak256(UNIV4_POOL_PARAM);

const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address,uint256) returns (bool)",
];
const UNIV3_FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
const AERO_FACTORY_ABI = ["function getPool(address,address,int24) view returns (address)"];
const UNIV3_POOL_ABI = ["function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)"];
const AERO_POOL_ABI = ["function slot0() view returns (uint160,int24,uint16,uint16,uint16,bool)"];
const NPM_ABI = ["function ownerOf(uint256) view returns (address)"];
const STATE_VIEW_ABI = ["function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)"];
const V4_PM_ABI = [
    "function ownerOf(uint256) view returns (address)",
    "function getPositionLiquidity(uint256) view returns (uint128)",
];

const spotUsdcToWeth = (amount: bigint, sqrtP: bigint) => (amount << 192n) / (sqrtP * sqrtP);
const spotWethToUsdc = (amount: bigint, sqrtP: bigint) => (amount * sqrtP * sqrtP) >> 192n;
const sqrtRatio = (tick: number) => BigInt(Math.floor(Math.sqrt(1.0001 ** tick) * 2 ** 96));
// Token amounts sitting in an in-range position of the given liquidity.
const inRangeAmounts = (liquidity: bigint, sqrtP: bigint, tickLower: number, tickUpper: number) => {
    const sqrtA = sqrtRatio(tickLower);
    const sqrtB = sqrtRatio(tickUpper);
    return {
        amount0: (liquidity * (sqrtB - sqrtP) * (1n << 96n)) / (sqrtP * sqrtB),
        amount1: (liquidity * (sqrtP - sqrtA)) >> 96n,
    };
};

async function deployStack(uniPoolParams: string[], aeroPoolParams: string[]) {
    const [admin, operator, treasury, pauser] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("MockRegistry");
    const registry = await Registry.deploy();
    await registry.waitForDeployment();
    await (await registry.setOperator(operator.address)).wait();
    await (await registry.setWhitelisted(WETH_ADDRESS, true)).wait();
    await (await registry.setWhitelisted(USDC_ADDRESS, true)).wait();

    const safeAddress = await deployRealSafe(admin);

    const UniHandler = await ethers.getContractFactory("UniV3YieldHandler");
    const uniHandler = await UniHandler.deploy(
        UNISWAP_V3_NPM_ADDRESS,
        USDC_ADDRESS,
        UNISWAP_V3_SWAP_ROUTER_ADDRESS,
        UNISWAP_V3_FACTORY_ADDRESS,
    );
    await uniHandler.waitForDeployment();

    const AeroHandler = await ethers.getContractFactory("AerodromeYieldHandler");
    const aeroHandler = await AeroHandler.deploy(
        AERODROME_SLIPSTREAM_NPM_ADDRESS,
        USDC_ADDRESS,
        AERODROME_SLIPSTREAM_SWAP_ROUTER_ADDRESS,
        AERODROME_CL_FACTORY_ADDRESS,
        AERODROME_VOTER_ADDRESS,
    );
    await aeroHandler.waitForDeployment();

    const V4Handler = await ethers.getContractFactory("UniV4YieldHandler");
    const v4Handler = await V4Handler.deploy(
        UNISWAP_V4_POSITION_MANAGER_ADDRESS,
        UNIVERSAL_ROUTER_ADDRESS,
        PERMIT2_ADDRESS,
        UNISWAP_V4_STATE_VIEW_ADDRESS,
        USDC_ADDRESS,
    );
    await v4Handler.waitForDeployment();

    const Timelock = await ethers.getContractFactory("MockTimelockController");
    const timelock = await Timelock.deploy(1);
    await timelock.waitForDeployment();

    const Manager = await ethers.getContractFactory("SafeYieldManager");
    const manager = await Manager.deploy(
        await registry.getAddress(),
        USDC_ADDRESS,
        [UNISWAP_V3, AERODROME, UNISWAP_V4],
        [await uniHandler.getAddress(), await aeroHandler.getAddress(), await v4Handler.getAddress()],
        [uniPoolParams, aeroPoolParams, [UNIV4_POOL_PARAM]],
        [0, 0, 0],
        [0, 0, 0],
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

    return { admin, operator, treasury, pauser, safeAddress, uniHandler, aeroHandler, v4Handler, manager };
}

async function readUniPool(feeTier: number) {
    const factory = new ethers.Contract(UNISWAP_V3_FACTORY_ADDRESS, UNIV3_FACTORY_ABI, ethers.provider);
    const poolAddress: string = await factory.getPool(WETH_ADDRESS, USDC_ADDRESS, feeTier);
    const pool = new ethers.Contract(poolAddress, UNIV3_POOL_ABI, ethers.provider);
    const [sqrtP, tick] = await pool.slot0();
    return { poolAddress, sqrtP: sqrtP as bigint, tick: Number(tick) };
}

async function readAeroPool() {
    const factory = new ethers.Contract(AERODROME_CL_FACTORY_ADDRESS, AERO_FACTORY_ABI, ethers.provider);
    const poolAddress: string = await factory.getPool(WETH_ADDRESS, USDC_ADDRESS, AERO_TICK_SPACING);
    const pool = new ethers.Contract(poolAddress, AERO_POOL_ABI, ethers.provider);
    const [sqrtP, tick] = await pool.slot0();
    return { poolAddress, sqrtP: sqrtP as bigint, tick: Number(tick) };
}

async function readV4Pool() {
    const stateView = new ethers.Contract(UNISWAP_V4_STATE_VIEW_ADDRESS, STATE_VIEW_ABI, ethers.provider);
    const [sqrtP, tick] = await stateView.getSlot0(UNIV4_POOL_ID);
    if (BigInt(sqrtP) === 0n) {
        throw new Error(
            `Uniswap V4 pool ${UNIV4_POOL_ID} is not initialized at fork block ${FORK_BLOCK}; refusing to skip the integration test`,
        );
    }
    return { sqrtP: sqrtP as bigint, tick: Number(tick) };
}

async function fundSafeUsdcFromPool(poolAddress: string, safeAddress: string, amount: bigint) {
    await network.provider.send("hardhat_setBalance", [poolAddress, "0x8AC7230489E80000"]);
    const poolSigner = await ethers.getImpersonatedSigner(poolAddress);
    const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, ethers.provider);
    await (await (usdc.connect(poolSigner) as any).transfer(safeAddress, amount)).wait();
    await network.provider.send("hardhat_stopImpersonatingAccount", [poolAddress]);
    return usdc;
}

describe("SafeYieldManager switchLp - integration (Base fork)", function () {
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

    it("moves real positions in both directions while carrying the basis", async function () {
        const { operator, treasury, safeAddress, uniHandler, aeroHandler, manager } = await deployStack(
            [UNIV3_POOL_PARAM],
            [AERO_POOL_PARAM],
        );

        const { poolAddress: uniPoolAddress, sqrtP: uniSqrtP, tick: uniTick } = await readUniPool(FEE_TIER);
        const uniAlignedTick = Math.floor(uniTick / UNIV3_TICK_SPACING) * UNIV3_TICK_SPACING;

        const aeroFactory = new ethers.Contract(AERODROME_CL_FACTORY_ADDRESS, AERO_FACTORY_ABI, ethers.provider);
        const aeroPoolAddress: string = await aeroFactory.getPool(WETH_ADDRESS, USDC_ADDRESS, AERO_TICK_SPACING);
        const aeroPool = new ethers.Contract(aeroPoolAddress, AERO_POOL_ABI, ethers.provider);
        const [aeroSqrtP, aeroTick] = await aeroPool.slot0();
        const aeroAlignedTick = Math.floor(Number(aeroTick) / AERO_TICK_SPACING) * AERO_TICK_SPACING;

        const input = ethers.parseUnits("10", 6);
        const usdc = await fundSafeUsdcFromPool(uniPoolAddress, safeAddress, input);

        const block = await ethers.provider.getBlock("latest");
        const deadline = BigInt(block!.timestamp + 3_600);
        const openExpectedOut = spotUsdcToWeth(input / 2n, uniSqrtP);
        await (
            await manager.connect(operator).openLp(UNISWAP_V3, {
                onBehalfOf: safeAddress,
                usdcAmount: input,
                tickLower: uniAlignedTick - 1_000,
                tickUpper: uniAlignedTick + 1_000,
                mintAmount0Min: 0,
                mintAmount1Min: 0,
                swap0: leg((openExpectedOut * 9_900n) / 10_000n, openExpectedOut, UNIV3_POOL_PARAM),
                swap1: ZERO_LEG,
                slippageBps: 100,
                deadline,
                lpPoolParam: UNIV3_POOL_PARAM,
                stake: false,
            })
        ).wait();

        const openedEvents = await manager.queryFilter(manager.filters.PositionOpened(safeAddress), -5);
        const opened = openedEvents[openedEvents.length - 1];
        const oldTokenId = opened.args.tokenId;
        const initialBasis = await manager.residualBasisUsd6Of(UNISWAP_V3, oldTokenId);
        expect(initialBasis).to.be.greaterThan(0);

        // Close-leg estimates from the amounts that actually entered the LP;
        // the open leg redeploys the realized USDC, estimated the same way.
        const wethToLp: bigint = opened.args.amount0ToLp;
        const usdcToLp: bigint = opened.args.amount1ToLp;
        const closeExpectedOut = spotWethToUsdc(wethToLp, uniSqrtP);
        const realizedEstimate = usdcToLp + closeExpectedOut;
        const switchOpenExpectedOut = spotUsdcToWeth(realizedEstimate / 2n, aeroSqrtP);

        await expect(
            manager.connect(operator).switchLp(UNISWAP_V3, AERODROME, {
                onBehalfOf: safeAddress,
                tokenId: oldTokenId,
                closeSwap0: leg((closeExpectedOut * 9_700n) / 10_000n, closeExpectedOut, UNIV3_POOL_PARAM),
                closeSwap1: ZERO_LEG,
                closeSlippageBps: 300,
                decreaseAmount0Min: 0,
                decreaseAmount1Min: 0,
                minUsdcOut: (realizedEstimate * 9_500n) / 10_000n,
                tickLower: aeroAlignedTick - 1_000,
                tickUpper: aeroAlignedTick + 1_000,
                mintAmount0Min: 0,
                mintAmount1Min: 0,
                openSwap0: leg((switchOpenExpectedOut * 9_700n) / 10_000n, switchOpenExpectedOut, AERO_POOL_PARAM),
                openSwap1: ZERO_LEG,
                openSlippageBps: 300,
                lpPoolParam: AERO_POOL_PARAM,
                deadline,
            }),
        ).to.emit(manager, "PositionSwitched");

        const switchedEvents = await manager.queryFilter(manager.filters.PositionSwitched(safeAddress), -5);
        const switched = switchedEvents[switchedEvents.length - 1];
        const newTokenId = switched.args.newTokenId;
        expect(switched.args.oldBasisUsd6).to.equal(initialBasis);
        // Value left outside the new LP (mint leftovers) is returned as basis
        // first, so the carried basis shrinks by exactly the undeployed value.
        const undeployed: bigint = switched.args.realizedUsd6 - switched.args.deployedUsd6;
        const carriedBasis: bigint = switched.args.carriedBasisUsd6;
        expect(carriedBasis).to.equal(initialBasis - undeployed);
        expect(carriedBasis).to.be.greaterThan(0);

        const uniNpm = new ethers.Contract(UNISWAP_V3_NPM_ADDRESS, NPM_ABI, ethers.provider);
        const aeroNpm = new ethers.Contract(AERODROME_SLIPSTREAM_NPM_ADDRESS, NPM_ABI, ethers.provider);
        await expect(uniNpm.ownerOf(oldTokenId)).to.be.reverted;
        expect(await aeroNpm.ownerOf(newTokenId)).to.equal(safeAddress);

        expect(await manager.residualBasisUsd6Of(UNISWAP_V3, oldTokenId)).to.equal(0);
        expect(await manager.residualBasisUsd6Of(AERODROME, newTokenId)).to.equal(carriedBasis);
        expect(await manager.positionHandlerOf(AERODROME, newTokenId)).to.equal(await aeroHandler.getAddress());
        expect(await usdc.balanceOf(treasury.address)).to.equal(0);

        // Estimate the new position's WETH leg from its actual liquidity:
        // amount0 = L * (sqrtB - sqrtP) * Q96 / (sqrtP * sqrtB) for an
        // in-range position.
        const aeroNpmPositions = new ethers.Contract(
            AERODROME_SLIPSTREAM_NPM_ADDRESS,
            [
                "function positions(uint256) view returns (uint96,address,address,address,int24,int24,int24,uint128,uint256,uint256,uint128,uint128)",
            ],
            ethers.provider,
        );
        const position = await aeroNpmPositions.positions(newTokenId);
        const newLiquidity: bigint = position[7];
        const sqrtB = sqrtRatio(aeroAlignedTick + 1_000);
        const wethInPosition = (newLiquidity * (sqrtB - aeroSqrtP) * (1n << 96n)) / (aeroSqrtP * sqrtB);
        const closeFinalExpectedOut = spotWethToUsdc(wethInPosition, aeroSqrtP);
        await expect(
            manager.connect(operator).closeLp(AERODROME, {
                onBehalfOf: safeAddress,
                tokenId: newTokenId,
                exitBps: 10_000,
                swap0: leg((closeFinalExpectedOut * 9_700n) / 10_000n, closeFinalExpectedOut, AERO_POOL_PARAM),
                swap1: ZERO_LEG,
                slippageBps: 300,
                decreaseAmount0Min: 0,
                decreaseAmount1Min: 0,
                deadline,
                minUsdcOut: 0,
            }),
        ).to.emit(manager, "PositionClosed");
        expect(await manager.residualBasisUsd6Of(AERODROME, newTokenId)).to.equal(0);
        expect(await usdc.balanceOf(safeAddress)).to.be.greaterThan(0);

        // Exercise the opposite handler composition as well: Aerodrome close
        // followed by Uniswap V3 open.
        const reverseInput = ethers.parseUnits("5", 6);
        const reverseOpenExpectedOut = spotUsdcToWeth(reverseInput / 2n, aeroSqrtP);
        await (
            await manager.connect(operator).openLp(AERODROME, {
                onBehalfOf: safeAddress,
                usdcAmount: reverseInput,
                tickLower: aeroAlignedTick - 1_000,
                tickUpper: aeroAlignedTick + 1_000,
                mintAmount0Min: 0,
                mintAmount1Min: 0,
                swap0: leg((reverseOpenExpectedOut * 9_900n) / 10_000n, reverseOpenExpectedOut, AERO_POOL_PARAM),
                swap1: ZERO_LEG,
                slippageBps: 100,
                deadline,
                lpPoolParam: AERO_POOL_PARAM,
                stake: false,
            })
        ).wait();

        const reverseOpenedEvents = await manager.queryFilter(manager.filters.PositionOpened(safeAddress), -5);
        const reverseOpened = reverseOpenedEvents[reverseOpenedEvents.length - 1];
        const reverseOldTokenId = reverseOpened.args.tokenId;
        const reverseInitialBasis = await manager.residualBasisUsd6Of(AERODROME, reverseOldTokenId);
        const reverseCloseExpectedOut = spotWethToUsdc(reverseOpened.args.amount0ToLp, aeroSqrtP);
        const reverseRealizedEstimate = reverseOpened.args.amount1ToLp + reverseCloseExpectedOut;
        const reverseSwitchOpenExpectedOut = spotUsdcToWeth(reverseRealizedEstimate / 2n, uniSqrtP);

        await expect(
            manager.connect(operator).switchLp(AERODROME, UNISWAP_V3, {
                onBehalfOf: safeAddress,
                tokenId: reverseOldTokenId,
                closeSwap0: leg((reverseCloseExpectedOut * 9_700n) / 10_000n, reverseCloseExpectedOut, AERO_POOL_PARAM),
                closeSwap1: ZERO_LEG,
                closeSlippageBps: 300,
                decreaseAmount0Min: 0,
                decreaseAmount1Min: 0,
                minUsdcOut: (reverseRealizedEstimate * 9_500n) / 10_000n,
                tickLower: uniAlignedTick - 1_000,
                tickUpper: uniAlignedTick + 1_000,
                mintAmount0Min: 0,
                mintAmount1Min: 0,
                openSwap0: leg(
                    (reverseSwitchOpenExpectedOut * 9_700n) / 10_000n,
                    reverseSwitchOpenExpectedOut,
                    UNIV3_POOL_PARAM,
                ),
                openSwap1: ZERO_LEG,
                openSlippageBps: 300,
                lpPoolParam: UNIV3_POOL_PARAM,
                deadline,
            }),
        ).to.emit(manager, "PositionSwitched");

        const reverseSwitchedEvents = await manager.queryFilter(manager.filters.PositionSwitched(safeAddress), -5);
        const reverseSwitched = reverseSwitchedEvents[reverseSwitchedEvents.length - 1];
        const reverseNewTokenId = reverseSwitched.args.newTokenId;
        expect(reverseSwitched.args.oldBasisUsd6).to.equal(reverseInitialBasis);
        const reverseUndeployed: bigint = reverseSwitched.args.realizedUsd6 - reverseSwitched.args.deployedUsd6;
        expect(reverseSwitched.args.carriedBasisUsd6).to.equal(reverseInitialBasis - reverseUndeployed);
        await expect(aeroNpm.ownerOf(reverseOldTokenId)).to.be.reverted;
        expect(await uniNpm.ownerOf(reverseNewTokenId)).to.equal(safeAddress);
        expect(await manager.residualBasisUsd6Of(AERODROME, reverseOldTokenId)).to.equal(0);
        expect(await manager.residualBasisUsd6Of(UNISWAP_V3, reverseNewTokenId)).to.equal(
            reverseSwitched.args.carriedBasisUsd6,
        );
        expect(await manager.positionHandlerOf(UNISWAP_V3, reverseNewTokenId)).to.equal(await uniHandler.getAddress());
    });

    it("switches between Uniswap V3 fee tiers (0.3% -> 0.05%) carrying the basis", async function () {
        const { operator, treasury, safeAddress, uniHandler, manager } = await deployStack(
            [UNIV3_POOL_PARAM_3000, UNIV3_POOL_PARAM],
            [AERO_POOL_PARAM],
        );

        const from = await readUniPool(FEE_TIER_3000);
        const to = await readUniPool(FEE_TIER);
        const fromAlignedTick = Math.floor(from.tick / UNIV3_TICK_SPACING_3000) * UNIV3_TICK_SPACING_3000;
        const toAlignedTick = Math.floor(to.tick / UNIV3_TICK_SPACING) * UNIV3_TICK_SPACING;

        const input = ethers.parseUnits("10", 6);
        const usdc = await fundSafeUsdcFromPool(to.poolAddress, safeAddress, input);

        const block = await ethers.provider.getBlock("latest");
        const deadline = BigInt(block!.timestamp + 3_600);
        const openExpectedOut = spotUsdcToWeth(input / 2n, from.sqrtP);
        await (
            await manager.connect(operator).openLp(UNISWAP_V3, {
                onBehalfOf: safeAddress,
                usdcAmount: input,
                tickLower: fromAlignedTick - 1_020,
                tickUpper: fromAlignedTick + 1_020,
                mintAmount0Min: 0,
                mintAmount1Min: 0,
                swap0: leg((openExpectedOut * 9_700n) / 10_000n, openExpectedOut, UNIV3_POOL_PARAM_3000),
                swap1: ZERO_LEG,
                slippageBps: 300,
                deadline,
                lpPoolParam: UNIV3_POOL_PARAM_3000,
                stake: false,
            })
        ).wait();

        const openedEvents = await manager.queryFilter(manager.filters.PositionOpened(safeAddress), -5);
        const opened = openedEvents[openedEvents.length - 1];
        const oldTokenId = opened.args.tokenId;
        const initialBasis = await manager.residualBasisUsd6Of(UNISWAP_V3, oldTokenId);
        expect(initialBasis).to.be.greaterThan(0);

        // Close leg swaps back through the 0.3% pool it sits in; the open leg
        // redeploys the realized USDC into the 0.05% pool.
        const closeExpectedOut = spotWethToUsdc(opened.args.amount0ToLp, from.sqrtP);
        const realizedEstimate = opened.args.amount1ToLp + closeExpectedOut;
        const switchOpenExpectedOut = spotUsdcToWeth(realizedEstimate / 2n, to.sqrtP);

        await expect(
            manager.connect(operator).switchLp(UNISWAP_V3, UNISWAP_V3, {
                onBehalfOf: safeAddress,
                tokenId: oldTokenId,
                closeSwap0: leg((closeExpectedOut * 9_700n) / 10_000n, closeExpectedOut, UNIV3_POOL_PARAM_3000),
                closeSwap1: ZERO_LEG,
                closeSlippageBps: 300,
                decreaseAmount0Min: 0,
                decreaseAmount1Min: 0,
                minUsdcOut: (realizedEstimate * 9_500n) / 10_000n,
                tickLower: toAlignedTick - 1_000,
                tickUpper: toAlignedTick + 1_000,
                mintAmount0Min: 0,
                mintAmount1Min: 0,
                openSwap0: leg((switchOpenExpectedOut * 9_700n) / 10_000n, switchOpenExpectedOut, UNIV3_POOL_PARAM),
                openSwap1: ZERO_LEG,
                openSlippageBps: 300,
                lpPoolParam: UNIV3_POOL_PARAM,
                deadline,
            }),
        ).to.emit(manager, "PositionSwitched");

        const switchedEvents = await manager.queryFilter(manager.filters.PositionSwitched(safeAddress), -5);
        const switched = switchedEvents[switchedEvents.length - 1];
        const newTokenId = switched.args.newTokenId;
        expect(newTokenId).to.not.equal(oldTokenId);
        expect(switched.args.fromProtocol).to.equal(UNISWAP_V3);
        expect(switched.args.toProtocol).to.equal(UNISWAP_V3);
        expect(switched.args.oldBasisUsd6).to.equal(initialBasis);
        const undeployed: bigint = switched.args.realizedUsd6 - switched.args.deployedUsd6;
        const carriedBasis: bigint = switched.args.carriedBasisUsd6;
        expect(carriedBasis).to.equal(initialBasis - undeployed);
        expect(carriedBasis).to.be.greaterThan(0);

        const uniNpm = new ethers.Contract(UNISWAP_V3_NPM_ADDRESS, NPM_ABI, ethers.provider);
        await expect(uniNpm.ownerOf(oldTokenId)).to.be.reverted;
        expect(await uniNpm.ownerOf(newTokenId)).to.equal(safeAddress);

        const uniNpmPositions = new ethers.Contract(
            UNISWAP_V3_NPM_ADDRESS,
            [
                "function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)",
            ],
            ethers.provider,
        );
        const position = await uniNpmPositions.positions(newTokenId);
        expect(position[4]).to.equal(FEE_TIER);

        expect(await manager.residualBasisUsd6Of(UNISWAP_V3, oldTokenId)).to.equal(0);
        expect(await manager.residualBasisUsd6Of(UNISWAP_V3, newTokenId)).to.equal(carriedBasis);
        expect(await manager.positionHandlerOf(UNISWAP_V3, newTokenId)).to.equal(await uniHandler.getAddress());
        expect(await usdc.balanceOf(treasury.address)).to.equal(0);
    });

    it("moves real positions between Uniswap V3 and Uniswap V4 in both directions carrying the basis", async function () {
        const { operator, treasury, safeAddress, uniHandler, v4Handler, manager } = await deployStack(
            [UNIV3_POOL_PARAM],
            [AERO_POOL_PARAM],
        );

        const { poolAddress: uniPoolAddress, sqrtP: uniSqrtP, tick: uniTick } = await readUniPool(FEE_TIER);
        const uniAlignedTick = Math.floor(uniTick / UNIV3_TICK_SPACING) * UNIV3_TICK_SPACING;
        const { sqrtP: v4SqrtP, tick: v4Tick } = await readV4Pool();
        const v4AlignedTick = Math.floor(v4Tick / UNIV4_TICK_SPACING) * UNIV4_TICK_SPACING;

        const input = ethers.parseUnits("10", 6);
        const usdc = await fundSafeUsdcFromPool(uniPoolAddress, safeAddress, input);

        const block = await ethers.provider.getBlock("latest");
        const deadline = BigInt(block!.timestamp + 3_600);
        const openExpectedOut = spotUsdcToWeth(input / 2n, uniSqrtP);
        await (
            await manager.connect(operator).openLp(UNISWAP_V3, {
                onBehalfOf: safeAddress,
                usdcAmount: input,
                tickLower: uniAlignedTick - 1_000,
                tickUpper: uniAlignedTick + 1_000,
                mintAmount0Min: 0,
                mintAmount1Min: 0,
                swap0: leg((openExpectedOut * 9_900n) / 10_000n, openExpectedOut, UNIV3_POOL_PARAM),
                swap1: ZERO_LEG,
                slippageBps: 100,
                deadline,
                lpPoolParam: UNIV3_POOL_PARAM,
                stake: false,
            })
        ).wait();

        const openedEvents = await manager.queryFilter(manager.filters.PositionOpened(safeAddress), -5);
        const opened = openedEvents[openedEvents.length - 1];
        const oldTokenId = opened.args.tokenId;
        const initialBasis = await manager.residualBasisUsd6Of(UNISWAP_V3, oldTokenId);
        expect(initialBasis).to.be.greaterThan(0);

        // The close leg swaps WETH back through the V3 pool; the open leg
        // redeploys the realized USDC into the native ETH/USDC V4 pool.
        const closeExpectedOut = spotWethToUsdc(opened.args.amount0ToLp, uniSqrtP);
        const realizedEstimate = opened.args.amount1ToLp + closeExpectedOut;
        const switchOpenExpectedOut = spotUsdcToWeth(realizedEstimate / 2n, v4SqrtP);

        await expect(
            manager.connect(operator).switchLp(UNISWAP_V3, UNISWAP_V4, {
                onBehalfOf: safeAddress,
                tokenId: oldTokenId,
                closeSwap0: leg((closeExpectedOut * 9_700n) / 10_000n, closeExpectedOut, UNIV3_POOL_PARAM),
                closeSwap1: ZERO_LEG,
                closeSlippageBps: 300,
                decreaseAmount0Min: 0,
                decreaseAmount1Min: 0,
                minUsdcOut: (realizedEstimate * 9_500n) / 10_000n,
                tickLower: v4AlignedTick - 1_000,
                tickUpper: v4AlignedTick + 1_000,
                mintAmount0Min: 0,
                mintAmount1Min: 0,
                openSwap0: leg((switchOpenExpectedOut * 9_700n) / 10_000n, switchOpenExpectedOut, UNIV4_POOL_PARAM),
                openSwap1: ZERO_LEG,
                openSlippageBps: 300,
                lpPoolParam: UNIV4_POOL_PARAM,
                deadline,
            }),
        ).to.emit(manager, "PositionSwitched");

        const switchedEvents = await manager.queryFilter(manager.filters.PositionSwitched(safeAddress), -5);
        const switched = switchedEvents[switchedEvents.length - 1];
        const v4TokenId = switched.args.newTokenId;
        expect(switched.args.oldBasisUsd6).to.equal(initialBasis);
        const undeployed: bigint = switched.args.realizedUsd6 - switched.args.deployedUsd6;
        const carriedBasis: bigint = switched.args.carriedBasisUsd6;
        expect(carriedBasis).to.equal(initialBasis - undeployed);
        expect(carriedBasis).to.be.greaterThan(0);

        const uniNpm = new ethers.Contract(UNISWAP_V3_NPM_ADDRESS, NPM_ABI, ethers.provider);
        const v4Pm = new ethers.Contract(UNISWAP_V4_POSITION_MANAGER_ADDRESS, V4_PM_ABI, ethers.provider);
        await expect(uniNpm.ownerOf(oldTokenId)).to.be.reverted;
        expect(await v4Pm.ownerOf(v4TokenId)).to.equal(safeAddress);
        expect(await v4Pm.getPositionLiquidity(v4TokenId)).to.be.greaterThan(0);
        expect(await manager.residualBasisUsd6Of(UNISWAP_V3, oldTokenId)).to.equal(0);
        expect(await manager.residualBasisUsd6Of(UNISWAP_V4, v4TokenId)).to.equal(carriedBasis);
        expect(await manager.positionHandlerOf(UNISWAP_V4, v4TokenId)).to.equal(await v4Handler.getAddress());
        expect(await usdc.balanceOf(treasury.address)).to.equal(0);

        // Back leg: estimate the V4 position's composition from its actual
        // liquidity, then close it through the V4 pool and reopen on V3.
        const v4Liquidity: bigint = await v4Pm.getPositionLiquidity(v4TokenId);
        const { amount0: ethInPosition, amount1: usdcInPosition } = inRangeAmounts(
            v4Liquidity,
            v4SqrtP,
            v4AlignedTick - 1_000,
            v4AlignedTick + 1_000,
        );
        const backCloseExpectedOut = spotWethToUsdc(ethInPosition, v4SqrtP);
        const backRealizedEstimate = usdcInPosition + backCloseExpectedOut;
        const backOpenExpectedOut = spotUsdcToWeth(backRealizedEstimate / 2n, uniSqrtP);

        await expect(
            manager.connect(operator).switchLp(UNISWAP_V4, UNISWAP_V3, {
                onBehalfOf: safeAddress,
                tokenId: v4TokenId,
                closeSwap0: leg((backCloseExpectedOut * 9_700n) / 10_000n, backCloseExpectedOut, UNIV4_POOL_PARAM),
                closeSwap1: ZERO_LEG,
                closeSlippageBps: 300,
                decreaseAmount0Min: 0,
                decreaseAmount1Min: 0,
                minUsdcOut: (backRealizedEstimate * 9_500n) / 10_000n,
                tickLower: uniAlignedTick - 1_000,
                tickUpper: uniAlignedTick + 1_000,
                mintAmount0Min: 0,
                mintAmount1Min: 0,
                openSwap0: leg((backOpenExpectedOut * 9_700n) / 10_000n, backOpenExpectedOut, UNIV3_POOL_PARAM),
                openSwap1: ZERO_LEG,
                openSlippageBps: 300,
                lpPoolParam: UNIV3_POOL_PARAM,
                deadline,
            }),
        ).to.emit(manager, "PositionSwitched");

        const backEvents = await manager.queryFilter(manager.filters.PositionSwitched(safeAddress), -5);
        const back = backEvents[backEvents.length - 1];
        const backTokenId = back.args.newTokenId;
        expect(back.args.fromProtocol).to.equal(UNISWAP_V4);
        expect(back.args.toProtocol).to.equal(UNISWAP_V3);
        expect(back.args.oldBasisUsd6).to.equal(carriedBasis);
        const backUndeployed: bigint = back.args.realizedUsd6 - back.args.deployedUsd6;
        expect(back.args.carriedBasisUsd6).to.equal(carriedBasis - backUndeployed);
        await expect(v4Pm.ownerOf(v4TokenId)).to.be.reverted;
        expect(await uniNpm.ownerOf(backTokenId)).to.equal(safeAddress);
        expect(await manager.residualBasisUsd6Of(UNISWAP_V4, v4TokenId)).to.equal(0);
        expect(await manager.residualBasisUsd6Of(UNISWAP_V3, backTokenId)).to.equal(back.args.carriedBasisUsd6);
        expect(await manager.positionHandlerOf(UNISWAP_V3, backTokenId)).to.equal(await uniHandler.getAddress());
        expect(await usdc.balanceOf(treasury.address)).to.equal(0);
    });

    it("moves real positions between Aerodrome and Uniswap V4 in both directions carrying the basis", async function () {
        const { operator, treasury, safeAddress, aeroHandler, v4Handler, manager } = await deployStack(
            [UNIV3_POOL_PARAM],
            [AERO_POOL_PARAM],
        );

        const { poolAddress: uniPoolAddress } = await readUniPool(FEE_TIER);
        const { sqrtP: aeroSqrtP, tick: aeroTick } = await readAeroPool();
        const aeroAlignedTick = Math.floor(aeroTick / AERO_TICK_SPACING) * AERO_TICK_SPACING;
        const { sqrtP: v4SqrtP, tick: v4Tick } = await readV4Pool();
        const v4AlignedTick = Math.floor(v4Tick / UNIV4_TICK_SPACING) * UNIV4_TICK_SPACING;

        const input = ethers.parseUnits("10", 6);
        const usdc = await fundSafeUsdcFromPool(uniPoolAddress, safeAddress, input);

        const block = await ethers.provider.getBlock("latest");
        const deadline = BigInt(block!.timestamp + 3_600);
        const openExpectedOut = spotUsdcToWeth(input / 2n, aeroSqrtP);
        await (
            await manager.connect(operator).openLp(AERODROME, {
                onBehalfOf: safeAddress,
                usdcAmount: input,
                tickLower: aeroAlignedTick - 1_000,
                tickUpper: aeroAlignedTick + 1_000,
                mintAmount0Min: 0,
                mintAmount1Min: 0,
                swap0: leg((openExpectedOut * 9_900n) / 10_000n, openExpectedOut, AERO_POOL_PARAM),
                swap1: ZERO_LEG,
                slippageBps: 100,
                deadline,
                lpPoolParam: AERO_POOL_PARAM,
                stake: false,
            })
        ).wait();

        const openedEvents = await manager.queryFilter(manager.filters.PositionOpened(safeAddress), -5);
        const opened = openedEvents[openedEvents.length - 1];
        const oldTokenId = opened.args.tokenId;
        const initialBasis = await manager.residualBasisUsd6Of(AERODROME, oldTokenId);
        expect(initialBasis).to.be.greaterThan(0);

        // The close leg swaps WETH back through the Aerodrome pool; the open
        // leg redeploys the realized USDC into the native ETH/USDC V4 pool.
        const closeExpectedOut = spotWethToUsdc(opened.args.amount0ToLp, aeroSqrtP);
        const realizedEstimate = opened.args.amount1ToLp + closeExpectedOut;
        const switchOpenExpectedOut = spotUsdcToWeth(realizedEstimate / 2n, v4SqrtP);

        await expect(
            manager.connect(operator).switchLp(AERODROME, UNISWAP_V4, {
                onBehalfOf: safeAddress,
                tokenId: oldTokenId,
                closeSwap0: leg((closeExpectedOut * 9_700n) / 10_000n, closeExpectedOut, AERO_POOL_PARAM),
                closeSwap1: ZERO_LEG,
                closeSlippageBps: 300,
                decreaseAmount0Min: 0,
                decreaseAmount1Min: 0,
                minUsdcOut: (realizedEstimate * 9_500n) / 10_000n,
                tickLower: v4AlignedTick - 1_000,
                tickUpper: v4AlignedTick + 1_000,
                mintAmount0Min: 0,
                mintAmount1Min: 0,
                openSwap0: leg((switchOpenExpectedOut * 9_700n) / 10_000n, switchOpenExpectedOut, UNIV4_POOL_PARAM),
                openSwap1: ZERO_LEG,
                openSlippageBps: 300,
                lpPoolParam: UNIV4_POOL_PARAM,
                deadline,
            }),
        ).to.emit(manager, "PositionSwitched");

        const switchedEvents = await manager.queryFilter(manager.filters.PositionSwitched(safeAddress), -5);
        const switched = switchedEvents[switchedEvents.length - 1];
        const v4TokenId = switched.args.newTokenId;
        expect(switched.args.oldBasisUsd6).to.equal(initialBasis);
        const undeployed: bigint = switched.args.realizedUsd6 - switched.args.deployedUsd6;
        const carriedBasis: bigint = switched.args.carriedBasisUsd6;
        expect(carriedBasis).to.equal(initialBasis - undeployed);
        expect(carriedBasis).to.be.greaterThan(0);

        const aeroNpm = new ethers.Contract(AERODROME_SLIPSTREAM_NPM_ADDRESS, NPM_ABI, ethers.provider);
        const v4Pm = new ethers.Contract(UNISWAP_V4_POSITION_MANAGER_ADDRESS, V4_PM_ABI, ethers.provider);
        await expect(aeroNpm.ownerOf(oldTokenId)).to.be.reverted;
        expect(await v4Pm.ownerOf(v4TokenId)).to.equal(safeAddress);
        expect(await v4Pm.getPositionLiquidity(v4TokenId)).to.be.greaterThan(0);
        expect(await manager.residualBasisUsd6Of(AERODROME, oldTokenId)).to.equal(0);
        expect(await manager.residualBasisUsd6Of(UNISWAP_V4, v4TokenId)).to.equal(carriedBasis);
        expect(await manager.positionHandlerOf(UNISWAP_V4, v4TokenId)).to.equal(await v4Handler.getAddress());
        expect(await usdc.balanceOf(treasury.address)).to.equal(0);

        // Back leg: estimate the V4 position's composition from its actual
        // liquidity, then close it through the V4 pool and reopen on Aerodrome.
        const v4Liquidity: bigint = await v4Pm.getPositionLiquidity(v4TokenId);
        const { amount0: ethInPosition, amount1: usdcInPosition } = inRangeAmounts(
            v4Liquidity,
            v4SqrtP,
            v4AlignedTick - 1_000,
            v4AlignedTick + 1_000,
        );
        const backCloseExpectedOut = spotWethToUsdc(ethInPosition, v4SqrtP);
        const backRealizedEstimate = usdcInPosition + backCloseExpectedOut;
        const backOpenExpectedOut = spotUsdcToWeth(backRealizedEstimate / 2n, aeroSqrtP);

        await expect(
            manager.connect(operator).switchLp(UNISWAP_V4, AERODROME, {
                onBehalfOf: safeAddress,
                tokenId: v4TokenId,
                closeSwap0: leg((backCloseExpectedOut * 9_700n) / 10_000n, backCloseExpectedOut, UNIV4_POOL_PARAM),
                closeSwap1: ZERO_LEG,
                closeSlippageBps: 300,
                decreaseAmount0Min: 0,
                decreaseAmount1Min: 0,
                minUsdcOut: (backRealizedEstimate * 9_500n) / 10_000n,
                tickLower: aeroAlignedTick - 1_000,
                tickUpper: aeroAlignedTick + 1_000,
                mintAmount0Min: 0,
                mintAmount1Min: 0,
                openSwap0: leg((backOpenExpectedOut * 9_700n) / 10_000n, backOpenExpectedOut, AERO_POOL_PARAM),
                openSwap1: ZERO_LEG,
                openSlippageBps: 300,
                lpPoolParam: AERO_POOL_PARAM,
                deadline,
            }),
        ).to.emit(manager, "PositionSwitched");

        const backEvents = await manager.queryFilter(manager.filters.PositionSwitched(safeAddress), -5);
        const back = backEvents[backEvents.length - 1];
        const backTokenId = back.args.newTokenId;
        expect(back.args.fromProtocol).to.equal(UNISWAP_V4);
        expect(back.args.toProtocol).to.equal(AERODROME);
        expect(back.args.oldBasisUsd6).to.equal(carriedBasis);
        const backUndeployed: bigint = back.args.realizedUsd6 - back.args.deployedUsd6;
        expect(back.args.carriedBasisUsd6).to.equal(carriedBasis - backUndeployed);
        await expect(v4Pm.ownerOf(v4TokenId)).to.be.reverted;
        expect(await aeroNpm.ownerOf(backTokenId)).to.equal(safeAddress);
        expect(await manager.residualBasisUsd6Of(UNISWAP_V4, v4TokenId)).to.equal(0);
        expect(await manager.residualBasisUsd6Of(AERODROME, backTokenId)).to.equal(back.args.carriedBasisUsd6);
        expect(await manager.positionHandlerOf(AERODROME, backTokenId)).to.equal(await aeroHandler.getAddress());
        expect(await usdc.balanceOf(treasury.address)).to.equal(0);
    });
});
