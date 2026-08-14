import { ethers, network } from "hardhat";
import dotenv from "dotenv";
dotenv.config();
import Safe from "@safe-global/protocol-kit";
import { MetaTransactionData, OperationType } from "@safe-global/types-kit";
import {
    AERO_ADDRESS,
    AERODROME_CL_FACTORY_ADDRESS,
    AERODROME_SLIPSTREAM_NPM_ADDRESS,
    AERODROME_VOTER_ADDRESS,
    UNISWAP_V3_NPM_ADDRESS,
    UNISWAP_V4_POSITION_MANAGER_ADDRESS,
    USDC_ADDRESS,
    WETH_ADDRESS,
    YieldProtocol,
    encodeAerodromePoolParam,
    encodeUniV3PoolParam,
    encodeUniV4PoolParam,
} from "../contractAddresses";
import {
    AERO_NPM_ABI,
    UNIV3_NPM_ABI,
    UNIV4_PM_ABI,
    deployedManagerAddress,
    resolveOwnerKey,
    waitForReceipt,
} from "./lpSafeShared";

/**
 * Harvests accrued LP fees of a position on the deployed SafeYieldManager
 * (Base mainnet) FROM the user's own Safe (msg.sender == Safe path of
 * `onlyOperatorOrSafe`) without exiting it.
 *
 * Edit the configuration constants below, set TESTING_SAFE_OWNER_KEY (or
 * SAFE_OWNER_PRIVATE_KEY / DEPLOYER_PRIVATE_KEY) in .env, then run:
 *
 *   npx hardhat run scripts/collectLpBySafe.ts --network base
 *
 * With SWAP_FEES_TO_USDC = false the harvest lands on the Safe in the pool's
 * own tokens (minus feeCollectBps). Setting it true swaps the non-USDC side
 * to USDC through the position's own pool; the swap legs carry only absolute
 * floors (fee amounts are unknown until the collect), so leave it false for
 * dust-sized positions where the swap output could round to zero.
 */

// ─── Configuration ───────────────────────────────────────────────────────
const SAFE_ADDRESS: string = process.env.TESTING_SAFE_WALLET_ADDRESS || "";
const PROTOCOL_NAME: "aerodrome" | "univ3" | "univ4" = "aerodrome";
const TOKEN_ID = 74555704n;
const SWAP_FEES_TO_USDC = false;
// Swap the AERO staking reward claimed from the gauge to USDC through the
// rewardSwap leg (staked Aerodrome positions only; ignored otherwise). The
// AERO/USDC pool at REWARD_TICK_SPACING must be allow-listed on the manager.
const SWAP_REWARD_TO_USDC = false;
const REWARD_TICK_SPACING = 100;
const SLIPPAGE_BPS: bigint = 100n;
// Aerodrome tick spacing (100 or 200) — used when PROTOCOL_NAME is "aerodrome"
const TICK_SPACING = 100;
// UniV3 fee tier (100 / 500 / 3000) — used when PROTOCOL_NAME is "univ3"
const FEE_TIER = 500;
// Empty = use the ignition-deployed address for chain 8453
const MANAGER_ADDRESS_OVERRIDE = "";
// true = print the resolved params and calldata without executing
const DRY_RUN = true;
// ─────────────────────────────────────────────────────────────────────────

const ZERO_LEG = { amountOutMin: 0n, expectedOut: 0n, poolParam: "0x" };

async function main() {
    const OWNER_KEY = resolveOwnerKey();
    const MANAGER_ADDRESS = MANAGER_ADDRESS_OVERRIDE || deployedManagerAddress();

    if (!SAFE_ADDRESS) throw new Error("Set TESTING_SAFE_WALLET_ADDRESS in .env");
    if (!OWNER_KEY) throw new Error("Set TESTING_SAFE_OWNER_KEY (or SAFE_OWNER_PRIVATE_KEY) in .env");
    if (!ethers.isAddress(SAFE_ADDRESS)) throw new Error(`Invalid SAFE_ADDRESS: ${SAFE_ADDRESS}`);

    const provider = ethers.provider;

    let protocol: number;
    let poolParam: string;

    if (PROTOCOL_NAME === "univ4") {
        protocol = YieldProtocol.UNISWAP_V4;
        // The position's own PoolKey is the pool identity; the swap legs (when
        // enabled) route through the same pool.
        const pm = new ethers.Contract(UNISWAP_V4_POSITION_MANAGER_ADDRESS, UNIV4_PM_ABI, provider);
        const [key] = await pm.getPoolAndPositionInfo(TOKEN_ID);
        if (key.currency1.toLowerCase() !== USDC_ADDRESS.toLowerCase()) {
            throw new Error(`Token ${TOKEN_ID} is not a */USDC V4 position`);
        }
        poolParam = encodeUniV4PoolParam(key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks);
        const owner: string = await pm.ownerOf(TOKEN_ID);
        if (owner.toLowerCase() !== SAFE_ADDRESS.toLowerCase()) {
            throw new Error(`Position ${TOKEN_ID} is owned by ${owner}, not the Safe`);
        }
    } else if (PROTOCOL_NAME === "aerodrome") {
        protocol = YieldProtocol.AERODROME;
        poolParam = encodeAerodromePoolParam(WETH_ADDRESS, USDC_ADDRESS, TICK_SPACING);
        const npm = new ethers.Contract(AERODROME_SLIPSTREAM_NPM_ADDRESS, AERO_NPM_ABI, provider);
        await npm.positions(TOKEN_ID); // existence check (staked positions are owned by the stakePool)
    } else {
        protocol = YieldProtocol.UNISWAP_V3;
        poolParam = encodeUniV3PoolParam(WETH_ADDRESS, USDC_ADDRESS, FEE_TIER);
        const npm = new ethers.Contract(UNISWAP_V3_NPM_ADDRESS, UNIV3_NPM_ABI, provider);
        const owner: string = await npm.ownerOf(TOKEN_ID);
        if (owner.toLowerCase() !== SAFE_ADDRESS.toLowerCase()) {
            throw new Error(`Position ${TOKEN_ID} is owned by ${owner}, not the Safe`);
        }
    }

    const manager = await ethers.getContractAt("SafeYieldManager", MANAGER_ADDRESS);
    if (!(await manager.protocolEnabledForClose(protocol))) {
        throw new Error(`Protocol ${PROTOCOL_NAME} (${protocol}) is disabled for close/collect`);
    }
    if ((await manager.positionHandlerOf(protocol, TOKEN_ID)) === ethers.ZeroAddress) {
        throw new Error(`Position ${TOKEN_ID} was not opened through this manager`);
    }

    const block = await provider.getBlock("latest");
    const deadline = BigInt(block!.timestamp) + 1_200n;

    // Build the AERO -> USDC reward-swap leg from the gauge's currently-earned
    // AERO priced at the AERO/USDC pool spot. The handler swaps only the newly
    // claimed delta, which is >= `earned` now (it keeps accruing until exec),
    // so an amountOutMin derived from `earned` stays a safe floor.
    let rewardLeg = ZERO_LEG as { amountOutMin: bigint; expectedOut: bigint; poolParam: string };
    if (SWAP_REWARD_TO_USDC) {
        if (PROTOCOL_NAME !== "aerodrome") throw new Error("swapRewardToUsdc is only meaningful for staked Aerodrome");
        const [aeroT0, aeroT1] =
            AERO_ADDRESS.toLowerCase() < USDC_ADDRESS.toLowerCase()
                ? [AERO_ADDRESS, USDC_ADDRESS]
                : [USDC_ADDRESS, AERO_ADDRESS];
        const rewardPoolParam = encodeAerodromePoolParam(aeroT0, aeroT1, REWARD_TICK_SPACING);
        if (!(await manager.isPoolParamAllowed(protocol, rewardPoolParam))) {
            throw new Error(`AERO/USDC pool (ts ${REWARD_TICK_SPACING}) is not allow-listed on the manager`);
        }
        const voter = new ethers.Contract(
            AERODROME_VOTER_ADDRESS,
            ["function gauges(address) view returns (address)"],
            provider,
        );
        const clFactory = new ethers.Contract(
            AERODROME_CL_FACTORY_ADDRESS,
            ["function getPool(address,address,int24) view returns (address)"],
            provider,
        );
        const lpPool = await clFactory.getPool(WETH_ADDRESS, USDC_ADDRESS, TICK_SPACING);
        const gaugeAddr: string = await voter.gauges(lpPool);
        const gauge = new ethers.Contract(
            gaugeAddr,
            ["function earned(address,uint256) view returns (uint256)"],
            provider,
        );
        const earnedAero: bigint = await gauge.earned(SAFE_ADDRESS, TOKEN_ID);
        if (earnedAero === 0n) throw new Error("No AERO earned yet — nothing to swap");

        const aeroUsdcPool = await clFactory.getPool(aeroT0, aeroT1, REWARD_TICK_SPACING);
        const pool = new ethers.Contract(aeroUsdcPool, ["function slot0() view returns (uint160,int24,uint16,uint16,uint16,bool)"], provider);
        const [sqrtP] = await pool.slot0();
        const sp = BigInt(sqrtP);
        // token0 = USDC (6dp), token1 = AERO (18dp): AERO(token1) -> USDC(token0)
        // out ≈ amountIn * 2^192 / sqrtP^2.
        const expectedUsdcOut = (earnedAero * (1n << 192n)) / (sp * sp);
        if (expectedUsdcOut === 0n) throw new Error("Earned AERO too small: USDC swap output rounds to zero");
        const rewardAmountOutMin = (expectedUsdcOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;
        rewardLeg = {
            amountOutMin: rewardAmountOutMin === 0n ? 1n : rewardAmountOutMin,
            expectedOut: expectedUsdcOut,
            poolParam: rewardPoolParam,
        };
        console.log("- earned AERO (wei):", earnedAero.toString());
        console.log("- reward expectedUsdcOut (6dp):", expectedUsdcOut.toString());
        console.log("- reward amountOutMin (6dp):", rewardLeg.amountOutMin.toString());
    }

    // Fee amounts are unknown until the collect executes, so the fee swap legs
    // carry the minimal validated floors (expectedOut/amountOutMin = 1).
    const feeLeg = { amountOutMin: 1n, expectedOut: 1n, poolParam };
    const collectParams = {
        onBehalfOf: SAFE_ADDRESS,
        tokenId: TOKEN_ID,
        swapFeesToUsdc: SWAP_FEES_TO_USDC,
        swap0: SWAP_FEES_TO_USDC ? feeLeg : ZERO_LEG,
        swap1: ZERO_LEG, // USDC side never needs a swap leg
        swapRewardToUsdc: SWAP_REWARD_TO_USDC,
        rewardSwap: rewardLeg,
        slippageBps: SLIPPAGE_BPS,
        deadline,
    };

    console.log("Configuration:");
    console.log("- SafeYieldManager:", MANAGER_ADDRESS);
    console.log("- Safe:", SAFE_ADDRESS);
    console.log("- Protocol:", PROTOCOL_NAME, `(id ${protocol})`);
    console.log("- Token id:", TOKEN_ID.toString());
    console.log("- swapFeesToUsdc:", SWAP_FEES_TO_USDC);
    console.log("- swapRewardToUsdc:", SWAP_REWARD_TO_USDC);
    console.log("- Deadline:", deadline.toString());

    const collectLpData = manager.interface.encodeFunctionData("collectLp", [protocol, collectParams]);
    if (DRY_RUN) {
        console.log("\nDRY_RUN — collectLp calldata:");
        console.log(collectLpData);
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
            data: collectLpData,
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
        if (parsed?.name !== "FeesCollected") continue;
        console.log("FeesCollected — tokenId:", parsed.args.tokenId.toString());
        console.log("- token0:", parsed.args.token0, "collected:", parsed.args.collected0.toString(), "fee:", parsed.args.fee0.toString());
        console.log("- token1:", parsed.args.token1, "collected:", parsed.args.collected1.toString(), "fee:", parsed.args.fee1.toString());
        return;
    }
    console.log("No FeesCollected event found in the receipt — check the tx on Basescan.");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
