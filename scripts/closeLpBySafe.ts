import { ethers, network } from "hardhat";
import dotenv from "dotenv";
dotenv.config();
import Safe from "@safe-global/protocol-kit";
import { MetaTransactionData, OperationType } from "@safe-global/types-kit";
import {
    AERODROME_CL_FACTORY_ADDRESS,
    AERODROME_SLIPSTREAM_NPM_ADDRESS,
    UNISWAP_V3_FACTORY_ADDRESS,
    UNISWAP_V3_NPM_ADDRESS,
    UNISWAP_V4_POSITION_MANAGER_ADDRESS,
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
    AERO_NPM_ABI,
    AERO_POOL_ABI,
    UNIV3_FACTORY_ABI,
    UNIV3_NPM_ABI,
    UNIV3_POOL_ABI,
    UNIV4_PM_ABI,
    UNIV4_STATE_VIEW_ABI,
    amountsForLiquidity,
    decreaseMinimums,
    deployedManagerAddress,
    resolveOwnerKey,
    unpackV4PositionTicks,
    waitForReceipt,
} from "./lpSafeShared";

/**
 * Closes an LP position on the deployed SafeYieldManager (Base mainnet) FROM
 * the user's own Safe (msg.sender == Safe path of `onlyOperatorOrSafe`).
 *
 * Edit the configuration constants below, set TESTING_SAFE_OWNER_KEY (or
 * SAFE_OWNER_PRIVATE_KEY / DEPLOYER_PRIVATE_KEY) in .env, then run:
 *
 *   npx hardhat run scripts/closeLpBySafe.ts --network base
 *
 * The script:
 * 1. Reads the position's liquidity and range from the protocol's position
 *    manager and the pool's current price.
 * 2. Estimates the WETH/USDC amounts the close will withdraw and derives
 *    `expectedSwapOut` (withdrawn WETH -> USDC), `swapAmountOutMin` and
 *    `minUsdcOut` from the pool spot price minus slippage.
 * 3. Executes `closeLp` via the Safe (protocol-kit). Threshold must be 1 —
 *    for multi-sig Safes set DRY_RUN = true and propose the printed calldata
 *    through the Safe UI instead.
 */

// ─── Configuration ───────────────────────────────────────────────────────
const SAFE_ADDRESS: string = process.env.TESTING_SAFE_WALLET_ADDRESS || "";
const PROTOCOL_NAME: "aerodrome" | "univ3" | "univ4" = "aerodrome";
const TOKEN_ID = 74554383n;
// 10_000 = full close (burns the NFT); 1..9_999 = partial close
const EXIT_BPS = 10_000;
const SLIPPAGE_BPS: bigint = 100n;
// Aerodrome tick spacing (100 or 200) — used when PROTOCOL_NAME is "aerodrome"
const TICK_SPACING = 100;
// UniV3 fee tier (100 / 500 / 3000) — used when PROTOCOL_NAME is "univ3"
const FEE_TIER = 500;
// Slippage applied to the decrease minima — the floor on the principal the
// position manager must actually hand back.
const DECREASE_SLIPPAGE_BPS: bigint = 100n;
// Empty = use the ignition-deployed address for chain 8453
const MANAGER_ADDRESS_OVERRIDE = "";
// true = print the resolved params and calldata without executing
const DRY_RUN = true;
// ─────────────────────────────────────────────────────────────────────────

async function main() {
    const OWNER_KEY = resolveOwnerKey();
    const MANAGER_ADDRESS = MANAGER_ADDRESS_OVERRIDE || deployedManagerAddress();

    if (!SAFE_ADDRESS) throw new Error("Set SAFE_ADDRESS at the top of the script");
    if (!OWNER_KEY) throw new Error("Set TESTING_SAFE_OWNER_KEY (or SAFE_OWNER_PRIVATE_KEY) in .env");
    if (!ethers.isAddress(SAFE_ADDRESS)) throw new Error(`Invalid SAFE_ADDRESS: ${SAFE_ADDRESS}`);
    if (EXIT_BPS < 1 || EXIT_BPS > 10_000) throw new Error(`EXIT_BPS must be in 1..10000`);

    const provider = ethers.provider;

    let protocol: number;
    let poolParam: string;
    let poolAddress: string;
    let sqrtPriceX96: bigint;
    let tickLower: number;
    let tickUpper: number;
    let liquidity: bigint;

    if (PROTOCOL_NAME === "univ4") {
        protocol = YieldProtocol.UNISWAP_V4;
        // The position's own PoolKey is the pool identity — no fee/spacing
        // config needed; native ETH (currency0 == address(0)) works the same
        // as WETH here (both 18-decimals currency0).
        const pm = new ethers.Contract(UNISWAP_V4_POSITION_MANAGER_ADDRESS, UNIV4_PM_ABI, provider);
        const [key, info] = await pm.getPoolAndPositionInfo(TOKEN_ID);
        if (key.currency1.toLowerCase() !== USDC_ADDRESS.toLowerCase()) {
            throw new Error(`Token ${TOKEN_ID} is not a */USDC V4 position`);
        }
        poolParam = encodeUniV4PoolParam(key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks);
        const poolId = ethers.keccak256(poolParam);
        const stateView = new ethers.Contract(UNISWAP_V4_STATE_VIEW_ADDRESS, UNIV4_STATE_VIEW_ABI, provider);
        [sqrtPriceX96] = await stateView.getSlot0(poolId);
        ({ tickLower, tickUpper } = unpackV4PositionTicks(BigInt(info)));
        liquidity = await pm.getPositionLiquidity(TOKEN_ID);
        poolAddress = `V4 PoolManager (poolId ${poolId})`;
    } else if (PROTOCOL_NAME === "aerodrome") {
        protocol = YieldProtocol.AERODROME;
        poolParam = encodeAerodromePoolParam(WETH_ADDRESS, USDC_ADDRESS, TICK_SPACING);
        const factory = new ethers.Contract(AERODROME_CL_FACTORY_ADDRESS, AERO_FACTORY_ABI, provider);
        poolAddress = await factory.getPool(WETH_ADDRESS, USDC_ADDRESS, TICK_SPACING);
        if (poolAddress === ethers.ZeroAddress) throw new Error(`No Aerodrome pool for tickSpacing ${TICK_SPACING}`);
        const pool = new ethers.Contract(poolAddress, AERO_POOL_ABI, provider);
        [sqrtPriceX96] = await pool.slot0();
        const npm = new ethers.Contract(AERODROME_SLIPSTREAM_NPM_ADDRESS, AERO_NPM_ABI, provider);
        const position = await npm.positions(TOKEN_ID);
        tickLower = Number(position[5]);
        tickUpper = Number(position[6]);
        liquidity = position[7];
    } else {
        protocol = YieldProtocol.UNISWAP_V3;
        poolParam = encodeUniV3PoolParam(WETH_ADDRESS, USDC_ADDRESS, FEE_TIER);
        const factory = new ethers.Contract(UNISWAP_V3_FACTORY_ADDRESS, UNIV3_FACTORY_ABI, provider);
        poolAddress = await factory.getPool(WETH_ADDRESS, USDC_ADDRESS, FEE_TIER);
        if (poolAddress === ethers.ZeroAddress) throw new Error(`No UniV3 pool for feeTier ${FEE_TIER}`);
        const pool = new ethers.Contract(poolAddress, UNIV3_POOL_ABI, provider);
        [sqrtPriceX96] = await pool.slot0();
        const npm = new ethers.Contract(UNISWAP_V3_NPM_ADDRESS, UNIV3_NPM_ABI, provider);
        const position = await npm.positions(TOKEN_ID);
        tickLower = Number(position[5]);
        tickUpper = Number(position[6]);
        liquidity = position[7];
    }

    if (liquidity === 0n) throw new Error(`Position ${TOKEN_ID} has zero liquidity`);

    const liquidityToRemove = EXIT_BPS === 10_000 ? liquidity : (liquidity * BigInt(EXIT_BPS)) / 10_000n;
    const { amount0: wethOut, amount1: usdcOut } = amountsForLiquidity(
        sqrtPriceX96,
        tickLower,
        tickUpper,
        liquidityToRemove,
    );

    // Spot-price estimate of the withdrawn-WETH -> USDC swap output. Fees
    // collected on top only increase the swap input, so the floor stays safe.
    let expectedSwapOut = (wethOut * sqrtPriceX96 * sqrtPriceX96) >> 192n;
    if (expectedSwapOut === 0n) expectedSwapOut = 1n;
    let swapAmountOutMin = (expectedSwapOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;
    if (swapAmountOutMin === 0n) swapAmountOutMin = 1n;
    const minUsdcOut = ((usdcOut + expectedSwapOut) * (10_000n - SLIPPAGE_BPS)) / 10_000n;

    // Floors on the withdrawal itself, prorated by exitBps. Zero survives only
    // on a side the position mathematically does not hold at this price.
    const decrease = decreaseMinimums(
        { sqrtPriceX96, tickLower, tickUpper },
        liquidity,
        BigInt(EXIT_BPS),
        DECREASE_SLIPPAGE_BPS,
    );

    const manager = await ethers.getContractAt("SafeYieldManager", MANAGER_ADDRESS);
    const maxSlippageBps: bigint = await manager.maxSlippageBps();
    if (SLIPPAGE_BPS === 0n || SLIPPAGE_BPS > maxSlippageBps) {
        throw new Error(`SLIPPAGE_BPS must be in 1..${maxSlippageBps}`);
    }
    if (!(await manager.protocolEnabledForClose(protocol))) {
        throw new Error(`Protocol ${PROTOCOL_NAME} (${protocol}) is disabled for close`);
    }

    const block = await provider.getBlock("latest");
    const deadline = BigInt(block!.timestamp) + 1_200n;

    const closeParams = {
        onBehalfOf: SAFE_ADDRESS,
        tokenId: TOKEN_ID,
        exitBps: EXIT_BPS,
        // WETH is token0 on Base; the USDC side needs no swap leg.
        swap0: { amountOutMin: swapAmountOutMin, expectedOut: expectedSwapOut, poolParam },
        swap1: { amountOutMin: 0, expectedOut: 0, poolParam: "0x" },
        slippageBps: SLIPPAGE_BPS,
        decreaseAmount0Min: decrease.amount0Min,
        decreaseAmount1Min: decrease.amount1Min,
        deadline,
        minUsdcOut,
    };

    console.log("Configuration:");
    console.log("- SafeYieldManager:", MANAGER_ADDRESS);
    console.log("- Safe:", SAFE_ADDRESS);
    console.log("- Protocol:", PROTOCOL_NAME, `(id ${protocol})`);
    console.log("- Pool:", poolAddress);
    console.log("- Token id:", TOKEN_ID.toString(), "| exitBps:", EXIT_BPS);
    console.log("- Position range:", tickLower, "..", tickUpper, "| liquidity:", liquidity.toString());
    console.log("- Estimated withdrawal: WETH", ethers.formatEther(wethOut), "| USDC", ethers.formatUnits(usdcOut, 6));
    console.log("- expectedSwapOut (USDC):", ethers.formatUnits(expectedSwapOut, 6));
    console.log("- swapAmountOutMin (USDC):", ethers.formatUnits(swapAmountOutMin, 6));
    console.log("- minUsdcOut (USDC):", ethers.formatUnits(minUsdcOut, 6));
    console.log("- Slippage bps:", SLIPPAGE_BPS.toString());
    console.log(
        "- Decrease minimums (token0/token1):",
        decrease.amount0Min.toString(),
        "/",
        decrease.amount1Min.toString(),
    );
    console.log("- Deadline:", deadline.toString());

    const closeLpData = manager.interface.encodeFunctionData("closeLp", [protocol, closeParams]);
    if (DRY_RUN) {
        console.log("\nDRY_RUN — closeLp calldata:");
        console.log(closeLpData);
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

    if (!(await safeWallet.isModuleEnabled(MANAGER_ADDRESS))) {
        throw new Error("SafeYieldManager is not enabled as a module on this Safe");
    }

    const transactions: MetaTransactionData[] = [
        {
            to: MANAGER_ADDRESS,
            value: "0",
            data: closeLpData,
            operation: OperationType.Call,
        },
    ];

    const safeTransaction = await safeWallet.createTransaction({ transactions });
    const result = await safeWallet.executeTransaction(safeTransaction);
    console.log("Submitted:", result.hash);

    const receipt = await waitForReceipt(provider, result.hash);
    console.log("Confirmed in block", receipt.blockNumber);

    for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== MANAGER_ADDRESS.toLowerCase()) continue;
        let parsed: ReturnType<typeof manager.interface.parseLog>;
        try {
            parsed = manager.interface.parseLog({ topics: [...log.topics], data: log.data });
        } catch {
            continue;
        }
        if (parsed?.name !== "PositionClosed") continue;
        console.log("PositionClosed — tokenId:", parsed.args.tokenId.toString());
        console.log("- Exit bps:", parsed.args.exitBps.toString());
        console.log("- Basis for exit (USD):", ethers.formatUnits(parsed.args.basisUsd6, 6));
        console.log("- Realized value (USD):", ethers.formatUnits(parsed.args.currentValueUsd6, 6));
        console.log("- Performance fee (USD):", ethers.formatUnits(parsed.args.feeUsd6, 6));
        return;
    }
    console.log("No PositionClosed event found in the receipt — check the tx on Basescan.");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
