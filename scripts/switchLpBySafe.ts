import { ethers, network } from "hardhat";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
dotenv.config();
import Safe from "@safe-global/protocol-kit";
import { MetaTransactionData, OperationType } from "@safe-global/types-kit";
import {
    AERODROME_CL_FACTORY_ADDRESS,
    AERODROME_SLIPSTREAM_NPM_ADDRESS,
    UNISWAP_V3_FACTORY_ADDRESS,
    UNISWAP_V3_NPM_ADDRESS,
    USDC_ADDRESS,
    WETH_ADDRESS,
    YieldProtocol,
} from "../contractAddresses";

/**
 * Switches a SafeYieldManager LP position between Uniswap V3 and Aerodrome
 * Slipstream on Base mainnet.
 *
 * Edit the constants below, set TESTING_SAFE_OWNER_KEY (or
 * SAFE_OWNER_PRIVATE_KEY / DEPLOYER_PRIVATE_KEY) in .env, then run:
 *
 *   npx hardhat run scripts/switchLpBySafe.ts --network base
 *
 * The script derives the source close parameters from the existing NFT and
 * the target open parameters from the target pool's current spot price. It
 * starts in DRY_RUN mode so the calldata can be reviewed before submission.
 */

// ─── Configuration ───────────────────────────────────────────────────────
const SAFE_ADDRESS = "0x7319ac30a862f2bf6b146793a42f411215c819ce";
const TOKEN_ID = 5730754n;
const FROM_PROTOCOL_NAME: "aerodrome" | "univ3" = "univ3";
const TO_PROTOCOL_NAME: "aerodrome" | "univ3" = "aerodrome";

// Target Aerodrome tick spacing / UniV3 fee tier.
const TARGET_TICK_SPACING = 100;
const TARGET_FEE_TIER = 500;
// Half-width in raw ticks. Zero means 10 * target pool tick spacing.
const TARGET_TICK_RANGE = 0;

const CLOSE_SLIPPAGE_BPS = 300n;
const OPEN_SLIPPAGE_BPS = 300n;
const MIN_USDC_SLIPPAGE_BPS = 500n;
const MINT_AMOUNT0_MIN = 0n;
const MINT_AMOUNT1_MIN = 0n;
const MANAGER_ADDRESS_OVERRIDE = "";
// Keep true until the calldata and estimates have been reviewed.
const DRY_RUN = true;
// ─────────────────────────────────────────────────────────────────────────

const UNIV3_FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
const AERO_FACTORY_ABI = ["function getPool(address,address,int24) view returns (address)"];
const UNIV3_POOL_ABI = [
    "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
    "function tickSpacing() view returns (int24)",
];
const AERO_POOL_ABI = ["function slot0() view returns (uint160,int24,uint16,uint16,uint16,bool)"];
const UNIV3_NPM_ABI = [
    "function ownerOf(uint256) view returns (address)",
    "function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)",
];
const AERO_NPM_ABI = [
    "function ownerOf(uint256) view returns (address)",
    "function positions(uint256) view returns (uint96,address,address,address,int24,int24,int24,uint128,uint256,uint256,uint128,uint128)",
];

function deployedManagerAddress(): string {
    const file = path.join(__dirname, "../ignition/deployments/chain-8453/deployed_addresses.json");
    const deployed = JSON.parse(fs.readFileSync(file, "utf8"));
    return deployed["DeployYieldManager#SafeYieldManager"];
}

function alignTick(tick: number, spacing: number): number {
    return Math.floor(tick / spacing) * spacing;
}

function sqrtRatioAtTick(tick: number): bigint {
    return BigInt(Math.floor(Math.sqrt(1.0001 ** tick) * 2 ** 96));
}

function amountsForLiquidity(
    sqrtPriceX96: bigint,
    tickLower: number,
    tickUpper: number,
    liquidity: bigint,
): { amount0: bigint; amount1: bigint } {
    const sqrtA = sqrtRatioAtTick(tickLower);
    const sqrtB = sqrtRatioAtTick(tickUpper);
    if (sqrtPriceX96 <= sqrtA) {
        return { amount0: (liquidity * (sqrtB - sqrtA) * (1n << 96n)) / (sqrtA * sqrtB), amount1: 0n };
    }
    if (sqrtPriceX96 >= sqrtB) {
        return { amount0: 0n, amount1: (liquidity * (sqrtB - sqrtA)) / (1n << 96n) };
    }
    return {
        amount0: (liquidity * (sqrtB - sqrtPriceX96) * (1n << 96n)) / (sqrtPriceX96 * sqrtB),
        amount1: (liquidity * (sqrtPriceX96 - sqrtA)) / (1n << 96n),
    };
}

type PoolInfo = {
    protocol: number;
    poolParam: string;
    poolAddress: string;
    sqrtPriceX96: bigint;
    tick: number;
    tickSpacing: number;
};

async function resolvePool(
    provider: any,
    abi: any,
    protocolName: "aerodrome" | "univ3",
    poolParamValue: number,
): Promise<PoolInfo> {
    if (protocolName === "aerodrome") {
        const poolParam = abi.encode(["address", "address", "int24"], [WETH_ADDRESS, USDC_ADDRESS, poolParamValue]);
        const factory = new ethers.Contract(AERODROME_CL_FACTORY_ADDRESS, AERO_FACTORY_ABI, provider);
        const poolAddress: string = await factory.getPool(WETH_ADDRESS, USDC_ADDRESS, poolParamValue);
        if (poolAddress === ethers.ZeroAddress) throw new Error(`No Aerodrome pool for tickSpacing ${poolParamValue}`);
        const pool = new ethers.Contract(poolAddress, AERO_POOL_ABI, provider);
        const [sqrtPrice, tick] = await pool.slot0();
        return {
            protocol: YieldProtocol.AERODROME,
            poolParam,
            poolAddress,
            sqrtPriceX96: BigInt(sqrtPrice),
            tick: Number(tick),
            tickSpacing: poolParamValue,
        };
    }

    const poolParam = abi.encode(["address", "address", "uint24"], [WETH_ADDRESS, USDC_ADDRESS, poolParamValue]);
    const factory = new ethers.Contract(UNISWAP_V3_FACTORY_ADDRESS, UNIV3_FACTORY_ABI, provider);
    const poolAddress: string = await factory.getPool(WETH_ADDRESS, USDC_ADDRESS, poolParamValue);
    if (poolAddress === ethers.ZeroAddress) throw new Error(`No Uniswap V3 pool for fee tier ${poolParamValue}`);
    const pool = new ethers.Contract(poolAddress, UNIV3_POOL_ABI, provider);
    const [sqrtPrice, tick] = await pool.slot0();
    return {
        protocol: YieldProtocol.UNISWAP_V3,
        poolParam,
        poolAddress,
        sqrtPriceX96: BigInt(sqrtPrice),
        tick: Number(tick),
        tickSpacing: Number(await pool.tickSpacing()),
    };
}

async function main() {
    const OWNER_KEY =
        process.env.TESTING_SAFE_OWNER_KEY ||
        process.env.SAFE_OWNER_PRIVATE_KEY ||
        process.env.DEPLOYER_PRIVATE_KEY ||
        "";
    const MANAGER_ADDRESS = MANAGER_ADDRESS_OVERRIDE || deployedManagerAddress();

    if (!ethers.isAddress(SAFE_ADDRESS)) throw new Error(`Invalid SAFE_ADDRESS: ${SAFE_ADDRESS}`);
    if (!ethers.isAddress(MANAGER_ADDRESS)) throw new Error(`Invalid SafeYieldManager address: ${MANAGER_ADDRESS}`);
    if (!OWNER_KEY) throw new Error("Set TESTING_SAFE_OWNER_KEY (or SAFE_OWNER_PRIVATE_KEY) in .env");
    if (FROM_PROTOCOL_NAME === TO_PROTOCOL_NAME) {
        console.warn("Source and target protocols are the same; only the pool parameter/range will change.");
    }

    const provider = ethers.provider;
    const abi = ethers.AbiCoder.defaultAbiCoder();
    const manager = await ethers.getContractAt("SafeYieldManager", MANAGER_ADDRESS);

    const sourceNpmAddress =
        FROM_PROTOCOL_NAME === "aerodrome" ? AERODROME_SLIPSTREAM_NPM_ADDRESS : UNISWAP_V3_NPM_ADDRESS;
    const sourceNpm = new ethers.Contract(
        sourceNpmAddress,
        FROM_PROTOCOL_NAME === "aerodrome" ? AERO_NPM_ABI : UNIV3_NPM_ABI,
        provider,
    );
    const owner: string = await sourceNpm.ownerOf(TOKEN_ID);
    if (owner.toLowerCase() !== SAFE_ADDRESS.toLowerCase()) {
        throw new Error(`Token ${TOKEN_ID} is owned by ${owner}, not SAFE_ADDRESS ${SAFE_ADDRESS}`);
    }
    const position = await sourceNpm.positions(TOKEN_ID);
    const token0: string = position[2];
    const token1: string = position[3];
    if (token0.toLowerCase() !== WETH_ADDRESS.toLowerCase() || token1.toLowerCase() !== USDC_ADDRESS.toLowerCase()) {
        throw new Error(`Token ${TOKEN_ID} is not a WETH/USDC position`);
    }
    const sourcePoolValue = Number(position[4]);
    const source = await resolvePool(provider, abi, FROM_PROTOCOL_NAME, sourcePoolValue);
    const targetValue = TO_PROTOCOL_NAME === "aerodrome" ? TARGET_TICK_SPACING : TARGET_FEE_TIER;
    const target = await resolvePool(provider, abi, TO_PROTOCOL_NAME, targetValue);

    const sourceTickLower = Number(position[5]);
    const sourceTickUpper = Number(position[6]);
    const liquidity: bigint = BigInt(position[7]);
    if (liquidity === 0n) throw new Error(`Token ${TOKEN_ID} has zero liquidity`);

    const withdrawn = amountsForLiquidity(source.sqrtPriceX96, sourceTickLower, sourceTickUpper, liquidity);
    let closeExpectedSwapOut = (withdrawn.amount0 * source.sqrtPriceX96 * source.sqrtPriceX96) >> 192n;
    if (closeExpectedSwapOut === 0n) closeExpectedSwapOut = 1n;
    let closeSwapAmountOutMin = (closeExpectedSwapOut * (10_000n - CLOSE_SLIPPAGE_BPS)) / 10_000n;
    if (closeSwapAmountOutMin === 0n) closeSwapAmountOutMin = 1n;
    const realizedEstimate = withdrawn.amount1 + closeExpectedSwapOut;
    const targetTickRange = TARGET_TICK_RANGE || target.tickSpacing * 10;
    const targetAlignedTick = alignTick(target.tick, target.tickSpacing);
    const tickLower = alignTick(targetAlignedTick - targetTickRange, target.tickSpacing);
    const tickUpper = alignTick(targetAlignedTick + targetTickRange, target.tickSpacing);
    if (tickLower >= tickUpper) throw new Error("Target tick range is invalid");

    const openExpectedSwapOut = ((realizedEstimate / 2n) << 192n) / (target.sqrtPriceX96 * target.sqrtPriceX96);
    if (openExpectedSwapOut === 0n) throw new Error("Estimated open swap output rounds to zero");
    const openSwapAmountOutMin = (openExpectedSwapOut * (10_000n - OPEN_SLIPPAGE_BPS)) / 10_000n;
    const minUsdcOut = (realizedEstimate * (10_000n - MIN_USDC_SLIPPAGE_BPS)) / 10_000n;

    const maxSlippageBps: bigint = await manager.maxSlippageBps();
    for (const [name, value] of [
        ["CLOSE_SLIPPAGE_BPS", CLOSE_SLIPPAGE_BPS],
        ["OPEN_SLIPPAGE_BPS", OPEN_SLIPPAGE_BPS],
    ] as [string, bigint][]) {
        if (value === 0n || value > maxSlippageBps) throw new Error(`${name} must be in 1..${maxSlippageBps}`);
    }
    if (!(await manager.protocolEnabledForClose(source.protocol)))
        throw new Error("Source protocol is disabled for close");
    if (!(await manager.protocolEnabledForOpen(target.protocol)))
        throw new Error("Target protocol is disabled for open");
    const pinnedHandler: string = await manager.positionHandlerOf(source.protocol, TOKEN_ID);
    if (pinnedHandler === ethers.ZeroAddress) throw new Error(`Token ${TOKEN_ID} is not managed by SafeYieldManager`);

    const block = await provider.getBlock("latest");
    const deadline = BigInt(block!.timestamp) + 1_200n;
    const params = {
        onBehalfOf: SAFE_ADDRESS,
        tokenId: TOKEN_ID,
        // WETH is token0 on Base; the USDC side needs no swap leg.
        closeSwap0: { amountOutMin: closeSwapAmountOutMin, expectedOut: closeExpectedSwapOut, poolParam: source.poolParam },
        closeSwap1: { amountOutMin: 0, expectedOut: 0, poolParam: "0x" },
        closeSlippageBps: CLOSE_SLIPPAGE_BPS,
        decreaseAmount0Min: 0n,
        decreaseAmount1Min: 0n,
        minUsdcOut,
        tickLower,
        tickUpper,
        mintAmount0Min: MINT_AMOUNT0_MIN,
        mintAmount1Min: MINT_AMOUNT1_MIN,
        openSwap0: { amountOutMin: openSwapAmountOutMin, expectedOut: openExpectedSwapOut, poolParam: target.poolParam },
        openSwap1: { amountOutMin: 0, expectedOut: 0, poolParam: "0x" },
        openSlippageBps: OPEN_SLIPPAGE_BPS,
        lpPoolParam: target.poolParam,
        deadline,
    };

    console.log("Configuration:");
    console.log("- SafeYieldManager:", MANAGER_ADDRESS);
    console.log("- Safe:", SAFE_ADDRESS);
    console.log("- Source:", FROM_PROTOCOL_NAME, `(id ${source.protocol})`, "pool", source.poolAddress);
    console.log("- Target:", TO_PROTOCOL_NAME, `(id ${target.protocol})`, "pool", target.poolAddress);
    console.log("- Token id:", TOKEN_ID.toString());
    console.log("- Source range:", sourceTickLower, "..", sourceTickUpper, "| liquidity:", liquidity.toString());
    console.log("- Target range:", tickLower, "..", tickUpper);
    console.log("- Estimated USDC realized:", ethers.formatUnits(realizedEstimate, 6));
    console.log("- Close expected swap out (USDC):", ethers.formatUnits(closeExpectedSwapOut, 6));
    console.log("- Open expected swap out (WETH):", ethers.formatEther(openExpectedSwapOut));
    console.log("- minUsdcOut (USDC):", ethers.formatUnits(minUsdcOut, 6));
    console.log("- Deadline:", deadline.toString());

    const switchLpData = manager.interface.encodeFunctionData("switchLp", [source.protocol, target.protocol, params]);
    if (DRY_RUN) {
        console.log("\nDRY_RUN — switchLp calldata:");
        console.log(switchLpData);
        return;
    }

    const rpcUrl = (network.config as { url?: string }).url;
    if (!rpcUrl) throw new Error(`Network ${network.name} has no RPC url — run with --network base`);
    const safeWallet = await Safe.init({ provider: rpcUrl, signer: OWNER_KEY, safeAddress: SAFE_ADDRESS });
    const threshold = await safeWallet.getThreshold();
    if (threshold > 1) throw new Error("Safe threshold is greater than 1; use DRY_RUN and propose through the Safe UI");
    if (!(await safeWallet.isModuleEnabled(MANAGER_ADDRESS))) {
        throw new Error("SafeYieldManager is not enabled as a module on this Safe");
    }

    const transactions: MetaTransactionData[] = [
        { to: MANAGER_ADDRESS, value: "0", data: switchLpData, operation: OperationType.Call },
    ];
    const safeTransaction = await safeWallet.createTransaction({ transactions });
    const result = await safeWallet.executeTransaction(safeTransaction);
    console.log("Submitted:", result.hash);

    let receipt = await provider.getTransactionReceipt(result.hash);
    for (let i = 0; i < 60 && !receipt; i++) {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        receipt = await provider.getTransactionReceipt(result.hash);
    }
    if (!receipt || receipt.status !== 1) throw new Error(`Transaction failed or timed out: ${result.hash}`);
    console.log("Confirmed in block", receipt.blockNumber);

    for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== MANAGER_ADDRESS.toLowerCase()) continue;
        try {
            const parsed = manager.interface.parseLog({ topics: [...log.topics], data: log.data });
            if (parsed?.name === "PositionSwitched") {
                console.log("PositionSwitched — old token:", parsed.args.oldTokenId.toString());
                console.log("- New token:", parsed.args.newTokenId.toString());
                console.log("- Carried basis (USD):", ethers.formatUnits(parsed.args.carriedBasisUsd6, 6));
                console.log("- Performance fee (USD):", ethers.formatUnits(parsed.args.feeUsd6, 6));
                return;
            }
        } catch {
            // Ignore unrelated manager logs.
        }
    }
    console.log("No PositionSwitched event found in the receipt — check the tx on Basescan.");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
