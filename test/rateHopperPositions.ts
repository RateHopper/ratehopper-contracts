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
const FEE_BPS = 1000; // 10% — DEFAULT_FEE_BPS performance fee on net profit at closeLp
const COLLECT_FEE_BPS = 250; // 2.5% on collected LP fees
const SLIPPAGE_BPS = 100; // 1% — per-call slippage tolerance for openLp/closeLp swaps

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
//  RateHopperPositions. Under the module-pattern design, closeLp invokes
//  exit() module-mediated (msg.sender == safe), so RHP does NOT need to be
//  the registry `safeOperator` — that slot stays free for the backend EOA.
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

    const RHP = await ethers.getContractFactory("RateHopperPositions");
    const rhp = await RHP.deploy(
        UNISWAP_V3_NPM_ADDRESS,
        await protocolRegistry.getAddress(),
        USDC_ADDRESS,
        WETH_ADDRESS,
        UNISWAP_V3_SWAP_ROUTER_ADDRESS,
        UNISWAP_V3_FACTORY_ADDRESS,
        treasury.address,
        FEE_BPS,
        COLLECT_FEE_BPS,
        MAX_FEE_BPS,
        deployer.address,
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
                        500,
                        SLIPPAGE_BPS,
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
    initialValueUsd6: bigint,
): Promise<{ currentValueUsd6: bigint; feeUsd6: bigint; treasuryDelta: bigint; safeDelta: bigint }> {
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
                        SLIPPAGE_BPS,
                        initialValueUsd6,
                    ]),
                    operation: OperationType.Call,
                },
            ],
        }),
    );
    const ev = (await rhp.queryFilter(rhp.filters.PositionClosed(safeAddress, tokenId), -10)).slice(-1)[0].args;
    return {
        currentValueUsd6: ev.currentValueUsd6 as bigint,
        feeUsd6: ev.feeUsd6 as bigint,
        treasuryDelta: ((await usdc.balanceOf(treasuryAddr)) as bigint) - tBefore,
        safeDelta: ((await usdc.balanceOf(safeAddress)) as bigint) - sBefore,
    };
}

// ─────────────────────────────────────────────────────────────────────────
//  Unit tests — pure contract logic, no fork dependencies on Uniswap/Fluid
// ─────────────────────────────────────────────────────────────────────────

describe("RateHopperPositions - constructor", function () {
    it("stores the immutables and initial mutables", async function () {
        const { rhp, treasury, protocolRegistry } = await deployFixture();
        expect(await rhp.POSITION_MANAGER()).to.equal(UNISWAP_V3_NPM_ADDRESS);
        expect(await rhp.REGISTRY()).to.equal(await protocolRegistry.getAddress());
        expect(await rhp.USDC()).to.equal(USDC_ADDRESS);
        expect(await rhp.SWAP_ROUTER()).to.equal(UNISWAP_V3_SWAP_ROUTER_ADDRESS);
        expect(await rhp.UNISWAP_V3_FACTORY()).to.equal(UNISWAP_V3_FACTORY_ADDRESS);
        expect(await rhp.MAX_FEE_BPS()).to.equal(MAX_FEE_BPS);
        expect(await rhp.treasury()).to.equal(treasury.address);
        expect(await rhp.performanceFeeBps()).to.equal(FEE_BPS);
        expect(await rhp.feeCollectBps()).to.equal(COLLECT_FEE_BPS);
    });

    it("reverts on zero addresses and on performanceFeeBps / feeCollectBps > maxFeeBps", async function () {
        const { treasury, protocolRegistry } = await deployFixture();
        const F = await ethers.getContractFactory("RateHopperPositions");
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
            performanceFeeBps: FEE_BPS as number,
            feeCollectBps: COLLECT_FEE_BPS as number,
            maxFeeBps: MAX_FEE_BPS as number,
            initialOwner: deployer.address,
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
                m.initialOwner,
            ];
        };

        await expect(F.deploy(...build({ positionManager: ZERO_ADDRESS }))).to.be.revertedWithCustomError(F, "ZeroAddress");
        await expect(F.deploy(...build({ registry: ZERO_ADDRESS }))).to.be.revertedWithCustomError(F, "ZeroAddress");
        await expect(F.deploy(...build({ usdc: ZERO_ADDRESS }))).to.be.revertedWithCustomError(F, "ZeroAddress");
        await expect(F.deploy(...build({ weth: ZERO_ADDRESS }))).to.be.revertedWithCustomError(F, "ZeroAddress");
        await expect(F.deploy(...build({ swapRouter: ZERO_ADDRESS }))).to.be.revertedWithCustomError(F, "ZeroAddress");
        await expect(F.deploy(...build({ uniswapV3Factory: ZERO_ADDRESS }))).to.be.revertedWithCustomError(F, "ZeroAddress");
        await expect(F.deploy(...build({ treasury: ZERO_ADDRESS }))).to.be.revertedWithCustomError(F, "InvalidTreasury");
        await expect(F.deploy(...build({ performanceFeeBps: MAX_FEE_BPS + 1 }))).to.be.revertedWithCustomError(F, "FeeAboveMax");
        await expect(F.deploy(...build({ feeCollectBps: MAX_FEE_BPS + 1 }))).to.be.revertedWithCustomError(F, "FeeAboveMax");
    });
});

describe("RateHopperPositions - owner setters", function () {
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
            "OwnableUnauthorizedAccount",
        );
    });

    it("setPerformanceFeeBps emits, validates the cap, and rejects non-owner", async function () {
        const { rhp, deployer } = await deployFixture();
        const [, other] = await ethers.getSigners();

        await expect(rhp.connect(deployer).setPerformanceFeeBps(500)).to.emit(rhp, "PerformanceFeeBpsUpdated").withArgs(FEE_BPS, 500);
        expect(await rhp.performanceFeeBps()).to.equal(500);

        await expect(rhp.connect(deployer).setPerformanceFeeBps(MAX_FEE_BPS + 1)).to.be.revertedWithCustomError(rhp, "FeeAboveMax");
        await expect(rhp.connect(other).setPerformanceFeeBps(100)).to.be.revertedWithCustomError(
            rhp,
            "OwnableUnauthorizedAccount",
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
            "OwnableUnauthorizedAccount",
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────
//  Integration test — real Base mainnet contracts on the fork
// ─────────────────────────────────────────────────────────────────────────

describe("RateHopperPositions - integration (Base fork)", function () {
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

    it("closes an LP-backed Fluid debt position with profit", async function () {
        const { rhp, safeDebtManager, treasury } = await deployFixture();
        const safeDebtManagerAddress = await safeDebtManager.getAddress();
        const rhpAddress = await rhp.getAddress();

        // Pretty-printers for the running log.
        const usdcCx = new ethers.Contract(USDC_ADDRESS, ERC20_VIEW_ABI, ethers.provider);
        const wethCx = new ethers.Contract(WETH_ADDRESS, ERC20_VIEW_ABI, ethers.provider);
        const fmtUsdc = (v: bigint) => `${ethers.formatUnits(v, 6)} USDC`;
        const fmtEth = (v: bigint) => `${ethers.formatEther(v)} ETH`;

        console.log("\n  ─── Deployed addresses ───");
        console.log(`    RateHopperPositions: ${rhpAddress}`);
        console.log(`    SafeDebtManager:     ${safeDebtManagerAddress}`);
        console.log(`    Safe (env-driven):   ${safeAddress}`);
        console.log(`    Treasury:            ${treasury.address}`);

        // 1. Enable both modules on the Safe: SafeDebtManager (for exit's
        //    token transfer) and RateHopperPositions (so closeLp can pull the
        //    NFT and invoke exit module-mediated, no approvals needed).
        console.log("\n  [1/10] Enable SafeDebtManager + RateHopperPositions as Safe modules");
        await safeWallet.executeTransaction(await safeWallet.createEnableModuleTx(safeDebtManagerAddress));
        await safeWallet.executeTransaction(await safeWallet.createEnableModuleTx(rhpAddress));
        console.log(`         modules enabled: ${safeDebtManagerAddress}, ${rhpAddress}`);

        // 2. Open a real Fluid debt position: supply 0.001 ETH (auto-wrapped
        //    by the WETH/USDC vault), borrow 1 USDC. Safe ends with 1 USDC
        //    of debt and 1 USDC of free balance.
        console.log("\n  [2/10] Open Fluid debt: supply 0.001 ETH, borrow 1 USDC");
        await supplyAndBorrowOnFluid(
            signer,
            safeWallet,
            FLUID_WETH_USDC_VAULT,
            ethers.parseEther("0.001"),
            ethers.parseUnits("1", 6),
        );
        console.log(`         Safe USDC balance after borrow: ${fmtUsdc(await usdcCx.balanceOf(safeAddress))}`);

        // 3. Wrap 0.005 ETH on the Safe so it can mint the LP NFT.
        console.log("\n  [3/10] Wrap 0.005 ETH → WETH on Safe (so it can mint an LP NFT)");
        const weth = new ethers.Contract(WETH_ADDRESS, WETH_ABI, signer);
        await safeWallet.executeTransaction(
            await safeWallet.createTransaction({
                transactions: [
                    {
                        to: WETH_ADDRESS,
                        value: ethers.parseEther("0.005").toString(),
                        data: weth.interface.encodeFunctionData("deposit", []),
                        operation: OperationType.Call,
                    },
                ],
            }),
        );
        console.log(`         Safe WETH balance: ${fmtEth(await wethCx.balanceOf(safeAddress))}`);

        // 4. Approve NPM to pull WETH for the mint.
        console.log("\n  [4/10] Approve Uniswap V3 NPM to pull WETH from Safe");
        const npm = new ethers.Contract(UNISWAP_V3_NPM_ADDRESS, NPM_ABI, signer);
        await safeWallet.executeTransaction(
            await safeWallet.createTransaction({
                transactions: [
                    {
                        to: WETH_ADDRESS,
                        value: "0",
                        data: weth.interface.encodeFunctionData("approve", [UNISWAP_V3_NPM_ADDRESS, ethers.MaxUint256]),
                        operation: OperationType.Call,
                    },
                ],
            }),
        );

        // 5. Read the WETH/USDC 500-bps pool's current tick so we can pick a
        //    one-sided (above current price) range. A one-sided range above
        //    price holds only WETH, so we know the entire deposit will be
        //    in token0 (WETH) and the close will realize ~the same back.
        console.log("\n  [5/10] Read Uniswap V3 WETH/USDC 500-bps pool to pick LP tick range");
        const factory = new ethers.Contract(UNISWAP_V3_FACTORY_ADDRESS, UNISWAP_V3_FACTORY_ABI, signer);
        const poolAddr = await factory.getPool(WETH_ADDRESS, USDC_ADDRESS, 500);
        const pool = new ethers.Contract(poolAddr, UNISWAP_V3_POOL_ABI, signer);
        const slot0 = await pool.slot0();
        const currentTick = Number(slot0.tick);
        const tickSpacing = 10;
        const tickLower = Math.ceil((currentTick + 5_000) / tickSpacing) * tickSpacing;
        const tickUpper = tickLower + 1_000;
        console.log(`         pool:        ${poolAddr}`);
        console.log(`         currentTick: ${currentTick}`);
        console.log(`         tickRange:   [${tickLower}, ${tickUpper}] (above current → position holds only WETH)`);

        const mintAmount = ethers.parseEther("0.001");
        const mintParams = {
            token0: WETH_ADDRESS,
            token1: USDC_ADDRESS,
            fee: 500,
            tickLower,
            tickUpper,
            amount0Desired: mintAmount,
            amount1Desired: 0n,
            amount0Min: 0n,
            amount1Min: 0n,
            recipient: safeAddress,
            deadline: Math.floor(Date.now() / 1000) + 3_600,
        };

        // 6. Predict (tokenId, liquidity, amount0, amount1) by impersonating
        //    the Safe and staticCall'ing mint. Then execute the real mint via
        //    the Safe in the same block, so predicted == actual.
        console.log("\n  [6/10] Mint LP NFT (staticCall to predict, then execute via Safe)");
        await network.provider.request({ method: "hardhat_impersonateAccount", params: [safeAddress] });
        const safeImpersonated = await ethers.getSigner(safeAddress);
        const [predTokenId, predLiquidity, predAmount0] = await npm
            .connect(safeImpersonated)
            .mint.staticCall(mintParams);
        await network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [safeAddress] });
        console.log(`         predicted tokenId:   ${predTokenId}`);
        console.log(`         predicted liquidity: ${predLiquidity}`);
        console.log(`         predicted amount0:   ${fmtEth(predAmount0)} (WETH actually deposited)`);

        await safeWallet.executeTransaction(
            await safeWallet.createTransaction({
                transactions: [
                    {
                        to: UNISWAP_V3_NPM_ADDRESS,
                        value: "0",
                        data: npm.interface.encodeFunctionData("mint", [mintParams]),
                        operation: OperationType.Call,
                    },
                ],
            }),
        );
        const tokenId: bigint = predTokenId;
        expect(await npm.ownerOf(tokenId)).to.equal(safeAddress);
        console.log(`         NFT owner == Safe: ${(await npm.ownerOf(tokenId)) === safeAddress}`);

        // 7. (No NFT approval needed.) RateHopperPositions is enabled as a
        //    Safe module, so closeLp pulls the NFT via
        //    execTransactionFromModule rather than an ERC721 allowance.

        // 8. closeLp builds the WETH → USDC swap calldata on-chain; the caller
        //    supplies only the pool fee tier (500-bps, same pool the LP used).
        const swapFee = 500;
        console.log("\n  [8/9] closeLp swap leg fee tier (calldata built on-chain)");
        console.log(`         swapFee: ${swapFee} (WETH → USDC on the ${swapFee}-bps pool)`);

        // 9. Capture balances and run closeLp via the Safe. We pass
        //    initialValueUsd6 = 0 so the entire realized USDC counts as profit
        //    and the 10% performance fee path is exercised in full.
        const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_VIEW_ABI, ethers.provider);
        const treasuryUsdcBefore = await usdc.balanceOf(treasury.address);
        const safeUsdcBefore = await usdc.balanceOf(safeAddress);

        console.log("\n  [9/9] Call closeLp via Safe (initialValueUsd6 = 0 → all profit)");
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
                            swapFee,
                            SLIPPAGE_BPS,
                            0, // initialValueUsd6 — treat full realized value as profit
                        ]),
                        operation: OperationType.Call,
                    },
                ],
            }),
        );

        // Read the PositionClosed event for the realized value + fee charged.
        const closedEv = (await rhp.queryFilter(rhp.filters.PositionClosed(safeAddress, tokenId), -10)).slice(-1)[0]
            .args;
        const currentValueUsd6: bigint = closedEv.currentValueUsd6;
        const feeUsd6: bigint = closedEv.feeUsd6;

        const treasuryUsdcAfter = await usdc.balanceOf(treasury.address);
        const safeUsdcAfter = await usdc.balanceOf(safeAddress);
        const rhpUsdcAfter = await usdc.balanceOf(rhpAddress);
        const feeCharged = treasuryUsdcAfter - treasuryUsdcBefore;
        const safeNetGain = safeUsdcAfter - safeUsdcBefore;
        let nftBurned = false;
        try {
            await npm.ownerOf(tokenId);
        } catch {
            nftBurned = true;
        }

        console.log("\n  ─── Results ───");
        console.log(`         realized value (event): ${fmtUsdc(currentValueUsd6)}`);
        console.log(`         perf fee (event):       ${fmtUsdc(feeUsd6)} (${FEE_BPS / 100}% of profit)`);
        console.log(`         fee → treasury (delta): ${fmtUsdc(feeCharged)}`);
        console.log(`         net → Safe (delta):     ${fmtUsdc(safeNetGain)}`);
        console.log(`         RateHopperPositions residual USDC: ${fmtUsdc(rhpUsdcAfter)} (expected 0)`);
        console.log(`         NFT burned by closeLp: ${nftBurned}\n`);

        // 10. Assertions. With initialValueUsd6 = 0, the whole realized value is
        //     profit, so the treasury receives performanceFeeBps (10%) of it and the Safe
        //     receives the remainder. NFT is burned (full close).
        expect(currentValueUsd6).to.be.gt(0n);
        expect(feeUsd6).to.equal((currentValueUsd6 * BigInt(FEE_BPS)) / 10_000n);
        expect(feeCharged).to.equal(feeUsd6);
        expect(safeNetGain).to.equal(currentValueUsd6 - feeUsd6);
        expect(safeUsdcAfter).to.be.gt(safeUsdcBefore);
        expect(nftBurned).to.equal(true);
    });

    it("opens an LP position via openLp (supply+borrow done externally)", async function () {
        const { rhp } = await deployFixture();
        const rhpAddress = await rhp.getAddress();

        const fmtUsdc = (v: bigint) => `${ethers.formatUnits(v, 6)} USDC`;

        console.log("\n  ─── openLp setup ───");
        console.log(`    RateHopperPositions: ${rhpAddress}`);
        console.log(`    Safe (env-driven):   ${safeAddress}`);

        // 1. Enable RateHopperPositions as a Safe module so openLp can drive
        //    the swap + LP mint via Safe.execTransactionFromModule.
        console.log("\n  [openLp 1/3] Enable RateHopperPositions as Safe module");
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
            transactions: [{
                to: rhpAddress,
                value: "0",
                data: rhp.interface.encodeFunctionData("openLp", [
                    safeAddress,
                    usdcAmount,
                    tickLower,
                    tickUpper,
                    500,
                    500,
                    SLIPPAGE_BPS,
                ]),
                operation: OperationType.Call,
            }],
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
        console.log(`    RateHopperPositions: ${rhpAddress}`);
        console.log(`    Safe (env-driven):   ${safeAddress}`);
        console.log(`    Treasury:            ${treasury.address}`);
        console.log(`    feeCollectBps:       ${COLLECT_FEE_BPS} (${COLLECT_FEE_BPS / 100}%)`);

        // 1. Enable RHP as a module, fund the Safe with USDC, and open a
        //    balanced in-range LP via openLp.
        console.log("\n  [collectLp 1/5] Enable RateHopperPositions as Safe module");
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
                            500,
                            SLIPPAGE_BPS,
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
        console.log(`         collected0/1: ${zeroFeeEv.collected0}/${zeroFeeEv.collected1} (both 0 — nothing owed yet)`);
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
        console.log(`           collected ${fmtEth(collected0)} | fee ${fmtEth(fee0)} → treasury | ${fmtEth(collected0 - fee0)} → Safe`);
        console.log(`         token1 USDC (${ev.token1})`);
        console.log(`           collected ${fmtUsdc(collected1)} | fee ${fmtUsdc(fee1)} → treasury | ${fmtUsdc(collected1 - fee1)} → Safe`);
        console.log(`         effective fee rate: token1 ${(Number(fee1) / Number(collected1) * 10_000).toFixed(0)} bps (expected ${COLLECT_FEE_BPS})`);
        console.log(`         router residual: ${fmtEth(await wethCx.balanceOf(rhpAddress))} / ${fmtUsdc(await usdc.balanceOf(rhpAddress))} (expected 0)`);
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
        console.log(`    RateHopperPositions: ${rhpAddress}`);
        console.log(`    Safe (env-driven):   ${safeAddress}`);
        console.log(`    Operator EOA:        ${operatorEOA.address}`);
        console.log(`    Stranger EOA:        ${stranger.address}`);

        // Register a dedicated backend operator EOA (distinct from the Safe and
        // the owner) as the registry's safeOperator. setOperator is gated by
        // the timelock, which the fixture set to `deployer`.
        console.log("\n  [operator 1/5] Register operator EOA as registry.safeOperator (timelock-gated)");
        await (await protocolRegistry.connect(deployer).setOperator(operatorEOA.address)).wait();
        expect(await protocolRegistry.safeOperator()).to.equal(operatorEOA.address);
        console.log(`         registry.safeOperator() == operator: ${(await protocolRegistry.safeOperator()) === operatorEOA.address}`);

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
            rhp.connect(stranger).openLp(safeAddress, usdcAmount, tickLower, tickUpper, 500, 500, SLIPPAGE_BPS),
        ).to.be.revertedWithCustomError(rhp, "NotAuthorized");
        console.log("         stranger rejected with NotAuthorized ✓");

        // 1. Operator opens the LP directly.
        console.log("\n  [operator 4/5] Operator EOA calls openLp directly (no Safe signature)");
        await (
            await rhp
                .connect(operatorEOA)
                .openLp(safeAddress, usdcAmount, tickLower, tickUpper, 500, 500, SLIPPAGE_BPS)
        ).wait();
        const opened = await rhp.queryFilter(rhp.filters.PositionOpened(safeAddress), -10);
        const tokenId = opened[opened.length - 1].args.tokenId as bigint;
        expect(await npm.ownerOf(tokenId)).to.equal(safeAddress);
        console.log(`         operator-opened tokenId ${tokenId} (owner == Safe)`);

        // 2. Operator closes the same LP directly; USDC is forwarded to the Safe.
        console.log("\n  [operator 5/5] Operator EOA calls closeLp directly");
        const safeUsdcBefore = await usdc.balanceOf(safeAddress);
        // Pass a high initialValueUsd6 so no performance fee is charged — this
        // test is about the operator authorization path, not fee mechanics.
        await (
            await rhp
                .connect(operatorEOA)
                .closeLp(safeAddress, tokenId, 500, SLIPPAGE_BPS, ethers.parseUnits("1000000", 6))
        ).wait();
        const safeUsdcAfter = await usdc.balanceOf(safeAddress);

        let nftBurned = false;
        try {
            await npm.ownerOf(tokenId);
        } catch {
            nftBurned = true;
        }
        console.log(`  operator-closed: Safe USDC +${fmtUsdc(safeUsdcAfter - safeUsdcBefore)}, NFT burned ${nftBurned}`);

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
            rhp.connect(operatorEOA).openLp(safeAddress, 0n, tickLower, tickUpper, 500, 500, SLIPPAGE_BPS),
        ).to.be.revertedWithCustomError(rhp, "InvalidUsdcAmount");
        console.log("    openLp(usdcAmount = 0)        → reverted InvalidUsdcAmount ✓");

        // _onBehalfOf == address(0) → ZeroAddress (from onlyOperatorOrSafe).
        await expect(
            rhp.connect(operatorEOA).openLp(ZERO_ADDRESS, someUsdc, tickLower, tickUpper, 500, 500, SLIPPAGE_BPS),
        ).to.be.revertedWithCustomError(rhp, "ZeroAddress");
        console.log("    openLp(_onBehalfOf = 0x0)     → reverted ZeroAddress ✓");

        // RHP not enabled as a module on the Safe → the Safe rejects the
        // module call (Gnosis "GS104"), so the whole tx reverts.
        await expect(
            rhp.connect(operatorEOA).openLp(safeAddress, someUsdc, tickLower, tickUpper, 500, 500, SLIPPAGE_BPS),
        ).to.be.reverted;
        console.log("    openLp(module not enabled)    → reverted (Safe GS104) ✓");
    });

    it("closeLp charges NO performance fee when realized <= initialValueUsd6 (break-even / loss)", async function () {
        const { rhp, treasury } = await deployFixture();
        const tokenId = await openBalancedPosition(
            rhp,
            safeWallet,
            signer,
            ethers.parseEther("0.01"),
            ethers.parseUnits("10", 6),
        );

        // Attest an initial value far above anything the LP can realize, so
        // profit = max(0, realized - initialValue) = 0 → no fee.
        const { currentValueUsd6, feeUsd6, treasuryDelta, safeDelta } = await closeAndMeasure(
            rhp,
            safeWallet,
            treasury.address,
            tokenId,
            ethers.parseUnits("1000000", 6),
        );
        console.log(
            `\n  [perf-fee/no-profit] realized ${ethers.formatUnits(currentValueUsd6, 6)} USDC → fee ${ethers.formatUnits(feeUsd6, 6)} USDC`,
        );

        expect(currentValueUsd6).to.be.gt(0n);
        expect(feeUsd6).to.equal(0n);
        expect(treasuryDelta).to.equal(0n);
        expect(safeDelta).to.equal(currentValueUsd6); // full realized value to the Safe
    });

    it("closeLp charges performanceFeeBps only on profit above initialValueUsd6 (partial profit)", async function () {
        const { rhp, treasury } = await deployFixture();
        const tokenId = await openBalancedPosition(
            rhp,
            safeWallet,
            signer,
            ethers.parseEther("0.01"),
            ethers.parseUnits("10", 6),
        );

        // initialValue well below the ~10 USDC the position realizes → only the
        // delta above it is taxed.
        const initialValueUsd6 = ethers.parseUnits("4", 6);
        const { currentValueUsd6, feeUsd6, treasuryDelta, safeDelta } = await closeAndMeasure(
            rhp,
            safeWallet,
            treasury.address,
            tokenId,
            initialValueUsd6,
        );
        const profit = currentValueUsd6 - initialValueUsd6;
        const expectedFee = (profit * BigInt(FEE_BPS)) / 10_000n;
        console.log(
            `\n  [perf-fee/partial] realized ${ethers.formatUnits(currentValueUsd6, 6)} − basis ${ethers.formatUnits(initialValueUsd6, 6)} = profit ${ethers.formatUnits(profit, 6)} → fee ${ethers.formatUnits(feeUsd6, 6)}`,
        );

        expect(currentValueUsd6).to.be.gt(initialValueUsd6); // partial-profit scenario holds
        expect(feeUsd6).to.equal(expectedFee);
        expect(treasuryDelta).to.equal(feeUsd6);
        expect(safeDelta).to.equal(currentValueUsd6 - feeUsd6);
    });

    it("closeLp applies the owner-updated performanceFeeBps rate", async function () {
        const { rhp, deployer, treasury } = await deployFixture();

        // Owner lowers the performance fee 10% → 5%; closeLp must use the new rate.
        await (await rhp.connect(deployer).setPerformanceFeeBps(500)).wait();
        expect(await rhp.performanceFeeBps()).to.equal(500);

        const tokenId = await openBalancedPosition(
            rhp,
            safeWallet,
            signer,
            ethers.parseEther("0.01"),
            ethers.parseUnits("10", 6),
        );

        // initialValue 0 → the whole realized value is profit, taxed at 5%.
        const { currentValueUsd6, feeUsd6, treasuryDelta } = await closeAndMeasure(
            rhp,
            safeWallet,
            treasury.address,
            tokenId,
            0n,
        );
        console.log(
            `\n  [perf-fee/updated-rate] realized ${ethers.formatUnits(currentValueUsd6, 6)} USDC → fee ${ethers.formatUnits(feeUsd6, 6)} USDC (5%)`,
        );

        expect(currentValueUsd6).to.be.gt(0n);
        expect(feeUsd6).to.equal((currentValueUsd6 * 500n) / 10_000n);
        expect(treasuryDelta).to.equal(feeUsd6);
    });
});
