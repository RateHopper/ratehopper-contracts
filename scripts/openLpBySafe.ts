import { ethers, network } from "hardhat";
import dotenv from "dotenv";
dotenv.config();
import Safe from "@safe-global/protocol-kit";
import { MetaTransactionData, OperationType } from "@safe-global/types-kit";
import {
    AERODROME_CL_FACTORY_ADDRESS,
    UNISWAP_V3_FACTORY_ADDRESS,
    UNISWAP_V4_STATE_VIEW_ADDRESS,
    USDC_ADDRESS,
    WETH_ADDRESS,
    YieldProtocol,
    encodeAerodromePoolParam,
    encodeUniV3PoolParam,
    encodeUniV4PoolParam,
} from "../contractAddresses";
import {
    AERO_FACTORY_ABI,
    AERO_POOL_ABI,
    ERC20_ABI,
    UNIV3_FACTORY_ABI,
    UNIV3_POOL_ABI,
    UNIV4_STATE_VIEW_ABI,
    alignTick,
    deployedManagerAddress,
    mintMinimums,
    resolveOwnerKey,
    waitForReceipt,
} from "./lpSafeShared";

/**
 * Opens an LP position on the deployed SafeYieldManager (Base mainnet) FROM the
 * user's own Safe (msg.sender == Safe path of `onlyOperatorOrSafe`).
 *
 * Edit the configuration constants below, set SAFE_OWNER_PRIVATE_KEY (or
 * DEPLOYER_PRIVATE_KEY) in .env, then run:
 *
 *   npx hardhat run scripts/openLpBySafe.ts --network base
 *
 * The script:
 * 1. Verifies the Safe has enough USDC and that SafeYieldManager is enabled as
 *    a module (prepends `enableModule` to the batch if not).
 * 2. Reads the pool's current tick, aligns a symmetric range around it.
 * 3. Derives `expectedSwapOut` (USDC/2 -> WETH) from the pool spot price and
 *    sets `swapAmountOutMin = expectedSwapOut * (1 - slippage)`.
 * 4. Executes `openLp` via the Safe (protocol-kit). Threshold must be 1 —
 *    for multi-sig Safes set DRY_RUN = true and propose the printed calldata
 *    through the Safe UI instead.
 */

// ─── Configuration ───────────────────────────────────────────────────────
const SAFE_ADDRESS: string = process.env.TESTING_SAFE_WALLET_ADDRESS || "";
const USDC_AMOUNT = "0.1";
const PROTOCOL_NAME: "aerodrome" | "univ3" | "univ4" = "aerodrome";
const SLIPPAGE_BPS: bigint = 100n;
// Aerodrome tick spacing (100 or 200) — used when PROTOCOL_NAME is "aerodrome"
const TICK_SPACING = 100;
// Stake the minted NFT into the pool's gauge (Aerodrome only; reverts
// StakingNotSupported on univ3/univ4). Requires the pool to have a live gauge.
const STAKE = false;
// UniV3 fee tier (100 / 500 / 3000) — used when PROTOCOL_NAME is "univ3"
const FEE_TIER = 500;
// Uniswap V4 PoolKey fields — used when PROTOCOL_NAME is "univ4". Native
// ETH/USDC (currency0 = address(0)) is the deepest V4 pool on Base; set
// V4_USE_NATIVE_ETH = false for the (shallower) WETH/USDC V4 pool.
const V4_FEE_TIER = 500;
const V4_TICK_SPACING = 10;
const V4_USE_NATIVE_ETH = true;
const V4_HOOKS = "0x0000000000000000000000000000000000000000";
// Half-width of the range in raw ticks; 0 = default (10 * pool tick spacing)
const TICK_RANGE = 0;
// Slippage applied to the mint minima, derived from the worst accepted swap
// output rather than the optimistic spot estimate.
const MINT_SLIPPAGE_BPS: bigint = 100n;
// Empty = use the ignition-deployed address for chain 8453
const MANAGER_ADDRESS_OVERRIDE = "";
// true = print the resolved params and calldata without executing
const DRY_RUN = true;
// ─────────────────────────────────────────────────────────────────────────

async function main() {
    const OWNER_KEY = resolveOwnerKey();
    const MANAGER_ADDRESS = MANAGER_ADDRESS_OVERRIDE || deployedManagerAddress();

    if (!SAFE_ADDRESS) throw new Error("Set SAFE_ADDRESS at the top of the script");
    if (!OWNER_KEY) throw new Error("Set SAFE_OWNER_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY) in .env");
    if (!ethers.isAddress(SAFE_ADDRESS)) throw new Error(`Invalid SAFE_ADDRESS: ${SAFE_ADDRESS}`);

    const provider = ethers.provider;
    const usdcAmount = ethers.parseUnits(USDC_AMOUNT, 6);

    // Resolve pool, tick spacing and the ABI-encoded pool param per protocol
    let protocol: number;
    let poolParam: string;
    let poolAddress: string;
    let tickSpacing: number;
    let currentTick: number;
    let sqrtPriceX96: bigint;

    if (PROTOCOL_NAME === "aerodrome") {
        protocol = YieldProtocol.AERODROME;
        tickSpacing = TICK_SPACING;
        poolParam = encodeAerodromePoolParam(WETH_ADDRESS, USDC_ADDRESS, tickSpacing);
        const factory = new ethers.Contract(AERODROME_CL_FACTORY_ADDRESS, AERO_FACTORY_ABI, provider);
        poolAddress = await factory.getPool(WETH_ADDRESS, USDC_ADDRESS, tickSpacing);
        if (poolAddress === ethers.ZeroAddress) throw new Error(`No Aerodrome pool for tickSpacing ${tickSpacing}`);
        const pool = new ethers.Contract(poolAddress, AERO_POOL_ABI, provider);
        const [sqrtP, tick] = await pool.slot0();
        sqrtPriceX96 = sqrtP;
        currentTick = Number(tick);
    } else if (PROTOCOL_NAME === "univ4") {
        protocol = YieldProtocol.UNISWAP_V4;
        tickSpacing = V4_TICK_SPACING;
        // Both native ETH and WETH are 18-decimals currency0, so the spot
        // math below is identical to the V3/Aerodrome WETH path.
        const currency0 = V4_USE_NATIVE_ETH ? ethers.ZeroAddress : WETH_ADDRESS;
        poolParam = encodeUniV4PoolParam(currency0, USDC_ADDRESS, V4_FEE_TIER, V4_TICK_SPACING, V4_HOOKS);
        const poolId = ethers.keccak256(poolParam);
        const stateView = new ethers.Contract(UNISWAP_V4_STATE_VIEW_ADDRESS, UNIV4_STATE_VIEW_ABI, provider);
        const [sqrtP, tick] = await stateView.getSlot0(poolId);
        sqrtPriceX96 = BigInt(sqrtP);
        if (sqrtPriceX96 === 0n) throw new Error(`V4 pool not initialized: ${poolId}`);
        currentTick = Number(tick);
        poolAddress = `V4 PoolManager (poolId ${poolId})`;
    } else {
        protocol = YieldProtocol.UNISWAP_V3;
        poolParam = encodeUniV3PoolParam(WETH_ADDRESS, USDC_ADDRESS, FEE_TIER);
        const factory = new ethers.Contract(UNISWAP_V3_FACTORY_ADDRESS, UNIV3_FACTORY_ABI, provider);
        poolAddress = await factory.getPool(WETH_ADDRESS, USDC_ADDRESS, FEE_TIER);
        if (poolAddress === ethers.ZeroAddress) throw new Error(`No UniV3 pool for feeTier ${FEE_TIER}`);
        const pool = new ethers.Contract(poolAddress, UNIV3_POOL_ABI, provider);
        const [sqrtP, tick] = await pool.slot0();
        sqrtPriceX96 = sqrtP;
        currentTick = Number(tick);
        tickSpacing = Number(await pool.tickSpacing());
    }

    const tickRange = TICK_RANGE || tickSpacing * 10;
    const alignedTick = alignTick(currentTick, tickSpacing);
    const tickLower = alignTick(alignedTick - tickRange, tickSpacing);
    const tickUpper = alignTick(alignedTick + tickRange, tickSpacing);
    if (tickLower >= tickUpper) throw new Error("TICK_RANGE too small for the pool's tick spacing");

    // Spot-price estimate of the USDC/2 -> WETH swap output.
    // token0 = WETH, token1 = USDC on Base, so price(USDC per WETH) = sqrtP^2 / 2^192
    const halfUsdc = usdcAmount / 2n;
    const expectedSwapOut = (halfUsdc << 192n) / (sqrtPriceX96 * sqrtPriceX96);
    const swapAmountOutMin = (expectedSwapOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;
    if (swapAmountOutMin === 0n) throw new Error("USDC_AMOUNT too small: swapAmountOutMin rounds to zero");

    const manager = await ethers.getContractAt("SafeYieldManager", MANAGER_ADDRESS);
    const maxSlippageBps: bigint = await manager.maxSlippageBps();
    if (SLIPPAGE_BPS === 0n || SLIPPAGE_BPS > maxSlippageBps) {
        throw new Error(`SLIPPAGE_BPS must be in 1..${maxSlippageBps}`);
    }
    if (!(await manager.protocolEnabledForOpen(protocol))) {
        throw new Error(`Protocol ${PROTOCOL_NAME} (${protocol}) is disabled for open`);
    }

    const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
    const safeUsdcBalance: bigint = await usdc.balanceOf(SAFE_ADDRESS);
    if (safeUsdcBalance < usdcAmount) {
        throw new Error(`Safe USDC balance ${ethers.formatUnits(safeUsdcBalance, 6)} < requested ${USDC_AMOUNT}`);
    }

    // Mint minima from the CONSERVATIVE budget: if the swap lands exactly on
    // its floor, the mint must still clear its own. Sizing them off
    // `expectedSwapOut` instead would revert honest transactions.
    const mint = mintMinimums(
        { sqrtPriceX96: BigInt(sqrtPriceX96), tickLower, tickUpper },
        swapAmountOutMin,
        halfUsdc,
        MINT_SLIPPAGE_BPS,
    );

    const block = await provider.getBlock("latest");
    const deadline = BigInt(block!.timestamp) + 1_200n;

    const openParams = {
        onBehalfOf: SAFE_ADDRESS,
        usdcAmount,
        tickLower,
        tickUpper,
        mintAmount0Min: mint.amount0Min,
        mintAmount1Min: mint.amount1Min,
        // WETH is token0 on Base; the USDC side needs no swap leg.
        swap0: { amountOutMin: swapAmountOutMin, poolParam },
        swap1: { amountOutMin: 0, poolParam: "0x" },
        slippageBps: SLIPPAGE_BPS,
        deadline,
        lpPoolParam: poolParam,
        stake: STAKE,
    };

    console.log("Configuration:");
    console.log("- SafeYieldManager:", MANAGER_ADDRESS);
    console.log("- Safe:", SAFE_ADDRESS);
    console.log("- Protocol:", PROTOCOL_NAME, `(id ${protocol})`);
    console.log("- Pool:", poolAddress);
    console.log("- USDC amount:", USDC_AMOUNT);
    console.log("- Current tick:", currentTick, "| range:", tickLower, "..", tickUpper);
    console.log("- expectedSwapOut (WETH):", ethers.formatEther(expectedSwapOut));
    console.log("- swapAmountOutMin (WETH):", ethers.formatEther(swapAmountOutMin));
    console.log("- Slippage bps:", SLIPPAGE_BPS.toString());
    console.log("- Mint minimums (token0/token1):", mint.amount0Min.toString(), "/", mint.amount1Min.toString());
    console.log("- Mint expected consumed:", mint.expected0.toString(), "/", mint.expected1.toString());
    console.log("- Deadline:", deadline.toString());

    const openLpData = manager.interface.encodeFunctionData("openLp", [protocol, openParams]);
    if (DRY_RUN) {
        console.log("\nDRY_RUN — openLp calldata:");
        console.log(openLpData);
        return;
    }

    const rpcUrl = (network.config as { url?: string }).url;
    if (!rpcUrl) throw new Error(`Network ${network.name} has no RPC url — run with --network base`);

    const safeWallet = await Safe.init({
        provider: rpcUrl,
        signer: OWNER_KEY,
        safeAddress: SAFE_ADDRESS,
    });

    const threshold = await safeWallet.getThreshold();
    if (threshold > 1) {
        throw new Error(
            `Safe threshold is ${threshold}. This script only supports 1/N execution — propose the transaction via the Safe UI instead (target ${MANAGER_ADDRESS}, calldata printed with DRY_RUN = true).`,
        );
    }

    const transactions: MetaTransactionData[] = [];

    const moduleEnabled = await safeWallet.isModuleEnabled(MANAGER_ADDRESS);
    if (!moduleEnabled) {
        console.log("SafeYieldManager module not enabled — prepending enableModule");
        const safeIface = new ethers.Interface(["function enableModule(address)"]);
        transactions.push({
            to: SAFE_ADDRESS,
            value: "0",
            data: safeIface.encodeFunctionData("enableModule", [MANAGER_ADDRESS]),
            operation: OperationType.Call,
        });
    }

    transactions.push({
        to: MANAGER_ADDRESS,
        value: "0",
        data: openLpData,
        operation: OperationType.Call,
    });

    const safeTransaction = await safeWallet.createTransaction({ transactions });
    const result = await safeWallet.executeTransaction(safeTransaction);
    console.log("Submitted:", result.hash);

    const receipt = await waitForReceipt(provider, result.hash);
    console.log("Confirmed in block", receipt.blockNumber);

    const opened = await manager.queryFilter(
        manager.filters.PositionOpened(SAFE_ADDRESS),
        receipt.blockNumber,
        receipt.blockNumber,
    );
    if (opened.length > 0) {
        const event = opened[opened.length - 1];
        console.log("PositionOpened — tokenId:", event.args.tokenId.toString());
        console.log("- WETH to LP:", ethers.formatEther(event.args.amount0ToLp));
        console.log("- USDC to LP:", ethers.formatUnits(event.args.amount1ToLp, 6));
        console.log("- Position value (USD):", ethers.formatUnits(event.args.currentValueUsd6, 6));
    } else {
        console.log("No PositionOpened event found in the confirmation block — check the tx on Basescan.");
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
