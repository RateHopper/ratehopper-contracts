import { ethers, network } from "hardhat";
import dotenv from "dotenv";
dotenv.config();
import { YieldProtocol } from "../contractAddresses";
import { deployedManagerAddress } from "./lpSafeShared";

/**
 * Retunes a savings source's two admin ceilings on a SafeYieldManager:
 *
 *   configureHandler(protocol, abi.encode(uint16 maxToleranceBps, uint16 maxExposureBps))
 *
 * `configureHandler` is a DEFAULT_ADMIN_ROLE (routine, non-timelock) setter; the
 * manager delegatecalls the REGISTERED build's `configure`, which bounds both
 * values (tolerance 1..MAX_SETTABLE_TOLERANCE_BPS, exposure 1..10000) and stores
 * them in the savings namespace keyed by protocol id, so every build under the
 * id reads them, including the build an open position is pinned to. Zero in
 * storage means the constructor defaults apply.
 *
 * The signer is resolved from ADMIN_PRIVATE_KEY (falling back to
 * TESTING_SAFE_OPERATOR_KEY, then DEPLOYER_PRIVATE_KEY) and must hold
 * DEFAULT_ADMIN_ROLE. Configure the constants below, then:
 *   IGNITION_DEPLOYMENT_ID=<id> npx hardhat run scripts/configureSavingsHandler.ts --network base
 */

// ─── Configuration ───────────────────────────────────────────────────────
const PROTOCOL: number = YieldProtocol.SKY_SAVINGS;
const MAX_TOLERANCE_BPS: number = 50;
const MAX_EXPOSURE_BPS: number = 10_000;
const MANAGER_ADDRESS_OVERRIDE = "";
// true = print the resolved state and calldata without executing.
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

    const rpcUrl = (network.config as { url?: string }).url;
    if (!rpcUrl) throw new Error(`Network ${network.name} has no RPC url — run with --network base`);
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const admin = new ethers.Wallet(ADMIN_KEY, provider);

    const manager = new ethers.Contract(
        MANAGER_ADDRESS,
        [
            "function configureHandler(uint8,bytes) external",
            "function yieldHandlers(uint8) view returns (address)",
            "function hasRole(bytes32,address) view returns (bool)",
            "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
        ],
        admin,
    );
    const handlerAddress: string = await manager.yieldHandlers(PROTOCOL);
    if (handlerAddress === ethers.ZeroAddress) throw new Error(`No handler registered under protocol ${PROTOCOL}`);
    const handler = new ethers.Contract(
        handlerAddress,
        [
            "function DEFAULT_MAX_TOLERANCE_BPS() view returns (uint16)",
            "function DEFAULT_MAX_EXPOSURE_BPS() view returns (uint16)",
            "function MAX_SETTABLE_TOLERANCE_BPS() view returns (uint16)",
            "function savingsConfigSlot() view returns (bytes32)",
        ],
        provider,
    );

    const [defaultTolerance, defaultExposure, settableMax, slot] = await Promise.all([
        handler.DEFAULT_MAX_TOLERANCE_BPS(),
        handler.DEFAULT_MAX_EXPOSURE_BPS(),
        handler.MAX_SETTABLE_TOLERANCE_BPS(),
        handler.savingsConfigSlot(),
    ]);
    // config[PROTOCOL] packs maxToleranceBps in the low 16 bits and maxExposureBps in the next 16.
    const packed = BigInt(await provider.getStorage(MANAGER_ADDRESS, slot));
    const storedTolerance = Number(packed & 0xffffn);
    const storedExposure = Number((packed >> 16n) & 0xffffn);
    const effective = (stored: number, fallback: bigint) => (stored === 0 ? Number(fallback) : stored);

    const adminRole = await manager.DEFAULT_ADMIN_ROLE();
    const signerIsAdmin = await manager.hasRole(adminRole, admin.address);

    console.log("Configuration:");
    console.log("- SafeYieldManager:", MANAGER_ADDRESS);
    console.log("- Protocol:", PROTOCOL, "handler:", handlerAddress);
    console.log("- Build defaults: tolerance", Number(defaultTolerance), "exposure", Number(defaultExposure));
    console.log("- Stored (0 = unset): tolerance", storedTolerance, "exposure", storedExposure);
    console.log(
        "- Effective now: tolerance",
        effective(storedTolerance, defaultTolerance),
        "exposure",
        effective(storedExposure, defaultExposure),
    );
    console.log(
        "- Target: tolerance",
        MAX_TOLERANCE_BPS,
        "exposure",
        MAX_EXPOSURE_BPS,
        `(tolerance max ${Number(settableMax)})`,
    );
    console.log("- Signer:", admin.address, "| has DEFAULT_ADMIN_ROLE:", signerIsAdmin);

    if (!signerIsAdmin) throw new Error(`Signer ${admin.address} lacks DEFAULT_ADMIN_ROLE — the call would revert`);
    if (MAX_TOLERANCE_BPS === 0 || MAX_TOLERANCE_BPS > Number(settableMax)) {
        throw new Error(
            `MAX_TOLERANCE_BPS must be in 1..${Number(settableMax)} — the handler would revert InvalidConfig`,
        );
    }
    if (MAX_EXPOSURE_BPS === 0 || MAX_EXPOSURE_BPS > 10_000) {
        throw new Error("MAX_EXPOSURE_BPS must be in 1..10000 — the handler would revert InvalidConfig");
    }

    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint16", "uint16"],
        [MAX_TOLERANCE_BPS, MAX_EXPOSURE_BPS],
    );
    const data = manager.interface.encodeFunctionData("configureHandler", [PROTOCOL, encoded]);
    if (DRY_RUN) {
        console.log("\nDRY_RUN — configureHandler calldata:");
        console.log(data);
        return;
    }

    const tx = await manager.configureHandler(PROTOCOL, encoded);
    console.log("\nSubmitted:", tx.hash);
    const receipt = await tx.wait();
    console.log("Confirmed in block", receipt?.blockNumber);
    const after = BigInt(await provider.getStorage(MANAGER_ADDRESS, slot));
    console.log("Now stored: tolerance", Number(after & 0xffffn), "exposure", Number((after >> 16n) & 0xffffn));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
