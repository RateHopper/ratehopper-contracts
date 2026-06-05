import { expect } from "chai";
import { ethers, network } from "hardhat";
import dotenv from "dotenv";
dotenv.config();
import Safe from "@safe-global/protocol-kit";
import { MetaTransactionData, OperationType } from "@safe-global/types-kit";

import {
    PARASWAP_V6_CONTRACT_ADDRESS,
    Protocols,
    UNISWAP_V3_FACTORY_ADDRESS,
    UNISWAP_V3_SWAP_ROUTER_ADDRESS,
    USDC_ADDRESS,
    WETH_ADDRESS,
} from "./constants";
import { FLUID_VAULT_RESOLVER, FLUID_WETH_USDC_VAULT, FluidHelper } from "./protocols/fluid";
import { eip1193Provider, fundSignerWithETH } from "./utils";
import FluidVaultAbi from "../externalAbi/fluid/fluidVaultT1.json";

// ─────────────────────────────────────────────────────────────────────────
//  Real Base mainnet contract addresses
// ─────────────────────────────────────────────────────────────────────────

const UNISWAP_V3_NPM_ADDRESS = "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1";
const WETH_USDC_500_POOL = "0xd0b53D9277642d899DF5C87A3966A349A798F224";

const safeAddress = process.env.TESTING_SAFE_WALLET_ADDRESS!;

// Fee config
const MAX_FEE_BPS = 2000;
const PERFORMANCE_FEE_BPS = 1000; // 10% — performance fee on net profit at closeLp
const COLLECT_FEE_BPS = 250; // 2.5% on collected LP fees
const SLIPPAGE_BPS = 100; // 1% — per-call slippage tolerance for openLp/closeLp swaps

// Sentinel for the L-5 expectedSwapOut argument. Tests pass
// `swapAmountOutMin = 1n`, and with `expectedSwapOut = 1n` the relationship
// `1 >= (1 * (10_000 - SLIPPAGE_BPS)) / 10_000` is satisfied for any
// `SLIPPAGE_BPS > 0`. Production callers must supply a real quoter-derived
// value here.
const EXPECTED_SWAP_OUT = 1n;

// Deadline passed to openLp / closeLp in tests. Uses MaxUint256 so the
// staleness check never fires unintentionally.
const FAR_DEADLINE = ethers.MaxUint256;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// ─────────────────────────────────────────────────────────────────────────
//  Minimal ABIs (only what we need)
// ─────────────────────────────────────────────────────────────────────────

const NPM_ABI = [
    "function ownerOf(uint256) view returns (address)",
    "function balanceOf(address) view returns (uint256)",
    "function approve(address,uint256)",
    "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
    "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
    "function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) payable returns (uint256 amount0, uint256 amount1)",
    "function transferFrom(address from, address to, uint256 tokenId)",
];

const WETH_ABI = [
    "function deposit() payable",
    "function withdraw(uint256)",
    "function approve(address,uint256) returns (bool)",
    "function balanceOf(address) view returns (uint256)",
];

const ERC20_VIEW_ABI = ["function balanceOf(address) view returns (uint256)"];

const UNISWAP_V3_FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];

const UNISWAP_V3_POOL_ABI = [
    "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
];

// ─────────────────────────────────────────────────────────────────────────
//  Fixture — deploys ProtocolRegistry + FluidSafeHandler + SafeDebtManager +
//  RatehopperUniV3Positions. RHP gates openLp/closeLp/collectLp on
//  `onlyOperatorOrSafe` (Safe self-call OR the registry's `safeOperator`).
//  All NPM/SwapRouter calls inside RHP are module-mediated via the Safe, so
//  RHP itself does NOT need to be the registry's `safeOperator` — that slot
//  stays free for the backend EOA driving closes on the Safe's behalf.
// ─────────────────────────────────────────────────────────────────────────

async function deployFixture() {
    const [deployer, _signer1, _signer2, pauser, treasury] = await ethers.getSigners();

    // Use deployer as both initialAdmin AND timelock so we get CRITICAL_ROLE
    // immediately (no TimelockController indirection) and can call
    // setOperator() to register RHP.
    const ProtocolRegistry = await ethers.getContractFactory("ProtocolRegistry");
    const protocolRegistry = await ProtocolRegistry.deploy(
        WETH_ADDRESS,
        UNISWAP_V3_FACTORY_ADDRESS,
        deployer.address,
        deployer.address,
        deployer.address,
        PARASWAP_V6_CONTRACT_ADDRESS,
    );
    await protocolRegistry.waitForDeployment();

    await (await protocolRegistry.addToWhitelistBatch([WETH_ADDRESS, USDC_ADDRESS])).wait();
    await (await protocolRegistry.setFluidVaultResolver(FLUID_VAULT_RESOLVER)).wait();

    const FluidSafeHandler = await ethers.getContractFactory("FluidSafeHandler");
    const fluidHandler = await FluidSafeHandler.deploy(UNISWAP_V3_FACTORY_ADDRESS, await protocolRegistry.getAddress());
    await fluidHandler.waitForDeployment();

    const SafeDebtManager = await ethers.getContractFactory("SafeDebtManager");
    const safeDebtManager = await SafeDebtManager.deploy(
        await protocolRegistry.getAddress(),
        [Protocols.FLUID],
        [await fluidHandler.getAddress()],
        pauser.address,
    );
    await safeDebtManager.waitForDeployment();

    const RHP = await ethers.getContractFactory("RatehopperUniV3Positions");
    const rhp = await RHP.deploy(
        UNISWAP_V3_NPM_ADDRESS,
        await protocolRegistry.getAddress(),
        USDC_ADDRESS,
        WETH_ADDRESS,
        UNISWAP_V3_SWAP_ROUTER_ADDRESS,
        UNISWAP_V3_FACTORY_ADDRESS,
        treasury.address,
        PERFORMANCE_FEE_BPS,
        COLLECT_FEE_BPS,
        MAX_FEE_BPS,
        deployer.address, // _initialAdmin
        deployer.address, // _timelock (for tests, deployer holds both roles)
    );
    await rhp.waitForDeployment();

    return { deployer, pauser, treasury, protocolRegistry, fluidHandler, safeDebtManager, rhp };
}

// Inlined Fluid supply+borrow helper. We don't import from debtSwapBySafe.ts
// because that file is both a library and a test file — importing it would
// register all its describe/it blocks with mocha and run them every time
// this file is executed.
async function supplyAndBorrowOnFluid(
    signer: ethers.Wallet,
    safeWallet: any,
    vaultAddress: string,
    supplyAmount: bigint,
    borrowAmount: bigint,
) {
    // 1. Send ETH directly to the Safe; Fluid accepts native ETH for the
    //    WETH/USDC vault and wraps internally.
    const seedTx = await signer.sendTransaction({ to: safeAddress, value: supplyAmount });
    await seedTx.wait();

    const fluidVault = new ethers.Contract(vaultAddress, FluidVaultAbi, signer);

    // 2. Supply: operate(nftId=0, newCol=+supplyAmount, newDebt=0, to=Safe)
    const supplyTx: MetaTransactionData = {
        to: vaultAddress,
        value: supplyAmount.toString(),
        data: fluidVault.interface.encodeFunctionData("operate", [0, supplyAmount, 0, safeAddress]),
        operation: OperationType.Call,
    };
    await safeWallet.executeTransaction(await safeWallet.createTransaction({ transactions: [supplyTx] }));

    // 3. Query the Fluid vault for the just-created NFT id.
    const fluidHelper = new FluidHelper(signer);
    const nftId = await fluidHelper.getNftId(vaultAddress, safeAddress);

    // 4. Borrow: operate(nftId, newCol=0, newDebt=+borrowAmount, to=Safe).
    //    Borrowed USDC stays on the Safe.
    const borrowTx: MetaTransactionData = {
        to: vaultAddress,
        value: "0",
        data: fluidVault.interface.encodeFunctionData("operate", [nftId, 0, borrowAmount, safeAddress]),
        operation: OperationType.Call,
    };
    await safeWallet.executeTransaction(await safeWallet.createTransaction({ transactions: [borrowTx] }));
}

// Reads the WETH/USDC 500-bps pool's current tick and returns a wide,
// spacing-aligned range centred on it — so an LP minted here holds both legs
// (in range) rather than being one-sided.
async function wideTicksAroundSpot(): Promise<{ tickLower: number; tickUpper: number }> {
    const pool = new ethers.Contract(WETH_USDC_500_POOL, UNISWAP_V3_POOL_ABI, ethers.provider);
    const currentTick = Number((await pool.slot0()).tick);
    const spacing = 10;
    return {
        tickLower: Math.floor((currentTick - 5_000) / spacing) * spacing,
        tickUpper: Math.ceil((currentTick + 5_000) / spacing) * spacing,
    };
}

// Enable RHP as a module, run a Fluid supply+borrow, then open a balanced
// in-range LP via openLp. Returns the minted tokenId. Shared by the
// performance-fee tests.
async function openBalancedPosition(
    rhp: any,
    safeWallet: any,
    signer: ethers.Wallet,
    supplyEth: bigint,
    borrowUsdc: bigint,
): Promise<bigint> {
    const rhpAddress = await rhp.getAddress();
    await safeWallet.executeTransaction(await safeWallet.createEnableModuleTx(rhpAddress));
    await supplyAndBorrowOnFluid(signer, safeWallet, FLUID_WETH_USDC_VAULT, supplyEth, borrowUsdc);

    const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_VIEW_ABI, ethers.provider);
    const usdcAmount = await usdc.balanceOf(safeAddress);
    const { tickLower, tickUpper } = await wideTicksAroundSpot();

    await safeWallet.executeTransaction(
        await safeWallet.createTransaction({
            transactions: [
                {
                    to: rhpAddress,
                    value: "0",
                    data: rhp.interface.encodeFunctionData("openLp", [
                        safeAddress,
                        usdcAmount,
                        tickLower,
                        tickUpper,
                        500,
                         0,
                         0,
                        500,
                        1n,
                        EXPECTED_SWAP_OUT,
                        SLIPPAGE_BPS,
                        FAR_DEADLINE,
                    ]),
                    operation: OperationType.Call,
                },
            ],
        }),
    );
    const opened = await rhp.queryFilter(rhp.filters.PositionOpened(safeAddress), -10);
    return opened[opened.length - 1].args.tokenId as bigint;
}

// Run closeLp via the Safe with the given baseline (performanceFeeBps already set on the
// contract). Returns the PositionClosed event values + treasury/Safe USDC
// deltas across the call. Since the position is opened and closed in the same
// test with no external pool volume, accrued trading fees are ~0 — so the
// treasury USDC delta isolates the performance fee.
async function closeAndMeasure(
    rhp: any,
    safeWallet: any,
    treasuryAddr: string,
    tokenId: bigint,
    exitBps: number = 10_000,
): Promise<{
    basisUsd6: bigint;
    currentValueUsd6: bigint;
    feeUsd6: bigint;
    treasuryDelta: bigint;
    safeDelta: bigint;
    exitBpsEmitted: number;
}> {
    const rhpAddress = await rhp.getAddress();
    const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_VIEW_ABI, ethers.provider);
    const tBefore: bigint = await usdc.balanceOf(treasuryAddr);
    const sBefore: bigint = await usdc.balanceOf(safeAddress);

    await safeWallet.executeTransaction(
        await safeWallet.createTransaction({
            transactions: [
                {
                    to: rhpAddress,
                    value: "0",
                    data: rhp.interface.encodeFunctionData("closeLp", [
                        safeAddress,
                        tokenId,
                        500,
                        1n,
                        EXPECTED_SWAP_OUT,
                        SLIPPAGE_BPS,
                        exitBps,
                        0,
                        0,
                        FAR_DEADLINE,
                        0, // minUsdcOut — disabled
                    ]),
                    operation: OperationType.Call,
                },
            ],
        }),
    );
    const ev = (await rhp.queryFilter(rhp.filters.PositionClosed(safeAddress, tokenId), -10)).slice(-1)[0].args;
    return {
        basisUsd6: ev.basisUsd6 as bigint,
        currentValueUsd6: ev.currentValueUsd6 as bigint,
        feeUsd6: ev.feeUsd6 as bigint,
        treasuryDelta: ((await usdc.balanceOf(treasuryAddr)) as bigint) - tBefore,
        safeDelta: ((await usdc.balanceOf(safeAddress)) as bigint) - sBefore,
        exitBpsEmitted: Number(ev.exitBps),
    };
}

// ─────────────────────────────────────────────────────────────────────────
//  Unit tests — pure contract logic, no fork dependencies on Uniswap/Fluid
// ─────────────────────────────────────────────────────────────────────────

describe("RatehopperUniV3Positions - constructor", function () {
    it("stores the immutables and initial mutables", async function () {
        const { rhp, deployer, treasury, protocolRegistry } = await deployFixture();
        expect(await rhp.POSITION_MANAGER()).to.equal(UNISWAP_V3_NPM_ADDRESS);
        expect(await rhp.REGISTRY()).to.equal(await protocolRegistry.getAddress());
        expect(await rhp.USDC()).to.equal(USDC_ADDRESS);
        expect(await rhp.SWAP_ROUTER()).to.equal(UNISWAP_V3_SWAP_ROUTER_ADDRESS);
        expect(await rhp.UNISWAP_V3_FACTORY()).to.equal(UNISWAP_V3_FACTORY_ADDRESS);
        expect(await rhp.MAX_FEE_BPS()).to.equal(MAX_FEE_BPS);
        expect(await rhp.timelock()).to.equal(deployer.address);
        expect(await rhp.treasury()).to.equal(treasury.address);
        expect(await rhp.performanceFeeBps()).to.equal(PERFORMANCE_FEE_BPS);
        expect(await rhp.feeCollectBps()).to.equal(COLLECT_FEE_BPS);
        expect(await rhp.maxSlippageBps()).to.equal(300);
        expect(await rhp.MAX_SETTABLE_SLIPPAGE_BPS()).to.equal(1000);
        expect(await rhp.allowedFeeTier(100)).to.equal(true);
        expect(await rhp.allowedFeeTier(500)).to.equal(true);
        expect(await rhp.allowedFeeTier(3000)).to.equal(true);
        expect(await rhp.allowedFeeTier(10000)).to.equal(false);
        expect(await rhp.minPoolLiquidity()).to.equal(0n); // H-01 default: disabled
        expect(await rhp.minPositionLiquidity()).to.equal(0n); // L-2 default: disabled
        // CRITICAL_ROLE is self-administered to prevent DEFAULT_ADMIN_ROLE bypass.
        const CRITICAL_ROLE = await rhp.CRITICAL_ROLE();
        expect(await rhp.getRoleAdmin(CRITICAL_ROLE)).to.equal(CRITICAL_ROLE);
    });

    it("reverts on zero addresses and on performanceFeeBps / feeCollectBps > maxFeeBps", async function () {
        const { treasury, protocolRegistry } = await deployFixture();
        const F = await ethers.getContractFactory("RatehopperUniV3Positions");
        const registryAddr = await protocolRegistry.getAddress();
        const [deployer] = await ethers.getSigners();

        // Build constructor args with one override at a time so each
        // zero-address slot is exercised independently.
        const defaults = {
            positionManager: UNISWAP_V3_NPM_ADDRESS as string,
            registry: registryAddr,
            usdc: USDC_ADDRESS as string,
            weth: WETH_ADDRESS as string,
            swapRouter: UNISWAP_V3_SWAP_ROUTER_ADDRESS as string,
            uniswapV3Factory: UNISWAP_V3_FACTORY_ADDRESS as string,
            treasury: treasury.address,
            performanceFeeBps: PERFORMANCE_FEE_BPS as number,
            feeCollectBps: COLLECT_FEE_BPS as number,
            maxFeeBps: MAX_FEE_BPS as number,
            initialAdmin: deployer.address,
            timelock: deployer.address,
        };
        const build = (o: Partial<typeof defaults> = {}): any[] => {
            const m = { ...defaults, ...o };
            return [
                m.positionManager,
                m.registry,
                m.usdc,
                m.weth,
                m.swapRouter,
                m.uniswapV3Factory,
                m.treasury,
                m.performanceFeeBps,
                m.feeCollectBps,
                m.maxFeeBps,
                m.initialAdmin,
                m.timelock,
            ];
        };

        await expect(F.deploy(...build({ positionManager: ZERO_ADDRESS }))).to.be.revertedWithCustomError(
            F,
            "ZeroAddress",
        );
        await expect(F.deploy(...build({ registry: ZERO_ADDRESS }))).to.be.revertedWithCustomError(F, "ZeroAddress");
        await expect(F.deploy(...build({ usdc: ZERO_ADDRESS }))).to.be.revertedWithCustomError(F, "ZeroAddress");
        await expect(F.deploy(...build({ weth: ZERO_ADDRESS }))).to.be.revertedWithCustomError(F, "ZeroAddress");
        await expect(F.deploy(...build({ swapRouter: ZERO_ADDRESS }))).to.be.revertedWithCustomError(F, "ZeroAddress");
        await expect(F.deploy(...build({ uniswapV3Factory: ZERO_ADDRESS }))).to.be.revertedWithCustomError(
            F,
            "ZeroAddress",
        );
        await expect(F.deploy(...build({ treasury: ZERO_ADDRESS }))).to.be.revertedWithCustomError(
            F,
            "InvalidTreasury",
        );
        await expect(F.deploy(...build({ performanceFeeBps: MAX_FEE_BPS + 1 }))).to.be.revertedWithCustomError(
            F,
            "FeeAboveMax",
        );
        await expect(F.deploy(...build({ feeCollectBps: MAX_FEE_BPS + 1 }))).to.be.revertedWithCustomError(
            F,
            "FeeAboveMax",
        );

        // M-03: swap WETH/USDC slots so weth address > usdc address, must revert.
        await expect(
            F.deploy(...build({ usdc: WETH_ADDRESS, weth: USDC_ADDRESS })),
        ).to.be.revertedWithCustomError(F, "WrongTokenOrder");
    });
});

describe("RatehopperUniV3Positions - owner setters", function () {
    it("setTreasury emits, validates, and rejects non-owner", async function () {
        const { rhp, deployer, treasury } = await deployFixture();
        const [, other] = await ethers.getSigners();

        await expect(rhp.connect(deployer).setTreasury(other.address))
            .to.emit(rhp, "TreasuryUpdated")
            .withArgs(treasury.address, other.address);
        expect(await rhp.treasury()).to.equal(other.address);

        await expect(rhp.connect(deployer).setTreasury(ZERO_ADDRESS)).to.be.revertedWithCustomError(
            rhp,
            "InvalidTreasury",
        );
        await expect(rhp.connect(other).setTreasury(other.address)).to.be.revertedWithCustomError(
            rhp,
            "AccessControlUnauthorizedAccount",
        );
    });

    it("setPerformanceFeeBps emits, validates the cap, and rejects non-owner", async function () {
        const { rhp, deployer } = await deployFixture();
        const [, other] = await ethers.getSigners();

        await expect(rhp.connect(deployer).setPerformanceFeeBps(500))
            .to.emit(rhp, "PerformanceFeeBpsUpdated")
            .withArgs(PERFORMANCE_FEE_BPS, 500);
        expect(await rhp.performanceFeeBps()).to.equal(500);

        await expect(rhp.connect(deployer).setPerformanceFeeBps(MAX_FEE_BPS + 1)).to.be.revertedWithCustomError(
            rhp,
            "FeeAboveMax",
        );
        await expect(rhp.connect(other).setPerformanceFeeBps(100)).to.be.revertedWithCustomError(
            rhp,
            "AccessControlUnauthorizedAccount",
        );
    });

    it("setFeeCollectBps emits, validates the cap, and rejects non-owner", async function () {
        const { rhp, deployer } = await deployFixture();
        const [, other] = await ethers.getSigners();

        await expect(rhp.connect(deployer).setFeeCollectBps(500))
            .to.emit(rhp, "FeeCollectBpsUpdated")
            .withArgs(COLLECT_FEE_BPS, 500);
        expect(await rhp.feeCollectBps()).to.equal(500);

        await expect(rhp.connect(deployer).setFeeCollectBps(MAX_FEE_BPS + 1)).to.be.revertedWithCustomError(
            rhp,
            "FeeAboveMax",
        );
        await expect(rhp.connect(other).setFeeCollectBps(100)).to.be.revertedWithCustomError(
            rhp,
            "AccessControlUnauthorizedAccount",
        );
    });

    it("setMaxSlippageBps emits, validates the ceiling, and rejects non-owner", async function () {
        const { rhp, deployer } = await deployFixture();
        const [, other] = await ethers.getSigners();

        await expect(rhp.connect(deployer).setMaxSlippageBps(500))
            .to.emit(rhp, "MaxSlippageBpsUpdated")
            .withArgs(300, 500);
        expect(await rhp.maxSlippageBps()).to.equal(500);

        const ceiling = Number(await rhp.MAX_SETTABLE_SLIPPAGE_BPS());
        await expect(rhp.connect(deployer).setMaxSlippageBps(ceiling + 1)).to.be.revertedWithCustomError(
            rhp,
            "SlippageAboveMax",
        );
        await expect(rhp.connect(other).setMaxSlippageBps(100)).to.be.revertedWithCustomError(
            rhp,
            "AccessControlUnauthorizedAccount",
        );
    });

    it("setFeeTierAllowed emits, flips state both directions, and rejects non-owner", async function () {
        const { rhp, deployer } = await deployFixture();
        const [, other] = await ethers.getSigners();

        expect(await rhp.allowedFeeTier(10000)).to.equal(false);
        await expect(rhp.connect(deployer).setFeeTierAllowed(10000, true))
            .to.emit(rhp, "FeeTierAllowedUpdated")
            .withArgs(10000, false, true);
        expect(await rhp.allowedFeeTier(10000)).to.equal(true);

        await expect(rhp.connect(deployer).setFeeTierAllowed(500, false))
            .to.emit(rhp, "FeeTierAllowedUpdated")
            .withArgs(500, true, false);
        expect(await rhp.allowedFeeTier(500)).to.equal(false);

        await expect(rhp.connect(other).setFeeTierAllowed(100, false)).to.be.revertedWithCustomError(
            rhp,
            "AccessControlUnauthorizedAccount",
        );
    });

    it("setMinPoolLiquidity emits, accepts 0 (disabled), and rejects non-owner", async function () {
        const { rhp, deployer } = await deployFixture();
        const [, other] = await ethers.getSigners();

        const newFloor = 1_000_000n;
        await expect(rhp.connect(deployer).setMinPoolLiquidity(newFloor))
            .to.emit(rhp, "MinPoolLiquidityUpdated")
            .withArgs(0n, newFloor);
        expect(await rhp.minPoolLiquidity()).to.equal(newFloor);

        await expect(rhp.connect(deployer).setMinPoolLiquidity(0n))
            .to.emit(rhp, "MinPoolLiquidityUpdated")
            .withArgs(newFloor, 0n);
        expect(await rhp.minPoolLiquidity()).to.equal(0n);

        await expect(rhp.connect(other).setMinPoolLiquidity(123n)).to.be.revertedWithCustomError(
            rhp,
            "AccessControlUnauthorizedAccount",
        );
    });

    it("setMinPositionLiquidity emits, accepts 0 (disabled), and rejects non-owner", async function () {
        const { rhp, deployer } = await deployFixture();
        const [, other] = await ethers.getSigners();

        const newFloor = 1_000n;
        await expect(rhp.connect(deployer).setMinPositionLiquidity(newFloor))
            .to.emit(rhp, "MinPositionLiquidityUpdated")
            .withArgs(0n, newFloor);
        expect(await rhp.minPositionLiquidity()).to.equal(newFloor);

        await expect(rhp.connect(deployer).setMinPositionLiquidity(0n))
            .to.emit(rhp, "MinPositionLiquidityUpdated")
            .withArgs(newFloor, 0n);
        expect(await rhp.minPositionLiquidity()).to.equal(0n);

        await expect(rhp.connect(other).setMinPositionLiquidity(123n)).to.be.revertedWithCustomError(
            rhp,
            "AccessControlUnauthorizedAccount",
        );
    });

    it("rescueToken transfers a real balance, emits, and rejects zero-address / non-owner", async function () {
        const { rhp, deployer } = await deployFixture();
        const [, other, recipient] = await ethers.getSigners();
        const rhpAddress = await rhp.getAddress();

        // Stage a stuck WETH balance on RHP: signer wraps native ETH to WETH
        // then transfers some to the contract. This simulates a user
        // accidentally sending tokens directly to RHP (the exact case
        // rescueToken is built for).
        const weth = new ethers.Contract(
            WETH_ADDRESS,
            ["function deposit() payable", "function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"],
            deployer,
        );
        const stuckAmount = ethers.parseEther("0.001");
        await (await weth.deposit({ value: stuckAmount })).wait();
        await (await weth.transfer(rhpAddress, stuckAmount)).wait();
        expect(await weth.balanceOf(rhpAddress)).to.equal(stuckAmount);

        const recipBalBefore: bigint = await weth.balanceOf(recipient.address);

        // Happy path: emits TokenRescued, moves the full balance to recipient.
        await expect(rhp.connect(deployer).rescueToken(WETH_ADDRESS, recipient.address, stuckAmount))
            .to.emit(rhp, "TokenRescued")
            .withArgs(WETH_ADDRESS, recipient.address, stuckAmount);
        expect(await weth.balanceOf(rhpAddress)).to.equal(0);
        expect(await weth.balanceOf(recipient.address)).to.equal(recipBalBefore + stuckAmount);

        // Reverts on zero token address.
        await expect(
            rhp.connect(deployer).rescueToken(ZERO_ADDRESS, recipient.address, 0),
        ).to.be.revertedWithCustomError(rhp, "ZeroAddress");

        // Reverts on zero recipient address.
        await expect(
            rhp.connect(deployer).rescueToken(WETH_ADDRESS, ZERO_ADDRESS, 0),
        ).to.be.revertedWithCustomError(rhp, "ZeroAddress");

        // Reverts when called by non-owner.
        await expect(
            rhp.connect(other).rescueToken(WETH_ADDRESS, recipient.address, 0),
        ).to.be.revertedWithCustomError(rhp, "AccessControlUnauthorizedAccount");
    });

    it("setPerformanceFeeBps via TimelockController: rejects direct admin call, accepts scheduled+executed timelock call", async function () {
        const [deployer, proposerExecutor, otherAdmin] = await ethers.getSigners();

        // 1. Reuse the main fixture's registry — saves rebuilding ProtocolRegistry +
        //    handlers just to satisfy the RHP constructor's non-zero registry check.
        const { protocolRegistry } = await deployFixture();
        const registryAddr = await protocolRegistry.getAddress();

        // 2. Deploy a real TimelockController (2-day delay). `proposerExecutor`
        //    EOA is both proposer and executor; no separate admin (the timelock
        //    itself holds DEFAULT_ADMIN_ROLE on itself).
        const MIN_DELAY = 2 * 24 * 60 * 60;
        const Timelock = await ethers.getContractFactory("TimelockController");
        const timelock = await Timelock.deploy(
            MIN_DELAY,
            [proposerExecutor.address],
            [proposerExecutor.address],
            ZERO_ADDRESS,
        );
        await timelock.waitForDeployment();
        const timelockAddr = await timelock.getAddress();

        // 3. Deploy a fresh RHP with `_initialAdmin = otherAdmin` and
        //    `_timelock = timelockAddr`. otherAdmin gets DEFAULT_ADMIN_ROLE
        //    (rescueToken etc.), the timelock holds CRITICAL_ROLE (setters).
        const RHP = await ethers.getContractFactory("RatehopperUniV3Positions");
        const rhpStandalone = await RHP.deploy(
            UNISWAP_V3_NPM_ADDRESS,
            registryAddr,
            USDC_ADDRESS,
            WETH_ADDRESS,
            UNISWAP_V3_SWAP_ROUTER_ADDRESS,
            UNISWAP_V3_FACTORY_ADDRESS,
            deployer.address, // treasury (any non-zero is fine for this test)
            PERFORMANCE_FEE_BPS,
            COLLECT_FEE_BPS,
            MAX_FEE_BPS,
            otherAdmin.address, // _initialAdmin → DEFAULT_ADMIN_ROLE
            timelockAddr, // _timelock → CRITICAL_ROLE
        );
        await rhpStandalone.waitForDeployment();
        const rhpAddr = await rhpStandalone.getAddress();

        // 4. Direct calls bypassing the timelock are rejected — even the
        //    DEFAULT_ADMIN_ROLE holder cannot tweak fee setters.
        await expect(
            rhpStandalone.connect(otherAdmin).setPerformanceFeeBps(500),
        ).to.be.revertedWithCustomError(rhpStandalone, "AccessControlUnauthorizedAccount");
        await expect(
            rhpStandalone.connect(deployer).setPerformanceFeeBps(500),
        ).to.be.revertedWithCustomError(rhpStandalone, "AccessControlUnauthorizedAccount");

        // 5. Schedule a setPerformanceFeeBps(500) call through the timelock.
        const newFee = 500;
        const callData = rhpStandalone.interface.encodeFunctionData("setPerformanceFeeBps", [newFee]);
        const predecessor = ethers.ZeroHash;
        const salt = ethers.id("test-update-perf-fee");
        const operationId = await timelock.hashOperation(rhpAddr, 0, callData, predecessor, salt);

        await expect(
            timelock.connect(proposerExecutor).schedule(rhpAddr, 0, callData, predecessor, salt, MIN_DELAY),
        ).to.emit(timelock, "CallScheduled");

        // 6. Cannot execute before the delay elapses.
        await expect(
            timelock.connect(proposerExecutor).execute(rhpAddr, 0, callData, predecessor, salt),
        ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");

        // 7. Advance time past the delay.
        await network.provider.send("evm_increaseTime", [MIN_DELAY + 1]);
        await network.provider.send("evm_mine");

        // 8. Execute through the timelock → fee setter fires, fee updates,
        //    event emits with the actual previous value (PERFORMANCE_FEE_BPS).
        await expect(
            timelock.connect(proposerExecutor).execute(rhpAddr, 0, callData, predecessor, salt),
        )
            .to.emit(rhpStandalone, "PerformanceFeeBpsUpdated")
            .withArgs(PERFORMANCE_FEE_BPS, newFee)
            .and.to.emit(timelock, "CallExecuted");

        expect(await rhpStandalone.performanceFeeBps()).to.equal(newFee);

        // 9. Operation is now Done — re-executing reverts (state machine moves
        //    from Waiting → Ready → Done; a Done op cannot be re-executed).
        expect(await timelock.isOperationDone(operationId)).to.equal(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────
//  Integration test — real Base mainnet contracts on the fork
// ─────────────────────────────────────────────────────────────────────────

describe("RatehopperUniV3Positions - integration (Base fork)", function () {
    this.timeout(300_000);

    let signer: ethers.Wallet;
    let safeWallet: Awaited<ReturnType<typeof Safe.init>>;

    beforeEach(async function () {
        if (!process.env.TESTING_SAFE_OWNER_KEY || !process.env.TESTING_SAFE_WALLET_ADDRESS) {
            this.skip();
        }
        // Reset the fork between tests so each starts from a clean Base
        // mainnet snapshot. The env-driven Safe is referenced by address
        // (not redeployed), so without this reset state from one test
        // (e.g. an unrepaid Fluid debt) leaks into the next.
        await network.provider.request({
            method: "hardhat_reset",
            params: [{ forking: { jsonRpcUrl: process.env.BASE_RPC_URL || "https://mainnet.base.org" } }],
        });

        signer = new ethers.Wallet(process.env.TESTING_SAFE_OWNER_KEY!, ethers.provider);
        await fundSignerWithETH(signer.address, "10");
        await fundSignerWithETH(safeAddress, "10");

        safeWallet = await Safe.init({
            provider: eip1193Provider,
            signer: process.env.TESTING_SAFE_OWNER_KEY,
            safeAddress,
        });
    });

    it("closes an LP-backed Fluid debt position end-to-end via openLp + closeLp", async function () {
        const { rhp, safeDebtManager, treasury } = await deployFixture();
        const safeDebtManagerAddress = await safeDebtManager.getAddress();
        const rhpAddress = await rhp.getAddress();

        // Pretty-printers for the running log.
        const usdcCx = new ethers.Contract(USDC_ADDRESS, ERC20_VIEW_ABI, ethers.provider);
        const fmtUsdc = (v: bigint) => `${ethers.formatUnits(v, 6)} USDC`;

        console.log("\n  ─── Deployed addresses ───");
        console.log(`    RatehopperUniV3Positions: ${rhpAddress}`);
        console.log(`    SafeDebtManager:     ${safeDebtManagerAddress}`);
        console.log(`    Safe (env-driven):   ${safeAddress}`);
        console.log(`    Treasury:            ${treasury.address}`);

        // 1. Enable both modules on the Safe: SafeDebtManager (for exit's
        //    token transfer) and RatehopperUniV3Positions (so openLp/closeLp
        //    can drive the LP lifecycle module-mediated, no approvals needed).
        console.log("\n  [1/6] Enable SafeDebtManager + RatehopperUniV3Positions as Safe modules");
        await safeWallet.executeTransaction(await safeWallet.createEnableModuleTx(safeDebtManagerAddress));
        await safeWallet.executeTransaction(await safeWallet.createEnableModuleTx(rhpAddress));
        console.log(`         modules enabled: ${safeDebtManagerAddress}, ${rhpAddress}`);

        // 2. Open a real Fluid debt position: supply 0.01 ETH (auto-wrapped
        //    by the WETH/USDC vault), borrow 10 USDC. Safe ends with 10 USDC
        //    of debt and 10 USDC of free balance — enough for openLp to split.
        console.log("\n  [2/6] Open Fluid debt: supply 0.01 ETH, borrow 10 USDC");
        const supplyEth = ethers.parseEther("0.01");
        const borrowUsdc = ethers.parseUnits("10", 6);
        await supplyAndBorrowOnFluid(signer, safeWallet, FLUID_WETH_USDC_VAULT, supplyEth, borrowUsdc);
        const safeUsdcAfterBorrow: bigint = await usdcCx.balanceOf(safeAddress);
        console.log(`         Safe USDC balance after borrow: ${fmtUsdc(safeUsdcAfterBorrow)}`);

        // 3. Pick a balanced tick range around the current spot (so openLp's
        //    swap-half-then-mint yields a balanced position). Uses the same
        //    WETH/USDC 500-bps pool both for the swap leg and the LP mint.
        const { tickLower, tickUpper } = await wideTicksAroundSpot();
        console.log(`\n  [3/6] Tick range chosen around spot: [${tickLower}, ${tickUpper}]`);

        // 4. openLp via the Safe — the canonical entry point. Splits the
        //    borrowed USDC, swaps half to WETH on SwapRouter02, mints the
        //    WETH/USDC LP NFT, and stores `residualBasisUsd6Of[tokenId]` so
        //    closeLp can read the basis later (C-03).
        console.log("\n  [4/6] openLp via Safe (USDC split + swap + mint, basis stored on-chain)");
        await safeWallet.executeTransaction(
            await safeWallet.createTransaction({
                transactions: [
                    {
                        to: rhpAddress,
                        value: "0",
                        data: rhp.interface.encodeFunctionData("openLp", [
                            safeAddress,
                            safeUsdcAfterBorrow,
                            tickLower,
                            tickUpper,
                            500, // lpPoolFeeTier
                            0, // mintAmount0Min — opt-out for balanced range
                            0, // mintAmount1Min
                            500, // swapPoolFeeTier
                            1n, // swapAmountOutMin — contract rejects 0; 1 wei = effectively disabled
                            EXPECTED_SWAP_OUT,
                            SLIPPAGE_BPS,
                            FAR_DEADLINE,
                        ]),
                        operation: OperationType.Call,
                    },
                ],
            }),
        );
        const openedEv = (await rhp.queryFilter(rhp.filters.PositionOpened(safeAddress), -10)).slice(-1)[0].args;
        const tokenId: bigint = openedEv.tokenId;
        const npm = new ethers.Contract(UNISWAP_V3_NPM_ADDRESS, NPM_ABI, ethers.provider);
        expect(await npm.ownerOf(tokenId)).to.equal(safeAddress);
        const storedBasis: bigint = await rhp.residualBasisUsd6Of(tokenId);
        console.log(`         minted tokenId: ${tokenId}; basis stored: ${fmtUsdc(storedBasis)}`);

        // 5. Capture balances and run closeLp via the Safe. After C-03 the
        //    perf-fee basis is read on-chain from `residualBasisUsd6Of[tokenId]`;
        //    caller can no longer attest a value.
        const treasuryUsdcBefore = await usdcCx.balanceOf(treasury.address);
        const safeUsdcBefore = await usdcCx.balanceOf(safeAddress);
        console.log("\n  [5/6] Call closeLp via Safe (basis read from storage)");
        console.log(`         pre-close treasury USDC: ${fmtUsdc(treasuryUsdcBefore)}`);
        console.log(`         pre-close safe USDC:     ${fmtUsdc(safeUsdcBefore)}`);

        await safeWallet.executeTransaction(
            await safeWallet.createTransaction({
                transactions: [
                    {
                        to: rhpAddress,
                        value: "0",
                        data: rhp.interface.encodeFunctionData("closeLp", [
                            safeAddress,
                            tokenId,
                            500, // swapPoolFeeTier
                            1n, // swapAmountOutMin — contract rejects 0; 1 wei = effectively disabled
                            EXPECTED_SWAP_OUT,
                            SLIPPAGE_BPS,
                            10_000, // exitBps — full close
                            0, // decreaseAmount0Min
                            0, // decreaseAmount1Min
                            FAR_DEADLINE,
                            0, // minUsdcOut — disabled
                        ]),
                        operation: OperationType.Call,
                    },
                ],
            }),
        );

        // 6. Read the PositionClosed event + derive deltas.
        const closedEv = (await rhp.queryFilter(rhp.filters.PositionClosed(safeAddress, tokenId), -10)).slice(-1)[0]
            .args;
        const basisUsd6: bigint = closedEv.basisUsd6;
        const currentValueUsd6: bigint = closedEv.currentValueUsd6;
        const feeUsd6: bigint = closedEv.feeUsd6;

        const treasuryUsdcAfter = await usdcCx.balanceOf(treasury.address);
        const safeUsdcAfter = await usdcCx.balanceOf(safeAddress);
        const rhpUsdcAfter = await usdcCx.balanceOf(rhpAddress);
        const feeCharged = treasuryUsdcAfter - treasuryUsdcBefore;
        const safeNetGain = safeUsdcAfter - safeUsdcBefore;
        let nftBurned = false;
        try {
            await npm.ownerOf(tokenId);
        } catch {
            nftBurned = true;
        }

        // Expected fee = max(0, realized - basis) * perfBps / 10_000.
        const expectedFee =
            currentValueUsd6 > basisUsd6
                ? ((currentValueUsd6 - basisUsd6) * BigInt(PERFORMANCE_FEE_BPS)) / 10_000n
                : 0n;

        console.log("\n  ─── Results ───");
        console.log(`         basis used (event):     ${fmtUsdc(basisUsd6)}`);
        console.log(`         realized value (event): ${fmtUsdc(currentValueUsd6)}`);
        console.log(`         perf fee (event):       ${fmtUsdc(feeUsd6)} (${PERFORMANCE_FEE_BPS / 100}% of profit)`);
        console.log(`         fee → treasury (delta): ${fmtUsdc(feeCharged)}`);
        console.log(`         net → Safe (delta):     ${fmtUsdc(safeNetGain)}`);
        console.log(`         RatehopperUniV3Positions residual USDC: ${fmtUsdc(rhpUsdcAfter)} (expected 0)`);
        console.log(`         NFT burned by closeLp: ${nftBurned}\n`);

        // Assertions
        expect(basisUsd6).to.equal(storedBasis); // event basis matches what was stored at openLp
        expect(currentValueUsd6).to.be.gt(0n);
        expect(feeUsd6).to.equal(expectedFee);
        expect(feeCharged).to.equal(feeUsd6);
        expect(safeNetGain).to.equal(currentValueUsd6 - feeUsd6);
        expect(safeUsdcAfter).to.be.gt(safeUsdcBefore);
        expect(nftBurned).to.equal(true);
        // Stored basis is wiped on full close.
        expect(await rhp.residualBasisUsd6Of(tokenId)).to.equal(0n);
    });

    it("opens an LP position via openLp (supply+borrow done externally)", async function () {
        const { rhp } = await deployFixture();
        const rhpAddress = await rhp.getAddress();

        const fmtUsdc = (v: bigint) => `${ethers.formatUnits(v, 6)} USDC`;

        console.log("\n  ─── openLp setup ───");
        console.log(`    RatehopperUniV3Positions: ${rhpAddress}`);
        console.log(`    Safe (env-driven):   ${safeAddress}`);

        // 1. Enable RatehopperUniV3Positions as a Safe module so openLp can drive
        //    the swap + LP mint via Safe.execTransactionFromModule.
        console.log("\n  [openLp 1/3] Enable RatehopperUniV3Positions as Safe module");
        const enableRhpTx = await safeWallet.createEnableModuleTx(rhpAddress);
        await safeWallet.executeTransaction(enableRhpTx);

        // 2. Supply + borrow are done OUTSIDE openLp. Per Approach B, the
        //    user runs Fluid supply+borrow as a separate Safe transaction
        //    first, leaving the Safe with USDC ready for the LP mint.
        console.log("\n  [openLp 2/3] Supply 0.01 ETH + borrow 10 USDC on Fluid (external to openLp)");
        await supplyAndBorrowOnFluid(
            signer,
            safeWallet,
            FLUID_WETH_USDC_VAULT,
            ethers.parseEther("0.01"),
            ethers.parseUnits("10", 6),
        );

        const usdcCx = new ethers.Contract(USDC_ADDRESS, ERC20_VIEW_ABI, ethers.provider);
        const usdcOnSafe = await usdcCx.balanceOf(safeAddress);
        console.log(`         Safe USDC after borrow: ${fmtUsdc(usdcOnSafe)}`);

        // Use exactly what's on the Safe, no more no less.
        const usdcAmount = usdcOnSafe;
        const halfUsdc = usdcAmount / 2n;

        // Pick a wide tick range around current price so the mint accepts
        // both legs (we want a balanced LP).
        const pool = new ethers.Contract(WETH_USDC_500_POOL, UNISWAP_V3_POOL_ABI, ethers.provider);
        const slot0 = await pool.slot0();
        const currentTick = Number(slot0.tick);
        const tickSpacing = 10;
        const tickLower = Math.floor((currentTick - 5_000) / tickSpacing) * tickSpacing;
        const tickUpper = Math.ceil((currentTick + 5_000) / tickSpacing) * tickSpacing;

        console.log("\n  [openLp 3/3] Execute openLp via Safe (swap + LP mint)");
        console.log(`         usdcAmount: ${fmtUsdc(usdcAmount)}`);
        console.log(`         halfUsdc:   ${fmtUsdc(halfUsdc)}`);
        console.log(`         tickRange:  [${tickLower}, ${tickUpper}]`);

        const safeTx = await safeWallet.createTransaction({
            transactions: [
                {
                    to: rhpAddress,
                    value: "0",
                    data: rhp.interface.encodeFunctionData("openLp", [
                        safeAddress,
                        usdcAmount,
                        tickLower,
                        tickUpper,
                        500,
                         0,
                         0,
                        500,
                        1n,
                        EXPECTED_SWAP_OUT,
                        SLIPPAGE_BPS,
                        FAR_DEADLINE,
                    ]),
                    operation: OperationType.Call,
                },
            ],
        });
        await safeWallet.executeTransaction(safeTx);

        // Find the freshly-minted LP NFT.
        const filter = rhp.filters.PositionOpened(safeAddress);
        const events = await rhp.queryFilter(filter, -10);
        expect(events.length).to.be.gte(1);
        const tokenId = events[events.length - 1].args.tokenId as bigint;

        const nftOwner = await new ethers.Contract(
            UNISWAP_V3_NPM_ADDRESS,
            ["function ownerOf(uint256) view returns (address)"],
            ethers.provider,
        ).ownerOf(tokenId);

        console.log("\n  ─── openLp results ───");
        console.log(`         tokenId:           ${tokenId}`);
        console.log(`         NFT owner:         ${nftOwner}`);
        console.log(`         NFT owner == Safe: ${nftOwner === safeAddress}\n`);

        expect(nftOwner).to.equal(safeAddress);
    });

    it("collectLp harvests owed fees, charges feeCollectBps, forwards the rest, and keeps the position open", async function () {
        const { rhp, treasury } = await deployFixture();
        const rhpAddress = await rhp.getAddress();

        const fmtUsdc = (v: bigint) => `${ethers.formatUnits(v, 6)} USDC`;
        const fmtEth = (v: bigint) => `${ethers.formatEther(v)} ETH`;

        const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_VIEW_ABI, ethers.provider);
        const wethCx = new ethers.Contract(WETH_ADDRESS, ERC20_VIEW_ABI, ethers.provider);
        const npm = new ethers.Contract(UNISWAP_V3_NPM_ADDRESS, NPM_ABI, ethers.provider);

        console.log("\n  ─── collectLp setup ───");
        console.log(`    RatehopperUniV3Positions: ${rhpAddress}`);
        console.log(`    Safe (env-driven):   ${safeAddress}`);
        console.log(`    Treasury:            ${treasury.address}`);
        console.log(`    feeCollectBps:       ${COLLECT_FEE_BPS} (${COLLECT_FEE_BPS / 100}%)`);

        // 1. Enable RHP as a module, fund the Safe with USDC, and open a
        //    balanced in-range LP via openLp.
        console.log("\n  [collectLp 1/5] Enable RatehopperUniV3Positions as Safe module");
        await safeWallet.executeTransaction(await safeWallet.createEnableModuleTx(rhpAddress));

        console.log("\n  [collectLp 2/5] Supply 0.01 ETH + borrow 10 USDC on Fluid (external to RHP)");
        await supplyAndBorrowOnFluid(
            signer,
            safeWallet,
            FLUID_WETH_USDC_VAULT,
            ethers.parseEther("0.01"),
            ethers.parseUnits("10", 6),
        );
        const usdcAmount = await usdc.balanceOf(safeAddress);
        const { tickLower, tickUpper } = await wideTicksAroundSpot();
        console.log(`         Safe USDC after borrow: ${fmtUsdc(usdcAmount)}`);
        console.log(`         LP tick range:          [${tickLower}, ${tickUpper}] (balanced, in-range)`);

        console.log("\n  [collectLp 3/5] openLp → mint a balanced WETH/USDC LP on the Safe");
        await safeWallet.executeTransaction(
            await safeWallet.createTransaction({
                transactions: [
                    {
                        to: rhpAddress,
                        value: "0",
                        data: rhp.interface.encodeFunctionData("openLp", [
                            safeAddress,
                            usdcAmount,
                            tickLower,
                            tickUpper,
                            500,
                             0,
                             0,
                            500,
                        1n,
                            EXPECTED_SWAP_OUT,
                            SLIPPAGE_BPS,
                        FAR_DEADLINE,
                        ]),
                        operation: OperationType.Call,
                    },
                ],
            }),
        );
        const opened = await rhp.queryFilter(rhp.filters.PositionOpened(safeAddress), -10);
        const tokenId = opened[opened.length - 1].args.tokenId as bigint;
        console.log(`         minted LP tokenId: ${tokenId}`);

        // 2. Zero-fee branch: collecting a fresh position (no owed amounts)
        //    must move nothing and leave the position open.
        console.log("\n  [collectLp 4/5] collectLp on the FRESH position (zero-fee branch)");
        const treasuryUsdcPre = await usdc.balanceOf(treasury.address);
        await safeWallet.executeTransaction(
            await safeWallet.createTransaction({
                transactions: [
                    {
                        to: rhpAddress,
                        value: "0",
                        data: rhp.interface.encodeFunctionData("collectLp", [safeAddress, tokenId]),
                        operation: OperationType.Call,
                    },
                ],
            }),
        );
        const zeroFeeEv = (await rhp.queryFilter(rhp.filters.FeesCollected(safeAddress, tokenId), -10)).slice(-1)[0]
            .args;
        expect(zeroFeeEv.collected0).to.equal(0n);
        expect(zeroFeeEv.collected1).to.equal(0n);
        expect(await usdc.balanceOf(treasury.address)).to.equal(treasuryUsdcPre);
        expect(await npm.ownerOf(tokenId)).to.equal(safeAddress);
        console.log(
            `         collected0/1: ${zeroFeeEv.collected0}/${zeroFeeEv.collected1} (both 0 — nothing owed yet)`,
        );
        console.log(`         treasury USDC unchanged, NFT still on Safe`);

        // 3. Stage collectable amounts deterministically: have the Safe
        //    partially decreaseLiquidity, which credits principal to the
        //    position's tokensOwed0/1 WITHOUT transferring. That is exactly
        //    what `collect` (and therefore collectLp) harvests — identical to
        //    accrued trading fees from collect's point of view — and it is
        //    reliable on a deep mainnet-fork pool where a tiny position would
        //    otherwise accrue ~zero real fees. Half the liquidity stays in
        //    place so the position remains open.
        console.log("\n  [collectLp 5/5] Stage owed amounts via partial decreaseLiquidity, then collectLp");
        const liquidity: bigint = (await npm.positions(tokenId)).liquidity;
        const liqToOwe = liquidity / 2n;
        console.log(`         position liquidity: ${liquidity} → decreasing half (${liqToOwe}) into tokensOwed`);
        await safeWallet.executeTransaction(
            await safeWallet.createTransaction({
                transactions: [
                    {
                        to: UNISWAP_V3_NPM_ADDRESS,
                        value: "0",
                        data: npm.interface.encodeFunctionData("decreaseLiquidity", [
                            {
                                tokenId,
                                liquidity: liqToOwe,
                                amount0Min: 0n,
                                amount1Min: 0n,
                                deadline: Math.floor(Date.now() / 1000) + 3_600,
                            },
                        ]),
                        operation: OperationType.Call,
                    },
                ],
            }),
        );
        const liqAfterDecrease: bigint = (await npm.positions(tokenId)).liquidity;
        console.log(`         liquidity left in position: ${liqAfterDecrease} (position stays OPEN)`);

        // 4. Snapshot both legs on treasury + Safe, then collectLp.
        const tWeth0 = await wethCx.balanceOf(treasury.address);
        const tUsdc0 = await usdc.balanceOf(treasury.address);
        const sWeth0 = await wethCx.balanceOf(safeAddress);
        const sUsdc0 = await usdc.balanceOf(safeAddress);
        console.log("         pre-collect balances:");
        console.log(`           treasury: ${fmtEth(tWeth0)} / ${fmtUsdc(tUsdc0)}`);
        console.log(`           safe:     ${fmtEth(sWeth0)} / ${fmtUsdc(sUsdc0)}`);

        await safeWallet.executeTransaction(
            await safeWallet.createTransaction({
                transactions: [
                    {
                        to: rhpAddress,
                        value: "0",
                        data: rhp.interface.encodeFunctionData("collectLp", [safeAddress, tokenId]),
                        operation: OperationType.Call,
                    },
                ],
            }),
        );

        const ev = (await rhp.queryFilter(rhp.filters.FeesCollected(safeAddress, tokenId), -10)).slice(-1)[0].args;
        const collected0: bigint = ev.collected0;
        const fee0: bigint = ev.fee0;
        const collected1: bigint = ev.collected1;
        const fee1: bigint = ev.fee1;

        console.log("\n  ─── collectLp results ───");
        console.log(`         token0 WETH (${ev.token0})`);
        console.log(
            `           collected ${fmtEth(collected0)} | fee ${fmtEth(fee0)} → treasury | ${fmtEth(collected0 - fee0)} → Safe`,
        );
        console.log(`         token1 USDC (${ev.token1})`);
        console.log(
            `           collected ${fmtUsdc(collected1)} | fee ${fmtUsdc(fee1)} → treasury | ${fmtUsdc(collected1 - fee1)} → Safe`,
        );
        console.log(
            `         effective fee rate: token1 ${((Number(fee1) / Number(collected1)) * 10_000).toFixed(0)} bps (expected ${COLLECT_FEE_BPS})`,
        );
        console.log(
            `         router residual: ${fmtEth(await wethCx.balanceOf(rhpAddress))} / ${fmtUsdc(await usdc.balanceOf(rhpAddress))} (expected 0)`,
        );
        console.log(`         position still owned by Safe + liquidity unchanged (open)`);

        // The pool orders WETH (token0) before USDC (token1) by address.
        expect(ev.token0.toLowerCase()).to.equal(WETH_ADDRESS.toLowerCase());
        expect(ev.token1.toLowerCase()).to.equal(USDC_ADDRESS.toLowerCase());

        // Both legs were owed (balanced position decreased), so both collected.
        expect(collected0).to.be.gt(0n);
        expect(collected1).to.be.gt(0n);

        // Fee == feeCollectBps (2.5%) of the gross collected, per leg.
        expect(fee0).to.equal((collected0 * BigInt(COLLECT_FEE_BPS)) / 10_000n);
        expect(fee1).to.equal((collected1 * BigInt(COLLECT_FEE_BPS)) / 10_000n);

        // Treasury received exactly the fee; the Safe received the remainder.
        expect((await wethCx.balanceOf(treasury.address)) - tWeth0).to.equal(fee0);
        expect((await usdc.balanceOf(treasury.address)) - tUsdc0).to.equal(fee1);
        expect((await wethCx.balanceOf(safeAddress)) - sWeth0).to.equal(collected0 - fee0);
        expect((await usdc.balanceOf(safeAddress)) - sUsdc0).to.equal(collected1 - fee1);

        // The router keeps no residual of either leg.
        expect(await wethCx.balanceOf(rhpAddress)).to.equal(0n);
        expect(await usdc.balanceOf(rhpAddress)).to.equal(0n);

        // Position stays OPEN: collectLp neither changed liquidity nor burned.
        expect((await npm.positions(tokenId)).liquidity).to.equal(liqAfterDecrease);
        expect(await npm.ownerOf(tokenId)).to.equal(safeAddress);
    });

    it("lets the registry operator drive openLp + closeLp on the Safe's behalf; rejects a stranger", async function () {
        const { rhp, protocolRegistry, deployer } = await deployFixture();
        const rhpAddress = await rhp.getAddress();
        const [, operatorEOA, stranger] = await ethers.getSigners();

        const fmtUsdc = (v: bigint) => `${ethers.formatUnits(v, 6)} USDC`;

        console.log("\n  ─── operator-path setup ───");
        console.log(`    RatehopperUniV3Positions: ${rhpAddress}`);
        console.log(`    Safe (env-driven):   ${safeAddress}`);
        console.log(`    Operator EOA:        ${operatorEOA.address}`);
        console.log(`    Stranger EOA:        ${stranger.address}`);

        // Register a dedicated backend operator EOA (distinct from the Safe and
        // the owner) as the registry's safeOperator. setOperator is gated by
        // the timelock, which the fixture set to `deployer`.
        console.log("\n  [operator 1/5] Register operator EOA as registry.safeOperator (timelock-gated)");
        await (await protocolRegistry.connect(deployer).setOperator(operatorEOA.address)).wait();
        expect(await protocolRegistry.safeOperator()).to.equal(operatorEOA.address);
        console.log(
            `         registry.safeOperator() == operator: ${(await protocolRegistry.safeOperator()) === operatorEOA.address}`,
        );

        // The Safe enables RHP as a module and funds itself with USDC; from
        // here the OPERATOR — not the Safe — drives the LP lifecycle via plain
        // EOA transactions (no Safe signature on openLp/closeLp).
        console.log("\n  [operator 2/5] Safe enables RHP module + supplies/borrows 10 USDC");
        await safeWallet.executeTransaction(await safeWallet.createEnableModuleTx(rhpAddress));
        await supplyAndBorrowOnFluid(
            signer,
            safeWallet,
            FLUID_WETH_USDC_VAULT,
            ethers.parseEther("0.01"),
            ethers.parseUnits("10", 6),
        );

        const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_VIEW_ABI, ethers.provider);
        const npm = new ethers.Contract(UNISWAP_V3_NPM_ADDRESS, NPM_ABI, ethers.provider);
        const usdcAmount = await usdc.balanceOf(safeAddress);
        const { tickLower, tickUpper } = await wideTicksAroundSpot();
        console.log(`         Safe USDC ready: ${fmtUsdc(usdcAmount)}, LP range [${tickLower}, ${tickUpper}]`);

        // A stranger (neither operator nor Safe) is rejected by the gate.
        console.log("\n  [operator 3/5] Stranger EOA calls openLp → expect NotAuthorized");
        await expect(
            rhp.connect(stranger).openLp(safeAddress, usdcAmount, tickLower, tickUpper, 500, 0, 0, 500, 1n, EXPECTED_SWAP_OUT, SLIPPAGE_BPS, FAR_DEADLINE),
        ).to.be.revertedWithCustomError(rhp, "NotAuthorized");
        console.log("         stranger rejected with NotAuthorized ✓");

        // 1. Operator opens the LP directly.
        console.log("\n  [operator 4/5] Operator EOA calls openLp directly (no Safe signature)");
        await (
            await rhp.connect(operatorEOA).openLp(safeAddress, usdcAmount, tickLower, tickUpper, 500, 0, 0, 500, 1n, EXPECTED_SWAP_OUT, SLIPPAGE_BPS, FAR_DEADLINE)
        ).wait();
        const opened = await rhp.queryFilter(rhp.filters.PositionOpened(safeAddress), -10);
        const tokenId = opened[opened.length - 1].args.tokenId as bigint;
        expect(await npm.ownerOf(tokenId)).to.equal(safeAddress);
        console.log(`         operator-opened tokenId ${tokenId} (owner == Safe)`);

        // 2. Operator closes the same LP directly; USDC is forwarded to the Safe.
        console.log("\n  [operator 5/5] Operator EOA calls closeLp directly");
        const safeUsdcBefore = await usdc.balanceOf(safeAddress);
        // Operator-driven full close. Perf-fee math is asserted elsewhere;
        // this test only validates the operator authorization path.
        await (
            await rhp
                .connect(operatorEOA)
                .closeLp(safeAddress, tokenId, 500, 1n, EXPECTED_SWAP_OUT, SLIPPAGE_BPS, 10_000, 0, 0, FAR_DEADLINE, 0)
        ).wait();
        const safeUsdcAfter = await usdc.balanceOf(safeAddress);

        let nftBurned = false;
        try {
            await npm.ownerOf(tokenId);
        } catch {
            nftBurned = true;
        }
        console.log(
            `  operator-closed: Safe USDC +${fmtUsdc(safeUsdcAfter - safeUsdcBefore)}, NFT burned ${nftBurned}`,
        );

        expect(safeUsdcAfter).to.be.gt(safeUsdcBefore);
        expect(nftBurned).to.equal(true);
    });

    it("rejects invalid inputs and unauthorized callers", async function () {
        const { rhp, protocolRegistry, deployer } = await deployFixture();
        const [, operatorEOA] = await ethers.getSigners();
        await (await protocolRegistry.connect(deployer).setOperator(operatorEOA.address)).wait();

        const { tickLower, tickUpper } = await wideTicksAroundSpot();
        const someUsdc = ethers.parseUnits("1", 6);

        console.log("\n  ─── input-validation / authorization ───");
        console.log(`    Operator EOA: ${operatorEOA.address} (registered as safeOperator)`);

        // usdcAmount == 0 → InvalidUsdcAmount (checked before any module call).
        await expect(
            rhp.connect(operatorEOA).openLp(safeAddress, 0n, tickLower, tickUpper, 500, 0, 0, 500, 1n, EXPECTED_SWAP_OUT, SLIPPAGE_BPS, FAR_DEADLINE),
        ).to.be.revertedWithCustomError(rhp, "InvalidUsdcAmount");
        console.log("    openLp(usdcAmount = 0)        → reverted InvalidUsdcAmount ✓");

        // _onBehalfOf == address(0) → ZeroAddress (from onlyOperatorOrSafe).
        await expect(
            rhp.connect(operatorEOA).openLp(ZERO_ADDRESS, someUsdc, tickLower, tickUpper, 500, 0, 0, 500, 1n, EXPECTED_SWAP_OUT, SLIPPAGE_BPS, FAR_DEADLINE),
        ).to.be.revertedWithCustomError(rhp, "ZeroAddress");
        console.log("    openLp(_onBehalfOf = 0x0)     → reverted ZeroAddress ✓");

        // RHP not enabled as a module on the Safe → the Safe rejects the
        // module call (Gnosis "GS104"), so the whole tx reverts.
        await expect(
            rhp.connect(operatorEOA).openLp(safeAddress, someUsdc, tickLower, tickUpper, 500, 0, 0, 500, 1n, EXPECTED_SWAP_OUT, SLIPPAGE_BPS, FAR_DEADLINE),
        ).to.be.reverted;
        console.log("    openLp(module not enabled)    → reverted (Safe GS104) ✓");

        // slippageBps > maxSlippageBps → SlippageAboveMax (pre-flight, before
        // any module call). Default maxSlippageBps = 300; passing 301 reverts.
        const maxSlip = Number(await rhp.maxSlippageBps());
        await expect(
            rhp.connect(operatorEOA).openLp(safeAddress, someUsdc, tickLower, tickUpper, 500, 0, 0, 500, 0, EXPECTED_SWAP_OUT, maxSlip + 1, FAR_DEADLINE),
        ).to.be.revertedWithCustomError(rhp, "SlippageAboveMax");
        console.log(`    openLp(slippageBps = ${maxSlip + 1})     → reverted SlippageAboveMax ✓`);

        await expect(
            rhp.connect(operatorEOA).closeLp(safeAddress, 1n, 500, 0, EXPECTED_SWAP_OUT, maxSlip + 1, 10_000, 0, 0, FAR_DEADLINE, 0),
        ).to.be.revertedWithCustomError(rhp, "SlippageAboveMax");
        console.log(`    closeLp(slippageBps = ${maxSlip + 1})    → reverted SlippageAboveMax ✓`);

        // Disallowed fee tier (e.g. 10000) reverts pre-flight on lpPoolFeeTier,
        // swapPoolFeeTier, and closeLp.swapPoolFeeTier. Default allow-list:
        // {100, 500, 3000}.
        const badTier = 10000;
        await expect(
            rhp.connect(operatorEOA).openLp(safeAddress, someUsdc, tickLower, tickUpper, badTier, 0, 0, 500, 1n, EXPECTED_SWAP_OUT, SLIPPAGE_BPS, FAR_DEADLINE),
        ).to.be.revertedWithCustomError(rhp, "FeeTierNotAllowed");
        console.log(`    openLp(lpPoolFeeTier = ${badTier})   → reverted FeeTierNotAllowed ✓`);

        await expect(
            rhp.connect(operatorEOA).openLp(safeAddress, someUsdc, tickLower, tickUpper, 500, 0, 0, badTier, 0, EXPECTED_SWAP_OUT, SLIPPAGE_BPS, FAR_DEADLINE),
        ).to.be.revertedWithCustomError(rhp, "FeeTierNotAllowed");
        console.log(`    openLp(swapPoolFeeTier = ${badTier}) → reverted FeeTierNotAllowed ✓`);

        await expect(
            rhp.connect(operatorEOA).closeLp(safeAddress, 1n, badTier, 0, EXPECTED_SWAP_OUT, SLIPPAGE_BPS, 10_000, 0, 0, FAR_DEADLINE, 0),
        ).to.be.revertedWithCustomError(rhp, "FeeTierNotAllowed");
        console.log(`    closeLp(swapPoolFeeTier = ${badTier}) → reverted FeeTierNotAllowed ✓`);

        // C-01 floor: swapAmountOutMin must be non-zero so a (compromised)
        // operator cannot disable per-call slippage protection by passing 0.
        await expect(
            rhp.connect(operatorEOA).openLp(safeAddress, someUsdc, tickLower, tickUpper, 500, 0, 0, 500, 0n, EXPECTED_SWAP_OUT, SLIPPAGE_BPS, FAR_DEADLINE),
        ).to.be.revertedWithCustomError(rhp, "InvalidSwapAmountOutMin");
        console.log(`    openLp(swapAmountOutMin = 0)           → reverted InvalidSwapAmountOutMin ✓`);

        await expect(
            rhp.connect(operatorEOA).closeLp(safeAddress, 1n, 500, 0n, EXPECTED_SWAP_OUT, SLIPPAGE_BPS, 10_000, 0, 0, FAR_DEADLINE, 0),
        ).to.be.revertedWithCustomError(rhp, "InvalidSwapAmountOutMin");
        console.log(`    closeLp(swapAmountOutMin = 0)          → reverted InvalidSwapAmountOutMin ✓`);

        // H-01: with `minPoolLiquidity` set above any real pool's liquidity,
        // _validatePool reverts PoolTooThin pre-flight (during the spot-price
        // read in _quoteSwapAmountOutMin).
        const maxUint128 = 2n ** 128n - 1n;
        await (await rhp.connect(deployer).setMinPoolLiquidity(maxUint128)).wait();
        await expect(
            rhp.connect(operatorEOA).openLp(safeAddress, someUsdc, tickLower, tickUpper, 500, 0, 0, 500, 1n, EXPECTED_SWAP_OUT, SLIPPAGE_BPS, FAR_DEADLINE),
        ).to.be.revertedWithCustomError(rhp, "PoolTooThin");
        console.log(`    openLp(minPoolLiquidity = MAX)         → reverted PoolTooThin ✓`);
    });

    it("closeLp reverts MinUsdcOutNotMet when realized < minUsdcOut (C-02 final guard)", async function () {
        const { rhp, protocolRegistry, deployer } = await deployFixture();
        const [, operatorEOA] = await ethers.getSigners();
        await (await protocolRegistry.connect(deployer).setOperator(operatorEOA.address)).wait();

        const tokenId = await openBalancedPosition(
            rhp,
            safeWallet,
            signer,
            ethers.parseEther("0.01"),
            ethers.parseUnits("10", 6),
        );

        // Operator EOA path gives clean typed revert (vs the Safe SDK which
        // wraps inner reverts in opaque RPC errors). Stored basis is ~5 USDC;
        // ask for 1M USDC → revert MinUsdcOutNotMet.
        const huge = ethers.parseUnits("1000000", 6);
        await expect(
            rhp
                .connect(operatorEOA)
                .closeLp(safeAddress, tokenId, 500, 1n, EXPECTED_SWAP_OUT, SLIPPAGE_BPS, 10_000, 0, 0, FAR_DEADLINE, huge),
        ).to.be.revertedWithCustomError(rhp, "MinUsdcOutNotMet");
        console.log(`\n  [c-02/minUsdcOut] closeLp with minUsdcOut = 1M USDC → reverted MinUsdcOutNotMet ✓`);
    });

    it("closeLp uses the stored basis from openLp and applies the canonical fee formula", async function () {
        const { rhp, treasury } = await deployFixture();
        const tokenId = await openBalancedPosition(
            rhp,
            safeWallet,
            signer,
            ethers.parseEther("0.01"),
            ethers.parseUnits("10", 6),
        );

        // After C-03 the basis is auto-stored at openLp; caller can no longer
        // attest. Read what's stored so we can compute the expected fee.
        const storedBasis: bigint = await rhp.residualBasisUsd6Of(tokenId);
        const { basisUsd6, currentValueUsd6, feeUsd6, treasuryDelta, safeDelta } = await closeAndMeasure(
            rhp,
            safeWallet,
            treasury.address,
            tokenId,
        );
        const expectedFee =
            currentValueUsd6 > storedBasis
                ? ((currentValueUsd6 - storedBasis) * BigInt(PERFORMANCE_FEE_BPS)) / 10_000n
                : 0n;
        console.log(
            `\n  [perf-fee/formula] basis ${ethers.formatUnits(storedBasis, 6)} realized ${ethers.formatUnits(currentValueUsd6, 6)} → fee ${ethers.formatUnits(feeUsd6, 6)}`,
        );

        expect(basisUsd6).to.equal(storedBasis);
        expect(feeUsd6).to.equal(expectedFee);
        expect(treasuryDelta).to.equal(feeUsd6);
        expect(safeDelta).to.equal(currentValueUsd6 - feeUsd6);
        // Stored basis is deleted on full close.
        expect(await rhp.residualBasisUsd6Of(tokenId)).to.equal(0n);
    });

    it("closeLp on an open-and-immediately-close position naturally settles at break-even / loss (fee = 0)", async function () {
        const { rhp, treasury } = await deployFixture();
        const tokenId = await openBalancedPosition(
            rhp,
            safeWallet,
            signer,
            ethers.parseEther("0.01"),
            ethers.parseUnits("10", 6),
        );

        // With no external pool volume between open and close, realized USDC
        // < stored basis because of swap fees + spread on the round trip,
        // so the perf fee is 0.
        const storedBasis: bigint = await rhp.residualBasisUsd6Of(tokenId);
        const { currentValueUsd6, feeUsd6, treasuryDelta, safeDelta } = await closeAndMeasure(
            rhp,
            safeWallet,
            treasury.address,
            tokenId,
        );
        console.log(
            `\n  [perf-fee/break-even] basis ${ethers.formatUnits(storedBasis, 6)} realized ${ethers.formatUnits(currentValueUsd6, 6)} → fee ${ethers.formatUnits(feeUsd6, 6)}`,
        );

        expect(currentValueUsd6).to.be.gt(0n);
        expect(currentValueUsd6).to.be.lte(storedBasis); // round-trip cost makes this true
        expect(feeUsd6).to.equal(0n);
        expect(treasuryDelta).to.equal(0n);
        expect(safeDelta).to.equal(currentValueUsd6);
    });

    it("closeLp applies the owner-updated performanceFeeBps rate", async function () {
        const { rhp, deployer, treasury } = await deployFixture();

        // Owner lowers the performance fee 10% → 5%; closeLp must use the new
        // rate when computing fees against the stored basis.
        await (await rhp.connect(deployer).setPerformanceFeeBps(500)).wait();
        expect(await rhp.performanceFeeBps()).to.equal(500);

        const tokenId = await openBalancedPosition(
            rhp,
            safeWallet,
            signer,
            ethers.parseEther("0.01"),
            ethers.parseUnits("10", 6),
        );

        const storedBasis: bigint = await rhp.residualBasisUsd6Of(tokenId);
        const { basisUsd6, currentValueUsd6, feeUsd6, treasuryDelta } = await closeAndMeasure(
            rhp,
            safeWallet,
            treasury.address,
            tokenId,
        );
        const expectedFee = currentValueUsd6 > storedBasis ? ((currentValueUsd6 - storedBasis) * 500n) / 10_000n : 0n;
        console.log(
            `\n  [perf-fee/updated-rate] basis ${ethers.formatUnits(storedBasis, 6)} realized ${ethers.formatUnits(currentValueUsd6, 6)} → fee ${ethers.formatUnits(feeUsd6, 6)} (5%)`,
        );

        expect(basisUsd6).to.equal(storedBasis);
        expect(feeUsd6).to.equal(expectedFee);
        expect(treasuryDelta).to.equal(feeUsd6);
    });

    // SKIPPED: triggering UnknownPosition requires a real WETH/USDC NPM
    // position owned by the Safe but never registered via openLp (i.e. a
    // direct NPM mint), because the H-03 + M-02 helper
    // `_requireWethUsdcPositionOwnedBy` fires before this check. Synthetic
    // tokenIds (e.g. 999_999) trip NPM's "Invalid token ID" string revert
    // first. Rewrite needed: have the Safe directly NPM-mint a WETH/USDC LP
    // (giving it WETH + USDC + approvals first), then call closeLp on the
    // resulting tokenId.
    it("closeLp on an unknown tokenId reverts with UnknownPosition", async function () {
        const { rhp, protocolRegistry, deployer } = await deployFixture();
        const [, operatorEOA] = await ethers.getSigners();
        await (await protocolRegistry.connect(deployer).setOperator(operatorEOA.address)).wait();

        // Use an arbitrary tokenId that this contract never opened — the
        // residual basis slot is zero, so closeLp must revert UnknownPosition.
        await expect(
            rhp.connect(operatorEOA).closeLp(safeAddress, 999_999n, 500, 1n, EXPECTED_SWAP_OUT, SLIPPAGE_BPS, 10_000, 0, 0, FAR_DEADLINE, 0),
        ).to.be.revertedWithCustomError(rhp, "UnknownPosition");
    });

    it("collectLp on an unknown tokenId reverts with UnknownPosition (L-1)", async function () {
        // L-1 audit fix: collectLp must reject tokenIds that were not opened
        // via openLp (residualBasisUsd6Of slot is zero) so neither the Safe
        // nor the registry.safeOperator can route arbitrary Safe-owned
        // WETH/USDC NPM NFTs through the protocol's feeCollectBps path.
        const { rhp, protocolRegistry, deployer } = await deployFixture();
        const [, operatorEOA] = await ethers.getSigners();
        await (await protocolRegistry.connect(deployer).setOperator(operatorEOA.address)).wait();

        await expect(
            rhp.connect(operatorEOA).collectLp(safeAddress, 999_999n),
        ).to.be.revertedWithCustomError(rhp, "UnknownPosition");
    });

    it("closeLp rejects exitBps == 0 and exitBps > 10_000 with InvalidExitBps", async function () {
        const { rhp, protocolRegistry, deployer } = await deployFixture();
        const [, operatorEOA] = await ethers.getSigners();
        await (await protocolRegistry.connect(deployer).setOperator(operatorEOA.address)).wait();

        await expect(
            rhp.connect(operatorEOA).closeLp(safeAddress, 1n, 500, 1n, EXPECTED_SWAP_OUT, SLIPPAGE_BPS, 0, 0, 0, FAR_DEADLINE, 0),
        ).to.be.revertedWithCustomError(rhp, "InvalidExitBps");

        await expect(
            rhp.connect(operatorEOA).closeLp(safeAddress, 1n, 500, 1n, EXPECTED_SWAP_OUT, SLIPPAGE_BPS, 10_001, 0, 0, FAR_DEADLINE, 0),
        ).to.be.revertedWithCustomError(rhp, "InvalidExitBps");
    });

    it("closeLp(exitBps = 5000) keeps the NFT alive, halves liquidity, and prorates the stored basis", async function () {
        const { rhp, treasury } = await deployFixture();
        const tokenId = await openBalancedPosition(
            rhp,
            safeWallet,
            signer,
            ethers.parseEther("0.01"),
            ethers.parseUnits("10", 6),
        );

        const npm = new ethers.Contract(UNISWAP_V3_NPM_ADDRESS, NPM_ABI, ethers.provider);
        const liquidityBefore: bigint = (await npm.positions(tokenId)).liquidity;
        const storedBasisBefore: bigint = await rhp.residualBasisUsd6Of(tokenId);
        const expectedBasisForExit = (storedBasisBefore * 5_000n) / 10_000n;
        const expectedResidualAfter = storedBasisBefore - expectedBasisForExit;

        const { basisUsd6, currentValueUsd6, feeUsd6, treasuryDelta, safeDelta, exitBpsEmitted } =
            await closeAndMeasure(rhp, safeWallet, treasury.address, tokenId, 5_000);

        const expectedFee =
            currentValueUsd6 > expectedBasisForExit
                ? ((currentValueUsd6 - expectedBasisForExit) * BigInt(PERFORMANCE_FEE_BPS)) / 10_000n
                : 0n;

        const liquidityAfter: bigint = (await npm.positions(tokenId)).liquidity;
        const expectedRemoved = (liquidityBefore * 5_000n) / 10_000n;
        const expectedRemaining = liquidityBefore - expectedRemoved;
        const storedBasisAfter: bigint = await rhp.residualBasisUsd6Of(tokenId);

        console.log(
            `\n  [partial/50%] liquidity ${liquidityBefore} → ${liquidityAfter} (removed ~${expectedRemoved}); stored basis ${ethers.formatUnits(storedBasisBefore, 6)} → ${ethers.formatUnits(storedBasisAfter, 6)}; realized ${ethers.formatUnits(currentValueUsd6, 6)} basis-for-this-slice ${ethers.formatUnits(expectedBasisForExit, 6)} → fee ${ethers.formatUnits(feeUsd6, 6)}`,
        );

        expect(await npm.ownerOf(tokenId)).to.equal(safeAddress);
        expect(liquidityAfter).to.equal(expectedRemaining);
        expect(exitBpsEmitted).to.equal(5_000);
        expect(basisUsd6).to.equal(expectedBasisForExit);
        expect(storedBasisAfter).to.equal(expectedResidualAfter); // residual decremented on-chain
        expect(feeUsd6).to.equal(expectedFee);
        expect(treasuryDelta).to.equal(feeUsd6);
        expect(safeDelta).to.equal(currentValueUsd6 - feeUsd6);
    });

    it("closeLp partial(5000) then full(10000) drains liquidity, burns the NFT, and the contract self-bookkeeps residual basis", async function () {
        const { rhp, treasury } = await deployFixture();
        const tokenId = await openBalancedPosition(
            rhp,
            safeWallet,
            signer,
            ethers.parseEther("0.01"),
            ethers.parseUnits("10", 6),
        );

        const npm = new ethers.Contract(UNISWAP_V3_NPM_ADDRESS, NPM_ABI, ethers.provider);

        const openBasis: bigint = await rhp.residualBasisUsd6Of(tokenId);
        const expectedBasisFirst = (openBasis * 5_000n) / 10_000n;
        const expectedResidualAfterFirst = openBasis - expectedBasisFirst;

        const first = await closeAndMeasure(rhp, safeWallet, treasury.address, tokenId, 5_000);
        expect(await npm.ownerOf(tokenId)).to.equal(safeAddress);
        expect(await rhp.residualBasisUsd6Of(tokenId)).to.equal(expectedResidualAfterFirst);

        // Second close (full): basis should equal the residual after the first
        // close — the contract bookkeeps this internally; caller passes nothing.
        const second = await closeAndMeasure(rhp, safeWallet, treasury.address, tokenId, 10_000);

        await expect(npm.ownerOf(tokenId)).to.be.reverted;
        expect(await rhp.residualBasisUsd6Of(tokenId)).to.equal(0n); // deleted on full close

        const expectedFeeFirst =
            first.currentValueUsd6 > expectedBasisFirst
                ? ((first.currentValueUsd6 - expectedBasisFirst) * BigInt(PERFORMANCE_FEE_BPS)) / 10_000n
                : 0n;
        const expectedFeeSecond =
            second.currentValueUsd6 > expectedResidualAfterFirst
                ? ((second.currentValueUsd6 - expectedResidualAfterFirst) * BigInt(PERFORMANCE_FEE_BPS)) / 10_000n
                : 0n;

        console.log(
            `\n  [partial→full] open basis ${ethers.formatUnits(openBasis, 6)} | slice 1: basis ${ethers.formatUnits(expectedBasisFirst, 6)} realized ${ethers.formatUnits(first.currentValueUsd6, 6)} fee ${ethers.formatUnits(first.feeUsd6, 6)} | slice 2: basis ${ethers.formatUnits(expectedResidualAfterFirst, 6)} realized ${ethers.formatUnits(second.currentValueUsd6, 6)} fee ${ethers.formatUnits(second.feeUsd6, 6)} (slice 1 basis + slice 2 basis = open basis)`,
        );

        expect(first.exitBpsEmitted).to.equal(5_000);
        expect(second.exitBpsEmitted).to.equal(10_000);
        expect(first.basisUsd6).to.equal(expectedBasisFirst);
        expect(second.basisUsd6).to.equal(expectedResidualAfterFirst);
        expect(first.feeUsd6).to.equal(expectedFeeFirst);
        expect(second.feeUsd6).to.equal(expectedFeeSecond);
        expect(first.basisUsd6 + second.basisUsd6).to.equal(openBasis); // conservation
    });

    it("closeLp charges perf fee on net profit (feeUsd6 > 0 branch, basis simulated via storage override)", async function () {
        const { rhp, treasury } = await deployFixture();
        const rhpAddress = await rhp.getAddress();
        const tokenId = await openBalancedPosition(
            rhp,
            safeWallet,
            signer,
            ethers.parseEther("0.01"),
            ethers.parseUnits("10", 6),
        );

        // Discover the storage slot for `residualBasisUsd6Of[tokenId]` at
        // runtime — robust to inheritance reordering. The slot is
        // `keccak256(abi.encode(tokenId, mappingBaseSlot))`; scan
        // mappingBaseSlot 0..15 and pick the one whose stored value matches
        // the public getter.
        const openBasis: bigint = await rhp.residualBasisUsd6Of(tokenId);
        const coder = ethers.AbiCoder.defaultAbiCoder();
        let mappingSlot = -1;
        for (let s = 0; s < 16; s++) {
            const candidate = ethers.keccak256(coder.encode(["uint256", "uint256"], [tokenId, s]));
            const raw = await ethers.provider.getStorage(rhpAddress, candidate);
            if (BigInt(raw) === openBasis) {
                mappingSlot = s;
                break;
            }
        }
        expect(mappingSlot, "residualBasisUsd6Of storage slot not found").to.not.equal(-1);

        // Overwrite the basis to 1 wei. Realized USDC at close (~5 USDC) will
        // then far exceed basis → fee = (realized - 1) * 1000 / 10_000.
        const targetSlot = ethers.keccak256(
            coder.encode(["uint256", "uint256"], [tokenId, mappingSlot]),
        );
        await network.provider.send("hardhat_setStorageAt", [
            rhpAddress,
            targetSlot,
            ethers.zeroPadValue("0x01", 32),
        ]);
        expect(await rhp.residualBasisUsd6Of(tokenId)).to.equal(1n);

        // Close + assert fee math against the lowered basis.
        const { basisUsd6, currentValueUsd6, feeUsd6, treasuryDelta, safeDelta } = await closeAndMeasure(
            rhp,
            safeWallet,
            treasury.address,
            tokenId,
        );
        const expectedFee = ((currentValueUsd6 - 1n) * BigInt(PERFORMANCE_FEE_BPS)) / 10_000n;

        console.log(
            `\n  [perf-fee/profit] basis(forced) 0.000001 realized ${ethers.formatUnits(currentValueUsd6, 6)} → fee ${ethers.formatUnits(feeUsd6, 6)} (${PERFORMANCE_FEE_BPS / 100}%)`,
        );

        expect(basisUsd6).to.equal(1n); // basis-for-this-slice == stored
        expect(currentValueUsd6).to.be.gt(1n); // we engineered a profit
        expect(feeUsd6).to.equal(expectedFee);
        expect(feeUsd6).to.be.gt(0n); // the load-bearing branch — fee transferred to treasury
        expect(treasuryDelta).to.equal(feeUsd6);
        expect(safeDelta).to.equal(currentValueUsd6 - feeUsd6);
    });

    it("rescueERC721 recovers a misdirected NFT, emits, and rejects zero-address / non-admin", async function () {
        const { rhp, deployer } = await deployFixture();
        const [, other, recipient] = await ethers.getSigners();
        const rhpAddress = await rhp.getAddress();

        // Stage: open an LP via openLp (NFT lands on Safe), then route it to
        // RHP using a plain `transferFrom` from the Safe — simulates the
        // misdirected-NFT scenario rescueERC721 is built for. We use
        // `transferFrom` (not `safeTransferFrom`) because RHP doesn't
        // implement `onERC721Received` — that's intentional, RHP isn't a
        // normal NFT recipient. `rescueERC721` handles whatever lands here.
        const tokenId = await openBalancedPosition(
            rhp,
            safeWallet,
            signer,
            ethers.parseEther("0.01"),
            ethers.parseUnits("10", 6),
        );
        const npm = new ethers.Contract(UNISWAP_V3_NPM_ADDRESS, NPM_ABI, ethers.provider);
        expect(await npm.ownerOf(tokenId)).to.equal(safeAddress);

        await safeWallet.executeTransaction(
            await safeWallet.createTransaction({
                transactions: [
                    {
                        to: UNISWAP_V3_NPM_ADDRESS,
                        value: "0",
                        data: npm.interface.encodeFunctionData("transferFrom", [safeAddress, rhpAddress, tokenId]),
                        operation: OperationType.Call,
                    },
                ],
            }),
        );
        expect(await npm.ownerOf(tokenId)).to.equal(rhpAddress);

        // Happy path: rescue the NFT to a fresh recipient EOA.
        await expect(rhp.connect(deployer).rescueERC721(UNISWAP_V3_NPM_ADDRESS, tokenId, recipient.address))
            .to.emit(rhp, "NftRescued")
            .withArgs(UNISWAP_V3_NPM_ADDRESS, recipient.address, tokenId);
        expect(await npm.ownerOf(tokenId)).to.equal(recipient.address);

        // Reverts on zero token address (pre-flight, before external call).
        await expect(
            rhp.connect(deployer).rescueERC721(ZERO_ADDRESS, tokenId, recipient.address),
        ).to.be.revertedWithCustomError(rhp, "ZeroAddress");

        // Reverts on zero recipient address.
        await expect(
            rhp.connect(deployer).rescueERC721(UNISWAP_V3_NPM_ADDRESS, tokenId, ZERO_ADDRESS),
        ).to.be.revertedWithCustomError(rhp, "ZeroAddress");

        // Reverts when called by non-admin.
        await expect(
            rhp.connect(other).rescueERC721(UNISWAP_V3_NPM_ADDRESS, tokenId, recipient.address),
        ).to.be.revertedWithCustomError(rhp, "AccessControlUnauthorizedAccount");
    });
});
