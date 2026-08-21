import { expect } from "chai";
import { ethers, network } from "hardhat";
import {
    PERMIT2_ADDRESS,
    UNISWAP_V3_FACTORY_ADDRESS,
    UNISWAP_V4_POSITION_MANAGER_ADDRESS,
    UNISWAP_V4_STATE_VIEW_ADDRESS,
    UNIVERSAL_ROUTER_ADDRESS,
    USDC_ADDRESS,
    WETH_ADDRESS,
    encodeUniV4PoolParam,
    TWAP_REF_WETH_USDC_POOL,
    TWAP_WINDOW,
    TWAP_CARDINALITY,
} from "../../contractAddresses";
import { ZERO_LEG, leg } from "../helpers/utils";
import { deployRealSafe, enableModuleOnSafe } from "../helpers/deployRealSafe";

// ─────────────────────────────────────────────────────────────────────────
//  Base-fork integration for UniV4YieldHandler against the REAL Uniswap V4
//  stack (PoolManager-backed PositionManager, UniversalRouter, Permit2,
//  StateView). This is what validates the vendored Actions/Commands byte
//  values and param encodings — the mock suite can only prove internal
//  consistency. Uses the native ETH/USDC pool (currency0 == address(0)),
//  the deepest V4 pool on Base.
// ─────────────────────────────────────────────────────────────────────────

const UNISWAP_V4 = 2;
const FEE_TIER = 500;
const TICK_SPACING = 10;
const FORK_BLOCK = Number(process.env.BASE_FORK_BLOCK_NUMBER ?? 49_470_000);
const NATIVE = ethers.ZeroAddress;
const POOL_PARAM = encodeUniV4PoolParam(NATIVE, USDC_ADDRESS, FEE_TIER, TICK_SPACING, ethers.ZeroAddress);
const POOL_ID = ethers.keccak256(POOL_PARAM);

// ERC20-currency0 pool (WETH < USDC so currency0 == WETH): exercises the
// Permit2 two-step approval + reset path the native pool skips. fee 0.3% /
// tickSpacing 60 is the deeper of the two real WETH/USDC V4 pools on Base.
const WETH_FEE_TIER = 3000;
const WETH_TICK_SPACING = 60;
const WETH_POOL_PARAM = encodeUniV4PoolParam(
    WETH_ADDRESS,
    USDC_ADDRESS,
    WETH_FEE_TIER,
    WETH_TICK_SPACING,
    ethers.ZeroAddress,
);
const WETH_POOL_ID = ethers.keccak256(WETH_POOL_PARAM);

const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address,uint256) returns (bool)",
    "function allowance(address,address) view returns (uint256)",
];
const FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
const STATE_VIEW_ABI = [
    "function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)",
    "function getLiquidity(bytes32) view returns (uint128)",
];
const PM_ABI = [
    "function ownerOf(uint256) view returns (address)",
    "function getPositionLiquidity(uint256) view returns (uint128)",
];
const PERMIT2_ABI = ["function allowance(address,address,address) view returns (uint160,uint48,uint48)"];
const UNIVERSAL_ROUTER_ABI = ["function execute(bytes,bytes[],uint256) payable"];

async function pushV4NativeSpotDown(ethIn: bigint) {
    const trader = (await ethers.getSigners())[4];
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const swap = coder.encode(
        [
            "tuple(tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)",
        ],
        [[[NATIVE, USDC_ADDRESS, FEE_TIER, TICK_SPACING, ethers.ZeroAddress], true, ethIn, 0n, "0x"]],
    );
    const settle = coder.encode(["address", "uint256"], [NATIVE, ethIn]);
    const take = coder.encode(["address", "uint256"], [USDC_ADDRESS, 0n]);
    const input = coder.encode(["bytes", "bytes[]"], ["0x060c0f", [swap, settle, take]]);
    const router = new ethers.Contract(UNIVERSAL_ROUTER_ADDRESS, UNIVERSAL_ROUTER_ABI, trader);
    const block = await ethers.provider.getBlock("latest");
    await (await router.execute("0x10", [input], block!.timestamp + 600, { value: ethIn })).wait();
}

describe("SafeYieldManager + Uniswap V4 - integration (Base fork)", function () {
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

    it("opens, collects, partially closes, and fully closes a real native ETH/USDC V4 position", async function () {
        const [admin, operator, treasury, pauser] = await ethers.getSigners();

        const Registry = await ethers.getContractFactory("MockRegistry");
        const registry = await Registry.deploy();
        await registry.waitForDeployment();
        await (await registry.setOperator(operator.address)).wait();
        await (await registry.setWhitelisted(WETH_ADDRESS, true)).wait();
        await (await registry.setWhitelisted(USDC_ADDRESS, true)).wait();

        const safeAddress = await deployRealSafe(admin);

        const Handler = await ethers.getContractFactory("UniV4YieldHandler");
        const handler = await Handler.deploy(
            UNISWAP_V4_POSITION_MANAGER_ADDRESS,
            UNIVERSAL_ROUTER_ADDRESS,
            PERMIT2_ADDRESS,
            UNISWAP_V4_STATE_VIEW_ADDRESS,
            USDC_ADDRESS,
            WETH_ADDRESS,
        );
        await handler.waitForDeployment();

        const Timelock = await ethers.getContractFactory("MockTimelockController");
        const timelock = await Timelock.deploy(1);
        await timelock.waitForDeployment();

        const Manager = await ethers.getContractFactory("SafeYieldManager");
        const manager = await Manager.deploy(
            await registry.getAddress(),
            USDC_ADDRESS,
            WETH_ADDRESS,
            [UNISWAP_V4],
            [await handler.getAddress()],
            [[POOL_PARAM]],
            [0],
            [0],
            [ethers.ZeroAddress],
            [{ pool: TWAP_REF_WETH_USDC_POOL, window: TWAP_WINDOW, minCardinality: TWAP_CARDINALITY }],
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

        const stateView = new ethers.Contract(UNISWAP_V4_STATE_VIEW_ADDRESS, STATE_VIEW_ABI, ethers.provider);
        const [sqrtPriceRaw, tickRaw] = await stateView.getSlot0(POOL_ID);
        const sqrtPriceX96 = BigInt(sqrtPriceRaw);
        if (sqrtPriceX96 === 0n) {
            throw new Error(
                `Uniswap V4 pool ${POOL_ID} is not initialized at fork block ${FORK_BLOCK}; refusing to skip the integration test`,
            );
        }
        const alignedTick = Math.floor(Number(tickRaw) / TICK_SPACING) * TICK_SPACING;
        const spotUsdcToEth = (amount: bigint) => (amount << 192n) / (sqrtPriceX96 * sqrtPriceX96);
        const spotEthToUsdc = (amount: bigint) => (amount * sqrtPriceX96 * sqrtPriceX96) >> 192n;

        // The live V3 pool is a convenient deterministic USDC holder on the
        // fork. Impersonation only mutates the disposable fork state.
        const factory = new ethers.Contract(UNISWAP_V3_FACTORY_ADDRESS, FACTORY_ABI, ethers.provider);
        const v3Pool: string = await factory.getPool(WETH_ADDRESS, USDC_ADDRESS, FEE_TIER);
        await network.provider.send("hardhat_setBalance", [v3Pool, "0x8AC7230489E80000"]);
        const poolSigner = await ethers.getImpersonatedSigner(v3Pool);
        const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, ethers.provider);
        const input = ethers.parseUnits("10", 6);
        await (await (usdc.connect(poolSigner) as any).transfer(safeAddress, input)).wait();
        await network.provider.send("hardhat_stopImpersonatingAccount", [v3Pool]);

        const block = await ethers.provider.getBlock("latest");
        const deadline = BigInt(block!.timestamp + 3_600);
        const expectedSwapOut = spotUsdcToEth(input / 2n);
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

        // Router-level min-out (TAKE_ALL floor) must fire on an impossible quote.
        await expect(
            manager.connect(operator).openLp(UNISWAP_V4, {
                ...openParams,
                swap0: leg((expectedSwapOut * 2n * 9_900n) / 10_000n, POOL_PARAM),
            }),
        ).to.be.reverted;

        await expect(manager.connect(operator).openLp(UNISWAP_V4, openParams)).to.emit(manager, "PositionOpened");
        const openedEvents = await manager.queryFilter(manager.filters.PositionOpened(safeAddress), -5);
        const opened = openedEvents[openedEvents.length - 1];
        const tokenId = opened.args.tokenId;

        const pm = new ethers.Contract(UNISWAP_V4_POSITION_MANAGER_ADDRESS, PM_ABI, ethers.provider);
        // Mint dust: ETH the liquidity computation could not consume was swept
        // back to the Safe (the V4 analogue of V3's unused-desired refund).
        const ethDustAfterOpen = await ethers.provider.getBalance(safeAddress);
        expect(await pm.ownerOf(tokenId)).to.equal(safeAddress);
        expect(await pm.getPositionLiquidity(tokenId)).to.be.greaterThan(0);
        const initialBasis = await manager.residualBasisUsd6Of(UNISWAP_V4, tokenId);
        expect(initialBasis).to.be.greaterThan(0);

        // Both Permit2 hops must be back at zero after the mint.
        const permit2 = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, ethers.provider);
        const [pmAllowance] = await permit2.allowance(safeAddress, USDC_ADDRESS, UNISWAP_V4_POSITION_MANAGER_ADDRESS);
        const [urAllowance] = await permit2.allowance(safeAddress, USDC_ADDRESS, UNIVERSAL_ROUTER_ADDRESS);
        expect(pmAllowance).to.equal(0);
        expect(urAllowance).to.equal(0);
        expect(await usdc.allowance(safeAddress, PERMIT2_ADDRESS)).to.equal(0);

        await expect(
            manager.connect(operator).collectLp(UNISWAP_V4, {
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

        const ethToLp: bigint = opened.args.amount0ToLp;
        const usdcToLp: bigint = opened.args.amount1ToLp;
        const closeParams = (exitBps: number, shareOfOriginalBps: bigint) => {
            const ethShare = (ethToLp * shareOfOriginalBps) / 10_000n;
            const usdcShare = (usdcToLp * shareOfOriginalBps) / 10_000n;
            const expectedOut = spotEthToUsdc(ethShare);
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

        const manipulationSnapshot = await network.provider.send("evm_snapshot");
        const tickBeforeManipulation = Number((await stateView.getSlot0(POOL_ID))[1]);
        await pushV4NativeSpotDown(ethers.parseEther("1000"));
        const tickAfterManipulation = Number((await stateView.getSlot0(POOL_ID))[1]);
        expect(tickAfterManipulation).to.be.lessThan(tickBeforeManipulation - 300);
        await expect(
            manager.connect(operator).closeLp(UNISWAP_V4, {
                ...closeParams(10_000, 10_000n),
                swap0: leg(0, POOL_PARAM),
                minUsdcOut: 0,
            }),
        ).to.be.reverted;
        expect(await pm.ownerOf(tokenId)).to.equal(safeAddress);
        expect(await network.provider.send("evm_revert", [manipulationSnapshot])).to.equal(true);

        await expect(manager.connect(operator).closeLp(UNISWAP_V4, closeParams(5_000, 5_000n))).to.emit(
            manager,
            "PositionClosed",
        );
        expect(await pm.ownerOf(tokenId)).to.equal(safeAddress);
        expect(await manager.residualBasisUsd6Of(UNISWAP_V4, tokenId)).to.be.lessThan(initialBasis);

        await expect(manager.connect(operator).closeLp(UNISWAP_V4, closeParams(10_000, 5_000n))).to.emit(
            manager,
            "PositionClosed",
        );
        expect(await manager.residualBasisUsd6Of(UNISWAP_V4, tokenId)).to.equal(0);
        await expect(pm.ownerOf(tokenId)).to.be.reverted;
        // The closes swept their own ETH back to USDC — only the pre-existing
        // open-mint dust remains on the Safe.
        expect(await ethers.provider.getBalance(safeAddress)).to.equal(ethDustAfterOpen);
        expect(await usdc.balanceOf(safeAddress)).to.be.greaterThan(0);
    });

    it("opens, collects, partially closes, and fully closes a real WETH/USDC V4 position (ERC20 currency0)", async function () {
        const [admin, operator, treasury, pauser] = await ethers.getSigners();

        const Registry = await ethers.getContractFactory("MockRegistry");
        const registry = await Registry.deploy();
        await registry.waitForDeployment();
        await (await registry.setOperator(operator.address)).wait();
        await (await registry.setWhitelisted(WETH_ADDRESS, true)).wait();
        await (await registry.setWhitelisted(USDC_ADDRESS, true)).wait();

        const safeAddress = await deployRealSafe(admin);

        const Handler = await ethers.getContractFactory("UniV4YieldHandler");
        const handler = await Handler.deploy(
            UNISWAP_V4_POSITION_MANAGER_ADDRESS,
            UNIVERSAL_ROUTER_ADDRESS,
            PERMIT2_ADDRESS,
            UNISWAP_V4_STATE_VIEW_ADDRESS,
            USDC_ADDRESS,
            WETH_ADDRESS,
        );
        await handler.waitForDeployment();

        const Timelock = await ethers.getContractFactory("MockTimelockController");
        const timelock = await Timelock.deploy(1);
        await timelock.waitForDeployment();

        const Manager = await ethers.getContractFactory("SafeYieldManager");
        const manager = await Manager.deploy(
            await registry.getAddress(),
            USDC_ADDRESS,
            WETH_ADDRESS,
            [UNISWAP_V4],
            [await handler.getAddress()],
            [[WETH_POOL_PARAM]],
            [0],
            [0],
            [WETH_ADDRESS],
            [{ pool: TWAP_REF_WETH_USDC_POOL, window: TWAP_WINDOW, minCardinality: TWAP_CARDINALITY }],
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

        const stateView = new ethers.Contract(UNISWAP_V4_STATE_VIEW_ADDRESS, STATE_VIEW_ABI, ethers.provider);
        const [sqrtPriceRaw, tickRaw] = await stateView.getSlot0(WETH_POOL_ID);
        const sqrtPriceX96 = BigInt(sqrtPriceRaw);
        if (sqrtPriceX96 === 0n) {
            throw new Error(
                `Uniswap V4 pool ${WETH_POOL_ID} is not initialized at fork block ${FORK_BLOCK}; refusing to skip the integration test`,
            );
        }
        const alignedTick = Math.floor(Number(tickRaw) / WETH_TICK_SPACING) * WETH_TICK_SPACING;
        // currency0 == WETH, currency1 == USDC (both share the native pool's
        // 18dp/6dp layout, so the same spot formulas hold).
        const spotUsdcToWeth = (amount: bigint) => (amount << 192n) / (sqrtPriceX96 * sqrtPriceX96);
        const spotWethToUsdc = (amount: bigint) => (amount * sqrtPriceX96 * sqrtPriceX96) >> 192n;

        // The live V3 pool is a convenient deterministic USDC holder on the fork.
        const factory = new ethers.Contract(UNISWAP_V3_FACTORY_ADDRESS, FACTORY_ABI, ethers.provider);
        const v3Pool: string = await factory.getPool(WETH_ADDRESS, USDC_ADDRESS, FEE_TIER);
        await network.provider.send("hardhat_setBalance", [v3Pool, "0x8AC7230489E80000"]);
        const poolSigner = await ethers.getImpersonatedSigner(v3Pool);
        const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, ethers.provider);
        const weth = new ethers.Contract(WETH_ADDRESS, ERC20_ABI, ethers.provider);
        const input = ethers.parseUnits("10", 6);
        await (await (usdc.connect(poolSigner) as any).transfer(safeAddress, input)).wait();
        await network.provider.send("hardhat_stopImpersonatingAccount", [v3Pool]);

        const block = await ethers.provider.getBlock("latest");
        const deadline = BigInt(block!.timestamp + 3_600);
        const expectedSwapOut = spotUsdcToWeth(input / 2n);
        const openParams = {
            onBehalfOf: safeAddress,
            usdcAmount: input,
            tickLower: alignedTick - 20 * WETH_TICK_SPACING,
            tickUpper: alignedTick + 20 * WETH_TICK_SPACING,
            mintAmount0Min: 0,
            mintAmount1Min: 0,
            // USDC -> WETH (currency0) leg; the USDC side (currency1) needs none.
            swap0: leg((expectedSwapOut * 9_900n) / 10_000n, WETH_POOL_PARAM),
            swap1: ZERO_LEG,
            slippageBps: 100,
            deadline,
            lpPoolParam: WETH_POOL_PARAM,
            stake: false,
        };

        await expect(manager.connect(operator).openLp(UNISWAP_V4, openParams)).to.emit(manager, "PositionOpened");
        const openedEvents = await manager.queryFilter(manager.filters.PositionOpened(safeAddress), -5);
        const opened = openedEvents[openedEvents.length - 1];
        const tokenId = opened.args.tokenId;

        const pm = new ethers.Contract(UNISWAP_V4_POSITION_MANAGER_ADDRESS, PM_ABI, ethers.provider);
        expect(await pm.ownerOf(tokenId)).to.equal(safeAddress);
        expect(await pm.getPositionLiquidity(tokenId)).to.be.greaterThan(0);
        const initialBasis = await manager.residualBasisUsd6Of(UNISWAP_V4, tokenId);
        expect(initialBasis).to.be.greaterThan(0);
        // WETH the liquidity could not consume stays on the Safe (ERC20 has no
        // SWEEP; Permit2 only pulls what the mint settles).
        const wethDustAfterOpen = await weth.balanceOf(safeAddress);

        // Both Permit2 hops must be back at zero after the mint — for the ERC20
        // currency0 (WETH) as well as the USDC swap input. This is the path the
        // native pool skips entirely.
        const permit2 = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, ethers.provider);
        const [wethPmAllowance] = await permit2.allowance(
            safeAddress,
            WETH_ADDRESS,
            UNISWAP_V4_POSITION_MANAGER_ADDRESS,
        );
        const [usdcPmAllowance] = await permit2.allowance(
            safeAddress,
            USDC_ADDRESS,
            UNISWAP_V4_POSITION_MANAGER_ADDRESS,
        );
        const [usdcUrAllowance] = await permit2.allowance(safeAddress, USDC_ADDRESS, UNIVERSAL_ROUTER_ADDRESS);
        expect(wethPmAllowance).to.equal(0);
        expect(usdcPmAllowance).to.equal(0);
        expect(usdcUrAllowance).to.equal(0);
        expect(await weth.allowance(safeAddress, PERMIT2_ADDRESS)).to.equal(0);
        expect(await usdc.allowance(safeAddress, PERMIT2_ADDRESS)).to.equal(0);

        await expect(
            manager.connect(operator).collectLp(UNISWAP_V4, {
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
                    poolParam: WETH_POOL_PARAM,
                },
                swap1: ZERO_LEG,
                slippageBps: 300,
                decreaseAmount0Min: 0,
                decreaseAmount1Min: 0,
                deadline,
                minUsdcOut: ((usdcShare + expectedOut) * 9_500n) / 10_000n,
            };
        };

        await expect(manager.connect(operator).closeLp(UNISWAP_V4, closeParams(5_000, 5_000n))).to.emit(
            manager,
            "PositionClosed",
        );
        expect(await pm.ownerOf(tokenId)).to.equal(safeAddress);
        expect(await manager.residualBasisUsd6Of(UNISWAP_V4, tokenId)).to.be.lessThan(initialBasis);

        await expect(manager.connect(operator).closeLp(UNISWAP_V4, closeParams(10_000, 5_000n))).to.emit(
            manager,
            "PositionClosed",
        );
        expect(await manager.residualBasisUsd6Of(UNISWAP_V4, tokenId)).to.equal(0);
        await expect(pm.ownerOf(tokenId)).to.be.reverted;
        // Closes swap only the WETH they withdraw (delta-measured), so the
        // open-mint WETH dust is left untouched; realized USDC lands on the Safe.
        expect(await weth.balanceOf(safeAddress)).to.equal(wethDustAfterOpen);
        expect(await usdc.balanceOf(safeAddress)).to.be.greaterThan(0);
    });
});
