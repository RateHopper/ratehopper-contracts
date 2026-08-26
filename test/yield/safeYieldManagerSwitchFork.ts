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
    TWAP_REF_WETH_USDC_POOL,
    TWAP_WINDOW,
    TWAP_CARDINALITY,
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
const AERO_ROUTER_ABI = [
    "function exactInputSingle((address,address,int24,address,uint256,uint256,uint256,uint160)) payable returns (uint256)",
];

const spotUsdcToWeth = (amount: bigint, sqrtP: bigint) => (amount << 192n) / (sqrtP * sqrtP);

// In-kind switch: no swap legs, no USDC realization — the withdraw leg's token
// amounts are redeployed directly. Only decrease/mint minimums remain.
function switchParams(
    safeAddress: string,
    tokenId: bigint,
    tickLower: number,
    tickUpper: number,
    lpPoolParam: string,
    deadline: bigint,
) {
    return {
        onBehalfOf: safeAddress,
        tokenId,
        decreaseAmount0Min: 0,
        decreaseAmount1Min: 0,
        tickLower,
        tickUpper,
        mintAmount0Min: 0,
        mintAmount1Min: 0,
        lpPoolParam,
        deadline,
    };
}

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
        WETH_ADDRESS,
    );
    await v4Handler.waitForDeployment();

    const Timelock = await ethers.getContractFactory("MockTimelockController");
    const timelock = await Timelock.deploy(1);
    await timelock.waitForDeployment();

    const Manager = await ethers.getContractFactory("SafeYieldManager");
    const manager = await Manager.deploy(
        await registry.getAddress(),
        USDC_ADDRESS,
        WETH_ADDRESS,
        [UNISWAP_V3, AERODROME, UNISWAP_V4],
        [await uniHandler.getAddress(), await aeroHandler.getAddress(), await v4Handler.getAddress()],
        [uniPoolParams, aeroPoolParams, [UNIV4_POOL_PARAM]],
        [0, 0, 0],
        [0, 0, 0],
        // The V4 native pool param below is allow-listed here, so its
        // address(0) reference has to exist too — the constructor holds seeded
        // params to the same standard as any later addition.
        [
            {
                token: WETH_ADDRESS,
                config: { pool: TWAP_REF_WETH_USDC_POOL, window: TWAP_WINDOW, minCardinality: TWAP_CARDINALITY },
            },
            {
                token: ethers.ZeroAddress,
                config: { pool: TWAP_REF_WETH_USDC_POOL, window: TWAP_WINDOW, minCardinality: TWAP_CARDINALITY },
            },
        ],
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

async function pushAeroSpotUp(fundingPool: string, usdcIn: bigint) {
    const trader = (await ethers.getSigners())[4];
    const usdc = await fundSafeUsdcFromPool(fundingPool, trader.address, usdcIn);
    const usdcWithApprove = new ethers.Contract(
        USDC_ADDRESS,
        [...ERC20_ABI, "function approve(address,uint256) returns (bool)"],
        trader,
    );
    await (await usdcWithApprove.approve(AERODROME_SLIPSTREAM_SWAP_ROUTER_ADDRESS, usdcIn)).wait();
    const router = new ethers.Contract(AERODROME_SLIPSTREAM_SWAP_ROUTER_ADDRESS, AERO_ROUTER_ABI, trader);
    const block = await ethers.provider.getBlock("latest");
    await (
        await router.exactInputSingle([
            USDC_ADDRESS,
            WETH_ADDRESS,
            AERO_TICK_SPACING,
            trader.address,
            BigInt(block!.timestamp + 600),
            usdcIn,
            0n,
            0n,
        ])
    ).wait();
    return usdc;
}

async function openUniV3(
    manager: any,
    operator: any,
    safeAddress: string,
    input: bigint,
    sqrtP: bigint,
    poolParam: string,
    tickLower: number,
    tickUpper: number,
    deadline: bigint,
) {
    const openExpectedOut = spotUsdcToWeth(input / 2n, sqrtP);
    await (
        await manager.connect(operator).openLp(UNISWAP_V3, {
            onBehalfOf: safeAddress,
            usdcAmount: input,
            tickLower,
            tickUpper,
            mintAmount0Min: 0,
            mintAmount1Min: 0,
            swap0: leg((openExpectedOut * 9_700n) / 10_000n, poolParam),
            swap1: ZERO_LEG,
            slippageBps: 300,
            deadline,
            lpPoolParam: poolParam,
            stake: false,
        })
    ).wait();
    const openedEvents = await manager.queryFilter(manager.filters.PositionOpened(safeAddress), -5);
    return openedEvents[openedEvents.length - 1];
}

async function lastSwitched(manager: any, safeAddress: string) {
    const events = await manager.queryFilter(manager.filters.PositionSwitched(safeAddress), -5);
    return events[events.length - 1];
}

/**
 * M-02 on real numbers. A concentrated-liquidity mint consumes the two sides
 * only in the ratio its range demands, so a real in-kind switch always leaves
 * one side behind — 4.8%-5.3% of the position's basis in these fixtures, which
 * is money, not dust. The invariant that has to hold is conservation: what the
 * replacement position still owes plus what the Safe was handed back equals
 * what the original position owed.
 */
async function expectResidueConserved(manager: any, safeAddress: string, previousBasis: bigint) {
    const events = await manager.queryFilter(manager.filters.SwitchResidueSettled(safeAddress), -5);
    const settled = events[events.length - 1];
    const { residualUsd6, newBasisUsd6, newCarryUsd6 } = settled.args;

    if (residualUsd6 <= previousBasis) {
        expect(newBasisUsd6 + residualUsd6).to.equal(previousBasis);
        expect(newCarryUsd6).to.equal(0n);
    } else {
        // Residue beyond the basis is profit already withdrawn; it must survive
        // as carry so the eventual close still charges a fee on it.
        expect(newBasisUsd6).to.equal(0n);
        expect(newCarryUsd6).to.equal(residualUsd6 - previousBasis);
    }
    return newBasisUsd6 as bigint;
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

    it("moves real positions in both directions in kind while carrying the basis", async function () {
        const { operator, treasury, safeAddress, uniHandler, aeroHandler, manager } = await deployStack(
            [UNIV3_POOL_PARAM],
            [AERO_POOL_PARAM],
        );

        const { poolAddress: uniPoolAddress, sqrtP: uniSqrtP, tick: uniTick } = await readUniPool(FEE_TIER);
        const uniAlignedTick = Math.floor(uniTick / UNIV3_TICK_SPACING) * UNIV3_TICK_SPACING;
        const { tick: aeroTick } = await readAeroPool();
        const aeroAlignedTick = Math.floor(aeroTick / AERO_TICK_SPACING) * AERO_TICK_SPACING;

        const input = ethers.parseUnits("10", 6);
        const usdc = await fundSafeUsdcFromPool(uniPoolAddress, safeAddress, input);
        const weth = new ethers.Contract(WETH_ADDRESS, ERC20_ABI, ethers.provider);

        const block = await ethers.provider.getBlock("latest");
        const deadline = BigInt(block!.timestamp + 3_600);
        const opened = await openUniV3(
            manager,
            operator,
            safeAddress,
            input,
            uniSqrtP,
            UNIV3_POOL_PARAM,
            uniAlignedTick - 1_000,
            uniAlignedTick + 1_000,
            deadline,
        );
        const oldTokenId = opened.args.tokenId;
        const initialBasis = await manager.residualBasisUsd6Of(UNISWAP_V3, oldTokenId);
        expect(initialBasis).to.be.greaterThan(0);

        const safeWethBefore = await weth.balanceOf(safeAddress);
        const safeUsdcBefore = await usdc.balanceOf(safeAddress);

        await expect(
            manager
                .connect(operator)
                .switchLp(
                    UNISWAP_V3,
                    AERODROME,
                    switchParams(
                        safeAddress,
                        oldTokenId,
                        aeroAlignedTick - 1_000,
                        aeroAlignedTick + 1_000,
                        AERO_POOL_PARAM,
                        deadline,
                    ),
                ),
        ).to.emit(manager, "PositionSwitched");

        const switched = await lastSwitched(manager, safeAddress);
        const newTokenId = switched.args.newTokenId;
        // In kind: every withdrawn token either entered the new LP or stayed in
        // the Safe as residue. The basis rides along MINUS that residue —
        // `expectResidueConserved` below pins the exact split.
        expect(switched.args.carriedBasisUsd6).to.be.lessThanOrEqual(initialBasis);
        expect(switched.args.withdrawn0).to.be.greaterThan(0);
        expect(switched.args.withdrawn1).to.be.greaterThan(0);
        expect(switched.args.used0).to.be.lessThanOrEqual(switched.args.withdrawn0);
        expect(switched.args.used1).to.be.lessThanOrEqual(switched.args.withdrawn1);
        expect((await weth.balanceOf(safeAddress)) - safeWethBefore).to.equal(
            switched.args.withdrawn0 - switched.args.used0,
        );
        expect((await usdc.balanceOf(safeAddress)) - safeUsdcBefore).to.equal(
            switched.args.withdrawn1 - switched.args.used1,
        );

        const uniNpm = new ethers.Contract(UNISWAP_V3_NPM_ADDRESS, NPM_ABI, ethers.provider);
        const aeroNpm = new ethers.Contract(AERODROME_SLIPSTREAM_NPM_ADDRESS, NPM_ABI, ethers.provider);
        await expect(uniNpm.ownerOf(oldTokenId)).to.be.reverted;
        expect(await aeroNpm.ownerOf(newTokenId)).to.equal(safeAddress);

        expect(await manager.residualBasisUsd6Of(UNISWAP_V3, oldTokenId)).to.equal(0);
        const basisAfterSwitch = await expectResidueConserved(manager, safeAddress, initialBasis);
        expect(await manager.residualBasisUsd6Of(AERODROME, newTokenId)).to.equal(basisAfterSwitch);
        expect(await manager.positionHandlerOf(AERODROME, newTokenId)).to.equal(await aeroHandler.getAddress());
        expect(await usdc.balanceOf(treasury.address)).to.equal(0);

        // Make the replacement genuinely profitable, then prove the final
        // close charges the lifecycle profit (switch residue + final value -
        // original basis). Snapshot/revert keeps the reverse-switch coverage
        // below independent from this economic assertion.
        const profitableCloseSnapshot = await network.provider.send("evm_snapshot");
        const residueEvents = await manager.queryFilter(manager.filters.SwitchResidueSettled(safeAddress), -5);
        const firstResidue = residueEvents[residueEvents.length - 1];
        const aeroBefore = await readAeroPool();
        await pushAeroSpotUp(uniPoolAddress, ethers.parseUnits("1000000", 6));
        const aeroAfter = await readAeroPool();
        expect(aeroAfter.tick).to.be.greaterThan(aeroBefore.tick + 100);

        const treasuryBeforeClose: bigint = await usdc.balanceOf(treasury.address);
        const closeReceipt = await (
            await manager.connect(operator).closeLp(AERODROME, {
                onBehalfOf: safeAddress,
                tokenId: newTokenId,
                exitBps: 10_000,
                swap0: leg(0, AERO_POOL_PARAM),
                swap1: ZERO_LEG,
                slippageBps: 300,
                decreaseAmount0Min: 0,
                decreaseAmount1Min: 0,
                deadline,
                minUsdcOut: 0,
            })
        ).wait();
        const parsedCloseLogs = closeReceipt!.logs.map((log: any) => {
            try {
                return manager.interface.parseLog(log);
            } catch {
                return null;
            }
        });
        const closed = parsedCloseLogs.find((event: any) => event?.name === "PositionClosed")!;
        const collected = parsedCloseLogs.find((event: any) => event?.name === "FeesCollected")!;
        const lifecycleProfit = closed.args.currentValueUsd6 + firstResidue.args.residualUsd6 - initialBasis;
        const expectedPerformanceFee = (lifecycleProfit * 1_000n) / 10_000n;
        expect(lifecycleProfit).to.be.greaterThan(0n);
        expect(closed.args.feeUsd6).to.equal(expectedPerformanceFee);
        const usdcCollectFee =
            collected.args.token0.toLowerCase() === USDC_ADDRESS.toLowerCase()
                ? collected.args.fee0
                : collected.args.fee1;
        expect((await usdc.balanceOf(treasury.address)) - treasuryBeforeClose).to.equal(
            expectedPerformanceFee + usdcCollectFee,
        );
        expect(await network.provider.send("evm_revert", [profitableCloseSnapshot])).to.equal(true);

        // Reverse composition: Aerodrome withdraw followed by Uniswap V3 open.
        await expect(
            manager
                .connect(operator)
                .switchLp(
                    AERODROME,
                    UNISWAP_V3,
                    switchParams(
                        safeAddress,
                        newTokenId,
                        uniAlignedTick - 1_000,
                        uniAlignedTick + 1_000,
                        UNIV3_POOL_PARAM,
                        deadline,
                    ),
                ),
        ).to.emit(manager, "PositionSwitched");

        const reverse = await lastSwitched(manager, safeAddress);
        const reverseTokenId = reverse.args.newTokenId;
        expect(reverse.args.carriedBasisUsd6).to.be.lessThanOrEqual(initialBasis);
        await expect(aeroNpm.ownerOf(newTokenId)).to.be.reverted;
        expect(await uniNpm.ownerOf(reverseTokenId)).to.equal(safeAddress);
        expect(await manager.residualBasisUsd6Of(AERODROME, newTokenId)).to.equal(0);
        const basisAfterReverse = await expectResidueConserved(manager, safeAddress, basisAfterSwitch);
        expect(await manager.residualBasisUsd6Of(UNISWAP_V3, reverseTokenId)).to.equal(basisAfterReverse);
        expect(await manager.positionHandlerOf(UNISWAP_V3, reverseTokenId)).to.equal(await uniHandler.getAddress());
        expect(await usdc.balanceOf(treasury.address)).to.equal(0);
    });

    it("switches between Uniswap V3 fee tiers (0.3% -> 0.05%) in kind carrying the basis", async function () {
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
        const opened = await openUniV3(
            manager,
            operator,
            safeAddress,
            input,
            from.sqrtP,
            UNIV3_POOL_PARAM_3000,
            fromAlignedTick - 1_020,
            fromAlignedTick + 1_020,
            deadline,
        );
        const oldTokenId = opened.args.tokenId;
        const initialBasis = await manager.residualBasisUsd6Of(UNISWAP_V3, oldTokenId);
        expect(initialBasis).to.be.greaterThan(0);

        await expect(
            manager
                .connect(operator)
                .switchLp(
                    UNISWAP_V3,
                    UNISWAP_V3,
                    switchParams(
                        safeAddress,
                        oldTokenId,
                        toAlignedTick - 1_000,
                        toAlignedTick + 1_000,
                        UNIV3_POOL_PARAM,
                        deadline,
                    ),
                ),
        ).to.emit(manager, "PositionSwitched");

        const switched = await lastSwitched(manager, safeAddress);
        const newTokenId = switched.args.newTokenId;
        expect(newTokenId).to.not.equal(oldTokenId);
        expect(switched.args.fromProtocol).to.equal(UNISWAP_V3);
        expect(switched.args.toProtocol).to.equal(UNISWAP_V3);
        expect(switched.args.carriedBasisUsd6).to.be.lessThanOrEqual(initialBasis);

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
        const basisAfterSwitch = await expectResidueConserved(manager, safeAddress, initialBasis);
        expect(await manager.residualBasisUsd6Of(UNISWAP_V3, newTokenId)).to.equal(basisAfterSwitch);
        expect(await manager.positionHandlerOf(UNISWAP_V3, newTokenId)).to.equal(await uniHandler.getAddress());
        expect(await usdc.balanceOf(treasury.address)).to.equal(0);
    });

    it("moves real positions between Uniswap V3 and Uniswap V4 in both directions in kind", async function () {
        const { operator, treasury, safeAddress, uniHandler, v4Handler, manager } = await deployStack(
            [UNIV3_POOL_PARAM],
            [AERO_POOL_PARAM],
        );

        const { poolAddress: uniPoolAddress, sqrtP: uniSqrtP, tick: uniTick } = await readUniPool(FEE_TIER);
        const uniAlignedTick = Math.floor(uniTick / UNIV3_TICK_SPACING) * UNIV3_TICK_SPACING;
        const { tick: v4Tick } = await readV4Pool();
        const v4AlignedTick = Math.floor(v4Tick / UNIV4_TICK_SPACING) * UNIV4_TICK_SPACING;

        const input = ethers.parseUnits("10", 6);
        const usdc = await fundSafeUsdcFromPool(uniPoolAddress, safeAddress, input);

        const block = await ethers.provider.getBlock("latest");
        const deadline = BigInt(block!.timestamp + 3_600);
        const opened = await openUniV3(
            manager,
            operator,
            safeAddress,
            input,
            uniSqrtP,
            UNIV3_POOL_PARAM,
            uniAlignedTick - 1_000,
            uniAlignedTick + 1_000,
            deadline,
        );
        const oldTokenId = opened.args.tokenId;
        const initialBasis = await manager.residualBasisUsd6Of(UNISWAP_V3, oldTokenId);
        expect(initialBasis).to.be.greaterThan(0);

        // V3 -> native V4: the withdrawn WETH is unwrapped to ETH inside the
        // V4 handler's in-kind open leg.
        await expect(
            manager
                .connect(operator)
                .switchLp(
                    UNISWAP_V3,
                    UNISWAP_V4,
                    switchParams(
                        safeAddress,
                        oldTokenId,
                        v4AlignedTick - 1_000,
                        v4AlignedTick + 1_000,
                        UNIV4_POOL_PARAM,
                        deadline,
                    ),
                ),
        ).to.emit(manager, "PositionSwitched");

        const switched = await lastSwitched(manager, safeAddress);
        const v4TokenId = switched.args.newTokenId;
        expect(switched.args.carriedBasisUsd6).to.be.lessThanOrEqual(initialBasis);

        const uniNpm = new ethers.Contract(UNISWAP_V3_NPM_ADDRESS, NPM_ABI, ethers.provider);
        const v4Pm = new ethers.Contract(UNISWAP_V4_POSITION_MANAGER_ADDRESS, V4_PM_ABI, ethers.provider);
        await expect(uniNpm.ownerOf(oldTokenId)).to.be.reverted;
        expect(await v4Pm.ownerOf(v4TokenId)).to.equal(safeAddress);
        expect(await v4Pm.getPositionLiquidity(v4TokenId)).to.be.greaterThan(0);
        expect(await manager.residualBasisUsd6Of(UNISWAP_V3, oldTokenId)).to.equal(0);
        const basisAfterSwitch = await expectResidueConserved(manager, safeAddress, initialBasis);
        expect(await manager.residualBasisUsd6Of(UNISWAP_V4, v4TokenId)).to.equal(basisAfterSwitch);
        expect(await manager.positionHandlerOf(UNISWAP_V4, v4TokenId)).to.equal(await v4Handler.getAddress());
        expect(await usdc.balanceOf(treasury.address)).to.equal(0);

        // Back leg: native V4 -> V3 wraps the withdrawn ETH into WETH.
        await expect(
            manager
                .connect(operator)
                .switchLp(
                    UNISWAP_V4,
                    UNISWAP_V3,
                    switchParams(
                        safeAddress,
                        v4TokenId,
                        uniAlignedTick - 1_000,
                        uniAlignedTick + 1_000,
                        UNIV3_POOL_PARAM,
                        deadline,
                    ),
                ),
        ).to.emit(manager, "PositionSwitched");

        const back = await lastSwitched(manager, safeAddress);
        const backTokenId = back.args.newTokenId;
        expect(back.args.fromProtocol).to.equal(UNISWAP_V4);
        expect(back.args.toProtocol).to.equal(UNISWAP_V3);
        expect(back.args.carriedBasisUsd6).to.be.lessThanOrEqual(initialBasis);
        await expect(v4Pm.ownerOf(v4TokenId)).to.be.reverted;
        expect(await uniNpm.ownerOf(backTokenId)).to.equal(safeAddress);
        expect(await manager.residualBasisUsd6Of(UNISWAP_V4, v4TokenId)).to.equal(0);
        const basisAfterBack = await expectResidueConserved(manager, safeAddress, basisAfterSwitch);
        expect(await manager.residualBasisUsd6Of(UNISWAP_V3, backTokenId)).to.equal(basisAfterBack);
        expect(await manager.positionHandlerOf(UNISWAP_V3, backTokenId)).to.equal(await uniHandler.getAddress());
        expect(await usdc.balanceOf(treasury.address)).to.equal(0);
    });

    it("moves real positions between Aerodrome and Uniswap V4 in both directions in kind", async function () {
        const { operator, treasury, safeAddress, aeroHandler, v4Handler, manager } = await deployStack(
            [UNIV3_POOL_PARAM],
            [AERO_POOL_PARAM],
        );

        const { poolAddress: uniPoolAddress } = await readUniPool(FEE_TIER);
        const { sqrtP: aeroSqrtP, tick: aeroTick } = await readAeroPool();
        const aeroAlignedTick = Math.floor(aeroTick / AERO_TICK_SPACING) * AERO_TICK_SPACING;
        const { tick: v4Tick } = await readV4Pool();
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
                swap0: leg((openExpectedOut * 9_700n) / 10_000n, AERO_POOL_PARAM),
                swap1: ZERO_LEG,
                slippageBps: 300,
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

        await expect(
            manager
                .connect(operator)
                .switchLp(
                    AERODROME,
                    UNISWAP_V4,
                    switchParams(
                        safeAddress,
                        oldTokenId,
                        v4AlignedTick - 1_000,
                        v4AlignedTick + 1_000,
                        UNIV4_POOL_PARAM,
                        deadline,
                    ),
                ),
        ).to.emit(manager, "PositionSwitched");

        const switched = await lastSwitched(manager, safeAddress);
        const v4TokenId = switched.args.newTokenId;
        expect(switched.args.carriedBasisUsd6).to.be.lessThanOrEqual(initialBasis);

        const aeroNpm = new ethers.Contract(AERODROME_SLIPSTREAM_NPM_ADDRESS, NPM_ABI, ethers.provider);
        const v4Pm = new ethers.Contract(UNISWAP_V4_POSITION_MANAGER_ADDRESS, V4_PM_ABI, ethers.provider);
        await expect(aeroNpm.ownerOf(oldTokenId)).to.be.reverted;
        expect(await v4Pm.ownerOf(v4TokenId)).to.equal(safeAddress);
        expect(await v4Pm.getPositionLiquidity(v4TokenId)).to.be.greaterThan(0);
        expect(await manager.residualBasisUsd6Of(AERODROME, oldTokenId)).to.equal(0);
        const basisAfterSwitch = await expectResidueConserved(manager, safeAddress, initialBasis);
        expect(await manager.residualBasisUsd6Of(UNISWAP_V4, v4TokenId)).to.equal(basisAfterSwitch);
        expect(await manager.positionHandlerOf(UNISWAP_V4, v4TokenId)).to.equal(await v4Handler.getAddress());
        expect(await usdc.balanceOf(treasury.address)).to.equal(0);

        await expect(
            manager
                .connect(operator)
                .switchLp(
                    UNISWAP_V4,
                    AERODROME,
                    switchParams(
                        safeAddress,
                        v4TokenId,
                        aeroAlignedTick - 1_000,
                        aeroAlignedTick + 1_000,
                        AERO_POOL_PARAM,
                        deadline,
                    ),
                ),
        ).to.emit(manager, "PositionSwitched");

        const back = await lastSwitched(manager, safeAddress);
        const backTokenId = back.args.newTokenId;
        expect(back.args.fromProtocol).to.equal(UNISWAP_V4);
        expect(back.args.toProtocol).to.equal(AERODROME);
        expect(back.args.carriedBasisUsd6).to.be.lessThanOrEqual(initialBasis);
        await expect(v4Pm.ownerOf(v4TokenId)).to.be.reverted;
        expect(await aeroNpm.ownerOf(backTokenId)).to.equal(safeAddress);
        expect(await manager.residualBasisUsd6Of(UNISWAP_V4, v4TokenId)).to.equal(0);
        const basisAfterBack = await expectResidueConserved(manager, safeAddress, basisAfterSwitch);
        expect(await manager.residualBasisUsd6Of(AERODROME, backTokenId)).to.equal(basisAfterBack);
        expect(await manager.positionHandlerOf(AERODROME, backTokenId)).to.equal(await aeroHandler.getAddress());
        expect(await usdc.balanceOf(treasury.address)).to.equal(0);
    });
});
