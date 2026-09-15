import { ethers, network } from "hardhat";
import dotenv from "dotenv";
dotenv.config();
import Safe from "@safe-global/protocol-kit";
import { MetaTransactionData, OperationType } from "@safe-global/types-kit";
import {
    AERODROME_CL_FACTORY_ADDRESS,
    AERODROME_SLIPSTREAM_NPM_ADDRESS,
    AERODROME_VOTER_ADDRESS,
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
    alignTick,
    amountsForLiquidity,
    decreaseMinimums,
    switchMintMinimums,
    deployedManagerAddress,
    resolveOwnerKey,
    unpackV4PositionTicks,
    waitForReceipt,
} from "./lpSafeShared";

/**
 * Switches a SafeYieldManager LP position between Uniswap V3 and Aerodrome
 * Slipstream on Base mainnet.
 *
 * Edit the constants below, set TESTING_SAFE_OWNER_KEY (or
 * SAFE_OWNER_PRIVATE_KEY / DEPLOYER_PRIVATE_KEY) in .env, then run:
 *
 *   npx hardhat run scripts/switchLpBySafe.ts --network base
 *
 * The switch is IN KIND: the withdrawn token amounts are redeployed into the
 * target pool directly, with no swaps. The script only derives the target
 * tick range from the target pool's current spot price and logs the estimated
 * withdrawal for review. It starts in DRY_RUN mode so the calldata can be
 * reviewed before submission.
 */

// ─── Configuration ───────────────────────────────────────────────────────
const SAFE_ADDRESS = process.env.TESTING_SAFE_WALLET_ADDRESS || "";
const TOKEN_ID = 74555704n;
const FROM_PROTOCOL_NAME: "aerodrome" | "univ3" | "univ4" = "aerodrome";
const TO_PROTOCOL_NAME: "aerodrome" | "univ3" | "univ4" = "univ4";

// Target Aerodrome tick spacing / UniV3 fee tier.
const TARGET_TICK_SPACING = 100;
const TARGET_FEE_TIER = 500;
// Target Uniswap V4 PoolKey fields — used when TO_PROTOCOL_NAME is "univ4".
const TARGET_V4_FEE_TIER = 500;
const TARGET_V4_TICK_SPACING = 10;
const TARGET_V4_USE_NATIVE_ETH = true;
const TARGET_V4_HOOKS = "0x0000000000000000000000000000000000000000";
// Half-width in raw ticks. Zero means 10 * target pool tick spacing.
const TARGET_TICK_RANGE = 0;

// Slippage applied to the withdraw-leg floors, and to the destination mint
// floors that are derived from them.
const DECREASE_SLIPPAGE_BPS: bigint = 100n;
const MINT_SLIPPAGE_BPS: bigint = 100n;
const MANAGER_ADDRESS_OVERRIDE = "";
// Keep true until the calldata and estimates have been reviewed.
const DRY_RUN = true;
// ─────────────────────────────────────────────────────────────────────────

type PoolInfo = {
    protocol: number;
    poolParam: string;
    poolAddress: string;
    sqrtPriceX96: bigint;
    tick: number;
    tickSpacing: number;
};

async function resolveV4Pool(poolParam: string, tickSpacing: number): Promise<PoolInfo> {
    const poolId = ethers.keccak256(poolParam);
    const stateView = new ethers.Contract(UNISWAP_V4_STATE_VIEW_ADDRESS, UNIV4_STATE_VIEW_ABI, ethers.provider);
    const [sqrtPrice, tick] = await stateView.getSlot0(poolId);
    if (BigInt(sqrtPrice) === 0n) throw new Error(`V4 pool not initialized: ${poolId}`);
    return {
        protocol: YieldProtocol.UNISWAP_V4,
        poolParam,
        poolAddress: `V4 PoolManager (poolId ${poolId})`,
        sqrtPriceX96: BigInt(sqrtPrice),
        tick: Number(tick),
        tickSpacing,
    };
}

async function resolvePool(protocolName: "aerodrome" | "univ3" | "univ4", poolParamValue: number): Promise<PoolInfo> {
    const provider = ethers.provider;
    if (protocolName === "univ4") {
        const currency0 = TARGET_V4_USE_NATIVE_ETH ? ethers.ZeroAddress : WETH_ADDRESS;
        const poolParam = encodeUniV4PoolParam(
            currency0,
            USDC_ADDRESS,
            TARGET_V4_FEE_TIER,
            TARGET_V4_TICK_SPACING,
            TARGET_V4_HOOKS,
        );
        return resolveV4Pool(poolParam, TARGET_V4_TICK_SPACING);
    }
    if (protocolName === "aerodrome") {
        const poolParam = encodeAerodromePoolParam(WETH_ADDRESS, USDC_ADDRESS, poolParamValue);
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

    const poolParam = encodeUniV3PoolParam(WETH_ADDRESS, USDC_ADDRESS, poolParamValue);
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
    const OWNER_KEY = resolveOwnerKey();
    const MANAGER_ADDRESS = MANAGER_ADDRESS_OVERRIDE || deployedManagerAddress();

    if (!ethers.isAddress(SAFE_ADDRESS)) throw new Error(`Invalid SAFE_ADDRESS: ${SAFE_ADDRESS}`);
    if (!ethers.isAddress(MANAGER_ADDRESS)) throw new Error(`Invalid SafeYieldManager address: ${MANAGER_ADDRESS}`);
    if (!OWNER_KEY) throw new Error("Set TESTING_SAFE_OWNER_KEY (or SAFE_OWNER_PRIVATE_KEY) in .env");
    if (FROM_PROTOCOL_NAME === TO_PROTOCOL_NAME) {
        console.warn("Source and target protocols are the same; only the pool parameter/range will change.");
    }

    const provider = ethers.provider;
    const manager = await ethers.getContractAt("SafeYieldManager", MANAGER_ADDRESS);

    let source: PoolInfo;
    let sourceTickLower: number;
    let sourceTickUpper: number;
    let liquidity: bigint;

    if (FROM_PROTOCOL_NAME === "univ4") {
        const pm = new ethers.Contract(UNISWAP_V4_POSITION_MANAGER_ADDRESS, UNIV4_PM_ABI, provider);
        const owner: string = await pm.ownerOf(TOKEN_ID);
        if (owner.toLowerCase() !== SAFE_ADDRESS.toLowerCase()) {
            throw new Error(`Token ${TOKEN_ID} is owned by ${owner}, not SAFE_ADDRESS ${SAFE_ADDRESS}`);
        }
        const [key, info] = await pm.getPoolAndPositionInfo(TOKEN_ID);
        const currency0Ok =
            key.currency0 === ethers.ZeroAddress || key.currency0.toLowerCase() === WETH_ADDRESS.toLowerCase();
        if (!currency0Ok || key.currency1.toLowerCase() !== USDC_ADDRESS.toLowerCase()) {
            throw new Error(`Token ${TOKEN_ID} is not an ETH/USDC or WETH/USDC V4 position`);
        }
        const poolParam = encodeUniV4PoolParam(key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks);
        source = await resolveV4Pool(poolParam, Number(key.tickSpacing));
        ({ tickLower: sourceTickLower, tickUpper: sourceTickUpper } = unpackV4PositionTicks(BigInt(info)));
        liquidity = await pm.getPositionLiquidity(TOKEN_ID);
    } else {
        const sourceNpmAddress =
            FROM_PROTOCOL_NAME === "aerodrome" ? AERODROME_SLIPSTREAM_NPM_ADDRESS : UNISWAP_V3_NPM_ADDRESS;
        const sourceNpm = new ethers.Contract(
            sourceNpmAddress,
            FROM_PROTOCOL_NAME === "aerodrome" ? AERO_NPM_ABI : UNIV3_NPM_ABI,
            provider,
        );
        const owner: string = await sourceNpm.ownerOf(TOKEN_ID);
        const position = await sourceNpm.positions(TOKEN_ID);
        const token0: string = position[2];
        const token1: string = position[3];
        // A staked Aerodrome position is owned by its gauge, not the Safe;
        // switchLp's close leg unstakes it on-chain. Accept the Safe OR the
        // pool's gauge as owner.
        let ownerOk = owner.toLowerCase() === SAFE_ADDRESS.toLowerCase();
        if (!ownerOk && FROM_PROTOCOL_NAME === "aerodrome") {
            const clFactory = new ethers.Contract(AERODROME_CL_FACTORY_ADDRESS, AERO_FACTORY_ABI, provider);
            const srcPool = await clFactory.getPool(token0, token1, Number(position[4]));
            const voter = new ethers.Contract(
                AERODROME_VOTER_ADDRESS,
                ["function gauges(address) view returns (address)"],
                provider,
            );
            const gauge: string = await voter.gauges(srcPool);
            ownerOk = gauge !== ethers.ZeroAddress && owner.toLowerCase() === gauge.toLowerCase();
            if (ownerOk) console.log(`- Source position is STAKED in gauge ${gauge} (switch will unstake it)`);
        }
        if (!ownerOk) {
            throw new Error(`Token ${TOKEN_ID} is owned by ${owner}, not the Safe or its gauge`);
        }
        if (
            token0.toLowerCase() !== WETH_ADDRESS.toLowerCase() ||
            token1.toLowerCase() !== USDC_ADDRESS.toLowerCase()
        ) {
            throw new Error(`Token ${TOKEN_ID} is not a WETH/USDC position`);
        }
        source = await resolvePool(FROM_PROTOCOL_NAME, Number(position[4]));
        sourceTickLower = Number(position[5]);
        sourceTickUpper = Number(position[6]);
        liquidity = BigInt(position[7]);
    }
    if (liquidity === 0n) throw new Error(`Token ${TOKEN_ID} has zero liquidity`);

    const targetValue = TO_PROTOCOL_NAME === "aerodrome" ? TARGET_TICK_SPACING : TARGET_FEE_TIER;
    const target = await resolvePool(TO_PROTOCOL_NAME, targetValue);

    const withdrawn = amountsForLiquidity(source.sqrtPriceX96, sourceTickLower, sourceTickUpper, liquidity);
    // The switch is in kind, so the withdraw leg's floors ARE the budget the
    // destination mint has to work with.
    const decrease = decreaseMinimums(
        { sqrtPriceX96: source.sqrtPriceX96, tickLower: sourceTickLower, tickUpper: sourceTickUpper },
        liquidity,
        10_000n,
        DECREASE_SLIPPAGE_BPS,
    );
    const targetTickRange = TARGET_TICK_RANGE || target.tickSpacing * 10;
    const targetAlignedTick = alignTick(target.tick, target.tickSpacing);
    const tickLower = alignTick(targetAlignedTick - targetTickRange, target.tickSpacing);
    const tickUpper = alignTick(targetAlignedTick + targetTickRange, target.tickSpacing);
    if (tickLower >= tickUpper) throw new Error("Target tick range is invalid");

    if (!(await manager.protocolEnabledForClose(source.protocol)))
        throw new Error("Source protocol is disabled for close");
    if (!(await manager.protocolEnabledForOpen(target.protocol)))
        throw new Error("Target protocol is disabled for open");
    const pinnedHandler: string = await manager.positionHandlerOf(source.protocol, TOKEN_ID);
    if (pinnedHandler === ethers.ZeroAddress) throw new Error(`Token ${TOKEN_ID} is not managed by SafeYieldManager`);

    // Size the mint floors from the WORST accepted withdrawal, never from the
    // optimistic estimate: a transaction that satisfies the withdraw leg must
    // not then revert on the open leg.
    const mint = switchMintMinimums(
        { sqrtPriceX96: target.sqrtPriceX96, tickLower, tickUpper },
        decrease.amount0Min,
        decrease.amount1Min,
        MINT_SLIPPAGE_BPS,
    );

    const block = await provider.getBlock("latest");
    const deadline = BigInt(block!.timestamp) + 1_200n;
    const params = {
        onBehalfOf: SAFE_ADDRESS,
        tokenId: TOKEN_ID,
        decreaseAmount0Min: decrease.amount0Min,
        decreaseAmount1Min: decrease.amount1Min,
        tickLower,
        tickUpper,
        mintAmount0Min: mint.amount0Min,
        mintAmount1Min: mint.amount1Min,
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
    console.log("- Estimated withdrawal (WETH/ETH):", ethers.formatEther(withdrawn.amount0));
    console.log("- Estimated withdrawal (USDC):", ethers.formatUnits(withdrawn.amount1, 6));
    console.log(
        "- Decrease minimums (token0/token1):",
        decrease.amount0Min.toString(),
        "/",
        decrease.amount1Min.toString(),
    );
    console.log("- Mint minimums (token0/token1):", mint.amount0Min.toString(), "/", mint.amount1Min.toString());
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

    const receipt = await waitForReceipt(provider, result.hash);
    console.log("Confirmed in block", receipt.blockNumber);

    for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== MANAGER_ADDRESS.toLowerCase()) continue;
        try {
            const parsed = manager.interface.parseLog({ topics: [...log.topics], data: log.data });
            if (parsed?.name === "PositionSwitched") {
                console.log("PositionSwitched — old token:", parsed.args.oldTokenId.toString());
                console.log("- New token:", parsed.args.newTokenId.toString());
                console.log("- Carried basis (USD):", ethers.formatUnits(parsed.args.carriedBasisUsd6, 6));
                console.log("- Withdrawn:", parsed.args.withdrawn0.toString(), "/", parsed.args.withdrawn1.toString());
                console.log("- Deployed:", parsed.args.used0.toString(), "/", parsed.args.used1.toString());
                // In kind: no swaps, no performance fee — the basis carries over unchanged.
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
