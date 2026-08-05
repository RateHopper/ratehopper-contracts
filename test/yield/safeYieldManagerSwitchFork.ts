import { expect } from "chai";
import { ethers, network } from "hardhat";
import {
    AERODROME_CL_FACTORY_ADDRESS,
    AERODROME_SLIPSTREAM_NPM_ADDRESS,
    AERODROME_SLIPSTREAM_SWAP_ROUTER_ADDRESS,
    UNISWAP_V3_FACTORY_ADDRESS,
    UNISWAP_V3_NPM_ADDRESS,
    UNISWAP_V3_SWAP_ROUTER_ADDRESS,
    USDC_ADDRESS,
    WETH_ADDRESS,
} from "../../contractAddresses";

const UNISWAP_V3 = 0;
const AERODROME = 1;
const FEE_TIER = 500;
const UNIV3_TICK_SPACING = 10;
const AERO_TICK_SPACING = 100;
const FORK_BLOCK = Number(process.env.BASE_FORK_BLOCK_NUMBER ?? 49_470_000);
const UNIV3_POOL_PARAM = ethers.AbiCoder.defaultAbiCoder().encode(["uint24"], [FEE_TIER]);
const AERO_POOL_PARAM = ethers.AbiCoder.defaultAbiCoder().encode(["int24"], [AERO_TICK_SPACING]);

const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address,uint256) returns (bool)",
];
const UNIV3_FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
const AERO_FACTORY_ABI = ["function getPool(address,address,int24) view returns (address)"];
const UNIV3_POOL_ABI = ["function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)"];
const AERO_POOL_ABI = ["function slot0() view returns (uint160,int24,uint16,uint16,uint16,bool)"];
const NPM_ABI = ["function ownerOf(uint256) view returns (address)"];

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
        const [admin, operator, treasury, pauser] = await ethers.getSigners();

        const Registry = await ethers.getContractFactory("MockRegistry");
        const registry = await Registry.deploy();
        await registry.waitForDeployment();
        await (await registry.setOperator(operator.address)).wait();

        const Safe = await ethers.getContractFactory("MockSafeHarness");
        const safe = await Safe.deploy();
        await safe.waitForDeployment();
        const safeAddress = await safe.getAddress();

        const UniHandler = await ethers.getContractFactory("UniV3YieldHandler");
        const uniHandler = await UniHandler.deploy(
            UNISWAP_V3_NPM_ADDRESS,
            USDC_ADDRESS,
            WETH_ADDRESS,
            UNISWAP_V3_SWAP_ROUTER_ADDRESS,
            UNISWAP_V3_FACTORY_ADDRESS,
        );
        await uniHandler.waitForDeployment();

        const AeroHandler = await ethers.getContractFactory("AerodromeYieldHandler");
        const aeroHandler = await AeroHandler.deploy(
            AERODROME_SLIPSTREAM_NPM_ADDRESS,
            USDC_ADDRESS,
            WETH_ADDRESS,
            AERODROME_SLIPSTREAM_SWAP_ROUTER_ADDRESS,
            AERODROME_CL_FACTORY_ADDRESS,
        );
        await aeroHandler.waitForDeployment();

        const Manager = await ethers.getContractFactory("SafeYieldManager");
        const manager = await Manager.deploy(
            await registry.getAddress(),
            USDC_ADDRESS,
            [UNISWAP_V3, AERODROME],
            [await uniHandler.getAddress(), await aeroHandler.getAddress()],
            [[UNIV3_POOL_PARAM], [AERO_POOL_PARAM]],
            [0, 0],
            [0, 0],
            treasury.address,
            1_000,
            250,
            2_000,
            admin.address,
            admin.address,
            pauser.address,
        );
        await manager.waitForDeployment();

        const uniFactory = new ethers.Contract(UNISWAP_V3_FACTORY_ADDRESS, UNIV3_FACTORY_ABI, ethers.provider);
        const uniPoolAddress: string = await uniFactory.getPool(WETH_ADDRESS, USDC_ADDRESS, FEE_TIER);
        const uniPool = new ethers.Contract(uniPoolAddress, UNIV3_POOL_ABI, ethers.provider);
        const [uniSqrtP, uniTick] = await uniPool.slot0();
        const uniAlignedTick = Math.floor(Number(uniTick) / UNIV3_TICK_SPACING) * UNIV3_TICK_SPACING;

        const aeroFactory = new ethers.Contract(AERODROME_CL_FACTORY_ADDRESS, AERO_FACTORY_ABI, ethers.provider);
        const aeroPoolAddress: string = await aeroFactory.getPool(WETH_ADDRESS, USDC_ADDRESS, AERO_TICK_SPACING);
        const aeroPool = new ethers.Contract(aeroPoolAddress, AERO_POOL_ABI, ethers.provider);
        const [aeroSqrtP, aeroTick] = await aeroPool.slot0();
        const aeroAlignedTick = Math.floor(Number(aeroTick) / AERO_TICK_SPACING) * AERO_TICK_SPACING;

        const spotUsdcToWeth = (amount: bigint, sqrtP: bigint) => (amount << 192n) / (sqrtP * sqrtP);
        const spotWethToUsdc = (amount: bigint, sqrtP: bigint) => (amount * sqrtP * sqrtP) >> 192n;

        await network.provider.send("hardhat_setBalance", [uniPoolAddress, "0x8AC7230489E80000"]);
        const poolSigner = await ethers.getImpersonatedSigner(uniPoolAddress);
        const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, ethers.provider);
        const input = ethers.parseUnits("10", 6);
        await (await (usdc.connect(poolSigner) as any).transfer(safeAddress, input)).wait();
        await network.provider.send("hardhat_stopImpersonatingAccount", [uniPoolAddress]);

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
                swapAmountOutMin: (openExpectedOut * 9_900n) / 10_000n,
                expectedSwapOut: openExpectedOut,
                slippageBps: 100,
                deadline,
                lpPoolParam: UNIV3_POOL_PARAM,
                swapPoolParam: UNIV3_POOL_PARAM,
            })
        ).wait();

        const openedEvents = await manager.queryFilter(manager.filters.PositionOpened(safeAddress), -5);
        const opened = openedEvents[openedEvents.length - 1];
        const oldTokenId = opened.args.tokenId;
        const initialBasis = await manager.residualBasisUsd6Of(UNISWAP_V3, oldTokenId);
        expect(initialBasis).to.be.greaterThan(0);

        // Close-leg estimates from the amounts that actually entered the LP;
        // the open leg redeploys the realized USDC, estimated the same way.
        const wethToLp: bigint = opened.args.wethToLp;
        const usdcToLp: bigint = opened.args.usdcToLp;
        const closeExpectedOut = spotWethToUsdc(wethToLp, uniSqrtP);
        const realizedEstimate = usdcToLp + closeExpectedOut;
        const switchOpenExpectedOut = spotUsdcToWeth(realizedEstimate / 2n, aeroSqrtP);

        await expect(
            manager.connect(operator).switchLp(UNISWAP_V3, AERODROME, {
                onBehalfOf: safeAddress,
                tokenId: oldTokenId,
                closeSwapAmountOutMin: (closeExpectedOut * 9_700n) / 10_000n,
                closeExpectedSwapOut: closeExpectedOut,
                closeSlippageBps: 300,
                decreaseAmount0Min: 0,
                decreaseAmount1Min: 0,
                minUsdcOut: (realizedEstimate * 9_500n) / 10_000n,
                closeSwapPoolParam: UNIV3_POOL_PARAM,
                tickLower: aeroAlignedTick - 1_000,
                tickUpper: aeroAlignedTick + 1_000,
                mintAmount0Min: 0,
                mintAmount1Min: 0,
                openSwapAmountOutMin: (switchOpenExpectedOut * 9_700n) / 10_000n,
                openExpectedSwapOut: switchOpenExpectedOut,
                openSlippageBps: 300,
                lpPoolParam: AERO_POOL_PARAM,
                openSwapPoolParam: AERO_POOL_PARAM,
                deadline,
            }),
        ).to.emit(manager, "PositionSwitched");

        const switchedEvents = await manager.queryFilter(manager.filters.PositionSwitched(safeAddress), -5);
        const switched = switchedEvents[switchedEvents.length - 1];
        const newTokenId = switched.args.newTokenId;
        expect(switched.args.oldBasisUsd6).to.equal(initialBasis);
        expect(switched.args.carriedBasisUsd6).to.equal(initialBasis);

        const uniNpm = new ethers.Contract(UNISWAP_V3_NPM_ADDRESS, NPM_ABI, ethers.provider);
        const aeroNpm = new ethers.Contract(AERODROME_SLIPSTREAM_NPM_ADDRESS, NPM_ABI, ethers.provider);
        await expect(uniNpm.ownerOf(oldTokenId)).to.be.reverted;
        expect(await aeroNpm.ownerOf(newTokenId)).to.equal(safeAddress);

        expect(await manager.residualBasisUsd6Of(UNISWAP_V3, oldTokenId)).to.equal(0);
        expect(await manager.residualBasisUsd6Of(AERODROME, newTokenId)).to.equal(initialBasis);
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
        const sqrtRatio = (tick: number) => BigInt(Math.floor(Math.sqrt(1.0001 ** tick) * 2 ** 96));
        const sqrtB = sqrtRatio(aeroAlignedTick + 1_000);
        const wethInPosition = (newLiquidity * (sqrtB - aeroSqrtP) * (1n << 96n)) / (aeroSqrtP * sqrtB);
        const closeFinalExpectedOut = spotWethToUsdc(wethInPosition, aeroSqrtP);
        await expect(
            manager.connect(operator).closeLp(AERODROME, {
                onBehalfOf: safeAddress,
                tokenId: newTokenId,
                exitBps: 10_000,
                swapAmountOutMin: (closeFinalExpectedOut * 9_700n) / 10_000n,
                expectedSwapOut: closeFinalExpectedOut,
                slippageBps: 300,
                decreaseAmount0Min: 0,
                decreaseAmount1Min: 0,
                deadline,
                minUsdcOut: 0,
                swapPoolParam: AERO_POOL_PARAM,
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
                swapAmountOutMin: (reverseOpenExpectedOut * 9_900n) / 10_000n,
                expectedSwapOut: reverseOpenExpectedOut,
                slippageBps: 100,
                deadline,
                lpPoolParam: AERO_POOL_PARAM,
                swapPoolParam: AERO_POOL_PARAM,
            })
        ).wait();

        const reverseOpenedEvents = await manager.queryFilter(manager.filters.PositionOpened(safeAddress), -5);
        const reverseOpened = reverseOpenedEvents[reverseOpenedEvents.length - 1];
        const reverseOldTokenId = reverseOpened.args.tokenId;
        const reverseInitialBasis = await manager.residualBasisUsd6Of(AERODROME, reverseOldTokenId);
        const reverseCloseExpectedOut = spotWethToUsdc(reverseOpened.args.wethToLp, aeroSqrtP);
        const reverseRealizedEstimate = reverseOpened.args.usdcToLp + reverseCloseExpectedOut;
        const reverseSwitchOpenExpectedOut = spotUsdcToWeth(reverseRealizedEstimate / 2n, uniSqrtP);

        await expect(
            manager.connect(operator).switchLp(AERODROME, UNISWAP_V3, {
                onBehalfOf: safeAddress,
                tokenId: reverseOldTokenId,
                closeSwapAmountOutMin: (reverseCloseExpectedOut * 9_700n) / 10_000n,
                closeExpectedSwapOut: reverseCloseExpectedOut,
                closeSlippageBps: 300,
                decreaseAmount0Min: 0,
                decreaseAmount1Min: 0,
                minUsdcOut: (reverseRealizedEstimate * 9_500n) / 10_000n,
                closeSwapPoolParam: AERO_POOL_PARAM,
                tickLower: uniAlignedTick - 1_000,
                tickUpper: uniAlignedTick + 1_000,
                mintAmount0Min: 0,
                mintAmount1Min: 0,
                openSwapAmountOutMin: (reverseSwitchOpenExpectedOut * 9_700n) / 10_000n,
                openExpectedSwapOut: reverseSwitchOpenExpectedOut,
                openSlippageBps: 300,
                lpPoolParam: UNIV3_POOL_PARAM,
                openSwapPoolParam: UNIV3_POOL_PARAM,
                deadline,
            }),
        ).to.emit(manager, "PositionSwitched");

        const reverseSwitchedEvents = await manager.queryFilter(manager.filters.PositionSwitched(safeAddress), -5);
        const reverseSwitched = reverseSwitchedEvents[reverseSwitchedEvents.length - 1];
        const reverseNewTokenId = reverseSwitched.args.newTokenId;
        await expect(aeroNpm.ownerOf(reverseOldTokenId)).to.be.reverted;
        expect(await uniNpm.ownerOf(reverseNewTokenId)).to.equal(safeAddress);
        expect(await manager.residualBasisUsd6Of(AERODROME, reverseOldTokenId)).to.equal(0);
        expect(await manager.residualBasisUsd6Of(UNISWAP_V3, reverseNewTokenId)).to.equal(reverseInitialBasis);
        expect(await manager.positionHandlerOf(UNISWAP_V3, reverseNewTokenId)).to.equal(await uniHandler.getAddress());
    });
});
