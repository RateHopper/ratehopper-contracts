import { ethers, network } from "hardhat";
import dotenv from "dotenv";
dotenv.config();
import {
    USDC_ADDRESS,
    WETH_ADDRESS,
    AERO_ADDRESS,
    YieldProtocol,
    encodeAerodromePoolParam,
    encodeUniV3PoolParam,
    encodeUniV4PoolParam,
} from "../contractAddresses";
import { deployedManagerAddress } from "./lpSafeShared";

/**
 * Toggles a pool-param entry in the SafeYieldManager allow-list (Base mainnet).
 *
 * `setPoolParamAllowed(uint8 protocol, bytes poolParam, bool allowed)` is a
 * DEFAULT_ADMIN_ROLE (routine, non-timelock) setter, so it must be signed by
 * the manager's admin. The signer is resolved from ADMIN_PRIVATE_KEY (falling
 * back to TESTING_SAFE_OPERATOR_KEY, then DEPLOYER_PRIVATE_KEY); it must hold
 * DEFAULT_ADMIN_ROLE or the call reverts.
 *
 * The pool param carries the pair and must be byte-identical to what callers
 * later pass as lpPoolParam / SwapLeg.poolParam:
 *   - univ3:      abi.encode(token0, token1, uint24 feeTier)
 *   - aerodrome:  abi.encode(token0, token1, int24 tickSpacing)
 *   - univ4:      abi.encode(currency0, currency1, uint24 fee, int24 tickSpacing, address hooks)
 * token0/currency0 must be the lower-sorted address (native ETH = address(0)
 * always sorts first).
 *
 * Enabling fails closed unless every non-USDC side already has a live TWAP
 * reference. Native ETH uses the address(0) reference key; configure it to a
 * WETH/USDC reference pool through the critical timelock first.
 *
 * Configure the constants below (or override via the noted env vars), then:
 *   IGNITION_DEPLOYMENT_ID=yield-v2 npx hardhat run scripts/setPoolParamAllowed.ts --network base
 */

// ─── Configuration ───────────────────────────────────────────────────────
const PROTOCOL_NAME: "aerodrome" | "univ3" | "univ4" = "aerodrome";
const ALLOWED = true;

// Pair to allow-list. Defaults below build an AERO/USDC pool (the reward-swap
// venue for staked Aerodrome collect); edit TOKEN0/TOKEN1 for another pair.
// Addresses are auto-sorted so token0 < token1 as the pool expects.
const TOKEN_A = AERO_ADDRESS;
const TOKEN_B = USDC_ADDRESS;

// Aerodrome tick spacing / UniV3 fee tier / UniV4 fee+spacing+hooks.
const TICK_SPACING = 100;
const FEE_TIER = 500;
const V4_FEE_TIER = 500;
const V4_TICK_SPACING = 10;
const V4_HOOKS = "0x0000000000000000000000000000000000000000";

const MANAGER_ADDRESS_OVERRIDE = "";
// true = print the resolved params and calldata without executing.
const DRY_RUN = true;
// ─────────────────────────────────────────────────────────────────────────

function resolveAdminKey(): string {
    return (
        process.env.ADMIN_PRIVATE_KEY || process.env.TESTING_SAFE_OPERATOR_KEY || process.env.DEPLOYER_PRIVATE_KEY || ""
    );
}

async function main() {
    const MANAGER_ADDRESS = MANAGER_ADDRESS_OVERRIDE || deployedManagerAddress();
    const ADMIN_KEY = resolveAdminKey();
    if (!ADMIN_KEY) throw new Error("Set ADMIN_PRIVATE_KEY (or TESTING_SAFE_OPERATOR_KEY / DEPLOYER_PRIVATE_KEY)");

    // Sort so token0 < token1 (native ETH address(0) already sorts first).
    const [t0, t1] = TOKEN_A.toLowerCase() < TOKEN_B.toLowerCase() ? [TOKEN_A, TOKEN_B] : [TOKEN_B, TOKEN_A];

    let protocol: number;
    let poolParam: string;
    if (PROTOCOL_NAME === "aerodrome") {
        protocol = YieldProtocol.AERODROME;
        poolParam = encodeAerodromePoolParam(t0, t1, TICK_SPACING);
    } else if (PROTOCOL_NAME === "univ4") {
        protocol = YieldProtocol.UNISWAP_V4;
        poolParam = encodeUniV4PoolParam(t0, t1, V4_FEE_TIER, V4_TICK_SPACING, V4_HOOKS);
    } else {
        protocol = YieldProtocol.UNISWAP_V3;
        poolParam = encodeUniV3PoolParam(t0, t1, FEE_TIER);
    }
    const rpcUrl = (network.config as { url?: string }).url;
    if (!rpcUrl) throw new Error(`Network ${network.name} has no RPC url — run with --network base`);
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const admin = new ethers.Wallet(ADMIN_KEY, provider);

    const manager = new ethers.Contract(
        MANAGER_ADDRESS,
        [
            "function setPoolParamAllowed(uint8,bytes,bool) external",
            "function isPoolParamAllowed(uint8,bytes) view returns (bool)",
            "function twapConfigOf(address) view returns ((address pool,uint32 window,uint16 minCardinality))",
            "function hasRole(bytes32,address) view returns (bool)",
            "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
        ],
        admin,
    );

    const adminRole = await manager.DEFAULT_ADMIN_ROLE();
    const signerIsAdmin = await manager.hasRole(adminRole, admin.address);
    const already = await manager.isPoolParamAllowed(protocol, poolParam);

    console.log("Configuration:");
    console.log("- SafeYieldManager:", MANAGER_ADDRESS);
    console.log("- Protocol:", PROTOCOL_NAME, `(id ${protocol})`);
    console.log("- token0:", t0);
    console.log("- token1:", t1);
    console.log("- poolParam:", poolParam);
    console.log("- key (keccak256):", ethers.keccak256(poolParam));
    console.log("- target allowed:", ALLOWED, "| currently allowed:", already);
    console.log("- Signer:", admin.address, "| has DEFAULT_ADMIN_ROLE:", signerIsAdmin);

    if (!signerIsAdmin) throw new Error(`Signer ${admin.address} lacks DEFAULT_ADMIN_ROLE — the call would revert`);
    if (ALLOWED) {
        for (const token of [t0, t1]) {
            if (token.toLowerCase() === USDC_ADDRESS.toLowerCase()) continue;
            const config = await manager.twapConfigOf(token);
            if (config.pool === ethers.ZeroAddress) {
                throw new Error(
                    `Missing TWAP reference for ${token} — schedule setTwapConfig through the critical timelock first`,
                );
            }
            console.log(`- TWAP reference for ${token}:`, config.pool, `(window ${config.window})`);
        }
    }
    if (already === ALLOWED) {
        console.log(`\nNo-op: allow-list is already ${ALLOWED}.`);
        return;
    }

    const data = manager.interface.encodeFunctionData("setPoolParamAllowed", [protocol, poolParam, ALLOWED]);
    if (DRY_RUN) {
        console.log("\nDRY_RUN — setPoolParamAllowed calldata:");
        console.log(data);
        return;
    }

    const tx = await manager.setPoolParamAllowed(protocol, poolParam, ALLOWED);
    console.log("\nSubmitted:", tx.hash);
    const receipt = await tx.wait();
    console.log("Confirmed in block", receipt?.blockNumber);
    console.log("Now allowed:", await manager.isPoolParamAllowed(protocol, poolParam));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
