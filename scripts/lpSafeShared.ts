import fs from "fs";
import path from "path";

/**
 * Shared helpers for the openLpBySafe / closeLpBySafe / switchLpBySafe ops
 * scripts: minimal ABI fragments, the ignition deployment lookup, tick /
 * liquidity math, and the receipt-polling workaround. One copy so a slot0
 * arity, deployment key, or math change cannot drift between the scripts.
 */

export const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
export const UNIV3_FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
export const AERO_FACTORY_ABI = ["function getPool(address,address,int24) view returns (address)"];
export const UNIV3_POOL_ABI = [
    "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
    "function tickSpacing() view returns (int24)",
];
export const AERO_POOL_ABI = ["function slot0() view returns (uint160,int24,uint16,uint16,uint16,bool)"];
export const UNIV3_NPM_ABI = [
    "function ownerOf(uint256) view returns (address)",
    "function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)",
];
export const AERO_NPM_ABI = [
    "function ownerOf(uint256) view returns (address)",
    "function positions(uint256) view returns (uint96,address,address,address,int24,int24,int24,uint128,uint256,uint256,uint128,uint128)",
];
export const UNIV4_STATE_VIEW_ABI = [
    "function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)",
    "function getLiquidity(bytes32) view returns (uint128)",
];
export const UNIV4_PM_ABI = [
    "function ownerOf(uint256) view returns (address)",
    "function getPoolAndPositionInfo(uint256) view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,uint256 info)",
    "function getPositionLiquidity(uint256) view returns (uint128)",
];

// V4 PositionInfo packing (PositionInfoLibrary): bytes25 poolId | int24
// tickUpper (offset 32) | int24 tickLower (offset 8) | uint8 hasSubscriber.
export function unpackV4PositionTicks(info: bigint): { tickLower: number; tickUpper: number } {
    const signed24 = (v: bigint) => {
        const masked = v & 0xffffffn;
        return Number(masked >= 0x800000n ? masked - 0x1000000n : masked);
    };
    return { tickLower: signed24(info >> 8n), tickUpper: signed24(info >> 32n) };
}

export const Q96 = 1n << 96n;

export function deployedManagerAddress(): string {
    const deploymentId = process.env.IGNITION_DEPLOYMENT_ID || "chain-8453";
    const file = path.join(__dirname, `../ignition/deployments/${deploymentId}/deployed_addresses.json`);
    const deployed = JSON.parse(fs.readFileSync(file, "utf8"));
    return deployed["DeployYieldManager#SafeYieldManager"];
}

export function resolveOwnerKey(): string {
    return (
        process.env.TESTING_SAFE_OWNER_KEY ||
        process.env.SAFE_OWNER_PRIVATE_KEY ||
        process.env.DEPLOYER_PRIVATE_KEY ||
        ""
    );
}

// Tick and liquidity math lives in ./lpMath as exact bigint ports of the
// Uniswap libraries; re-exported here so existing script imports keep working
// and every script provably shares ONE implementation.
export {
    alignTick,
    decreaseMinimums,
    getAmountsForLiquidity,
    getLiquidityForAmounts,
    getSqrtRatioAtTick,
    mintMinimums,
    switchMintMinimums,
} from "./lpMath";

import { getAmountsForLiquidity, getSqrtRatioAtTick } from "./lpMath";

/// Token amounts held by `liquidity` over [tickLower, tickUpper] at the current
/// price. Thin tick-indexed wrapper over the sqrt-price form in ./lpMath.
export function amountsForLiquidity(
    sqrtPriceX96: bigint,
    tickLower: number,
    tickUpper: number,
    liquidity: bigint,
): { amount0: bigint; amount1: bigint } {
    return getAmountsForLiquidity(
        sqrtPriceX96,
        getSqrtRatioAtTick(tickLower),
        getSqrtRatioAtTick(tickUpper),
        liquidity,
    );
}

// HardhatEthersProvider does not implement waitForTransaction — poll instead.
export async function waitForReceipt(
    provider: {
        getTransactionReceipt(hash: string): Promise<{
            status: number | null;
            blockNumber: number;
            logs: ReadonlyArray<{ address: string; topics: ReadonlyArray<string>; data: string }>;
        } | null>;
    },
    hash: string,
) {
    let receipt = await provider.getTransactionReceipt(hash);
    for (let i = 0; i < 60 && !receipt; i++) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        receipt = await provider.getTransactionReceipt(hash);
    }
    if (!receipt) throw new Error(`Timed out waiting for transaction: ${hash}`);
    if (receipt.status !== 1) throw new Error(`Transaction failed: ${hash}`);
    return receipt;
}
