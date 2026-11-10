import hre from "hardhat";
import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import type { Artifact, Artifacts } from "hardhat/types";

/**
 * Proves that the code live on chain is the code this checkout compiles to:
 * the launch control "bytecode matches the audited build".
 *
 * Release mode rebuilds a clean audited checkout and checks the reviewed
 * configuration. For every manifest entry, the runtime-template comparison
 * uses that build's artifacts and `eth_getCode`: the runtime
 * bytecode is compared byte for byte after masking the immutables (they are
 * constructor arguments, so they differ per deployment) and setting the CBOR
 * metadata tail apart (its hash pins the exact source text and compiler
 * settings, so a difference there means the source is not byte-identical
 * even when the code is).
 *
 *   EXACT       runtime template and metadata match; immutables require separate checks
 *   RUNTIME     code matches, metadata differs: same code, source text or
 *               settings drifted (comments, formatting, a path) — explain or fail
 *   MISMATCH    the code differs; the detail names the first offset
 *   NO_CODE     nothing deployed at the address
 *   NO_ARTIFACT the manifest names a contract this checkout does not build
 *   NOT_IN_MANIFEST  CONTRACTS names a contract the manifest does not list
 *
 * Run it at the audited commit (tag), against the manifest the deploy wrote:
 *   AUDITED_COMMIT=<full-sha> RELEASE_CONFIG=/path/to/reviewed-config.json yarn check:bytecode
 * Env: MANIFEST (default deployments/base.json; an Ignition deployed_addresses.json
 * also works), CONTRACTS (comma-separated contract names to check, default all),
 * AUDITED_COMMIT (full commit hash, required for release), RELEASE_CONFIG (reviewed
 * configuration JSON, required for release). CHECK_MODE=code-only is diagnostic;
 * it does not attest deployment configuration. ALLOW_METADATA_DRIFT=true only
 * applies in code-only mode. Exit code 1 unless every checked contract passes.
 */

export type Status = "EXACT" | "RUNTIME" | "MISMATCH" | "NO_CODE" | "NO_ARTIFACT" | "NOT_IN_MANIFEST";

export interface ImmutableRef {
    start: number;
    length: number;
}

export interface Comparison {
    status: Status;
    metadataMatches: boolean;
    expectedLength: number;
    onchainLength: number;
    detail: string;
}

export interface Row extends Comparison {
    key: string;
    name: string;
    address: string;
    immutableSlots: number;
}

type CodeReader = { getCode(address: string): Promise<string> };

/** Length of the CBOR metadata tail solc appends to runtime code: the payload length sits in the last two bytes. */
export function metadataTailLength(code: Uint8Array): number {
    if (code.length < 2) return 0;
    const payload = (code[code.length - 2] << 8) | code[code.length - 1];
    const tail = payload + 2;
    return tail <= code.length ? tail : 0;
}

export function compareRuntime(expectedHex: string, onchainHex: string, refs: ImmutableRef[]): Comparison {
    const expected = ethers.getBytes(expectedHex);
    const onchain = ethers.getBytes(onchainHex);
    const base = { expectedLength: expected.length, onchainLength: onchain.length };
    if (onchain.length === 0)
        return { ...base, status: "NO_CODE", metadataMatches: false, detail: "no code at address" };
    if (onchain.length !== expected.length) {
        return {
            ...base,
            status: "MISMATCH",
            metadataMatches: false,
            detail: `length ${onchain.length} on chain vs ${expected.length} in the artifact`,
        };
    }

    for (const ref of refs) {
        for (let i = ref.start; i < ref.start + ref.length && i < expected.length; i++) {
            expected[i] = 0;
            onchain[i] = 0;
        }
    }

    const tail = metadataTailLength(expected);
    const bodyEnd = expected.length - tail;
    for (let i = 0; i < bodyEnd; i++) {
        if (expected[i] !== onchain[i]) {
            return {
                ...base,
                status: "MISMATCH",
                metadataMatches: false,
                detail: `first difference at offset ${i} (0x${expected[i].toString(16)} expected, 0x${onchain[i].toString(16)} on chain)`,
            };
        }
    }
    let metadataMatches = true;
    for (let i = bodyEnd; i < expected.length; i++) {
        if (expected[i] !== onchain[i]) {
            metadataMatches = false;
            break;
        }
    }
    return {
        ...base,
        status: metadataMatches ? "EXACT" : "RUNTIME",
        metadataMatches,
        detail: metadataMatches ? "code and metadata match" : `code matches, metadata tail (${tail} bytes) differs`,
    };
}

/** Immutable byte ranges of a contract's runtime code, from the build-info the artifact came from. */
export async function immutableRefsFor(artifacts: Artifacts, artifact: Artifact): Promise<ImmutableRef[]> {
    const buildInfo = await artifacts.getBuildInfo(`${artifact.sourceName}:${artifact.contractName}`);
    if (!buildInfo) throw new Error(`Missing build info for ${artifact.contractName}; compile the audited checkout`);
    const output = buildInfo?.output.contracts?.[artifact.sourceName]?.[artifact.contractName] as
        | { evm?: { deployedBytecode?: { immutableReferences?: Record<string, ImmutableRef[]> } } }
        | undefined;
    const refs = output?.evm?.deployedBytecode?.immutableReferences ?? {};
    return Object.values(refs).flat();
}

/** Checks every `Module#Contract` (or bare `Contract`) entry of a manifest against the checkout's artifacts. */
export async function checkManifest(
    manifest: Record<string, string>,
    provider: CodeReader,
    artifacts: Artifacts,
    only?: Set<string>,
): Promise<Row[]> {
    validateManifest(manifest);
    if (only?.size === 0) throw new Error("Empty CONTRACTS selection");
    const rows: Row[] = [];
    for (const [key, address] of Object.entries(manifest)) {
        const name = key.split("#").pop()!;
        if (only && !only.has(name)) continue;
        let artifact: Artifact;
        try {
            artifact = await artifacts.readArtifact(name);
        } catch {
            rows.push({
                key,
                name,
                address,
                status: "NO_ARTIFACT",
                metadataMatches: false,
                expectedLength: 0,
                onchainLength: 0,
                immutableSlots: 0,
                detail: "no artifact with this name in the current build",
            });
            continue;
        }
        const refs = await immutableRefsFor(artifacts, artifact);
        const comparison = compareRuntime(artifact.deployedBytecode, await provider.getCode(address), refs);
        rows.push({ key, name, address, immutableSlots: refs.length, ...comparison });
    }
    for (const name of only ?? []) {
        if (rows.some((row) => row.name === name)) continue;
        rows.push({
            key: name,
            name,
            address: "",
            status: "NOT_IN_MANIFEST",
            metadataMatches: false,
            expectedLength: 0,
            onchainLength: 0,
            immutableSlots: 0,
            detail: "CONTRACTS names a contract the manifest does not list",
        });
    }
    return rows;
}

export function validateManifest(manifest: unknown): asserts manifest is Record<string, string> {
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || Object.keys(manifest).length === 0)
        throw new Error("Deployment manifest must contain at least one contract");
    const names = new Set<string>();
    for (const [key, address] of Object.entries(manifest)) {
        const name = key.split("#").pop()!;
        if (!name || names.has(name)) throw new Error(`Duplicate or empty contract name: ${name}`);
        names.add(name);
        if (typeof address !== "string" || !ethers.isAddress(address) || address === ethers.ZeroAddress)
            throw new Error(`Invalid deployment address for ${key}`);
    }
}

export function assertAuditedCheckout(head: string, dirty: boolean, auditedCommit?: string): void {
    if (!auditedCommit || !/^[a-fA-F0-9]{40}$/.test(auditedCommit) || head !== auditedCommit.toLowerCase())
        throw new Error("AUDITED_COMMIT must be the full 40-character hash of HEAD");
    if (dirty) throw new Error("Release verification requires a clean audited checkout");
}

export const RELEASE_GETTERS: Record<string, string[]> = {
    SafeYieldManager: [
        "REGISTRY",
        "USDC",
        "WETH",
        "timelock",
        "MAX_FEE_BPS",
        "treasury",
        "performanceFeeBps",
        "feeCollectBps",
        "maxSlippageBps",
        "pauser",
        "paused",
    ],
    SkySavingsYieldHandler: [
        "PROTOCOL",
        "USDC",
        "RATE_PROVIDER",
        "PSM3",
        "SUSDS",
        "REFERRAL_CODE",
        "DEFAULT_MAX_TOLERANCE_BPS",
        "DEFAULT_MAX_EXPOSURE_BPS",
    ],
    ChainlinkSsrRateProvider: ["FEED", "SSR_ORACLE", "SHARE_TOKEN", "MAX_FEED_AGE", "MAX_DISAGREEMENT_BPS", "MAX_RATE"],
};
export interface ReleaseConfig {
    chainId: number;
    contracts: Record<string, Record<string, string>>;
    savings: {
        maxToleranceBps: string;
        maxExposureBps: string;
        opensEnabled: boolean;
        closesEnabled: boolean;
        poolAllowed: boolean;
    };
    operator: string;
}

export async function checkReleaseConfiguration(
    manifest: Record<string, string>,
    config: ReleaseConfig,
    chainId: bigint,
    read: (address: string, name: string, getter: string, args?: unknown[]) => Promise<unknown>,
    readStorage: (address: string, slot: string) => Promise<string> = (address, slot) =>
        hre.ethers.provider.getStorage(address, slot),
): Promise<void> {
    validateManifest(manifest);
    if (config?.chainId !== 8453 || chainId !== 8453n)
        throw new Error("Release configuration and provider must use Base chain 8453");
    const addresses = Object.fromEntries(
        Object.entries(manifest).map(([key, value]) => [key.split("#").pop()!, value]),
    );
    for (const [name, getters] of Object.entries(RELEASE_GETTERS)) {
        if (!addresses[name]) throw new Error(`Required release contract missing: ${name}`);
        for (const getter of getters) {
            const expected = config.contracts?.[name]?.[getter];
            if (typeof expected !== "string" || !expected.trim())
                throw new Error(`Missing reviewed configuration: ${name}.${getter}`);
            const actual = String(await read(addresses[name], name, getter));
            if (actual.toLowerCase() !== expected.toLowerCase())
                throw new Error(`Configuration mismatch: ${name}.${getter}: expected ${expected}, got ${actual}`);
        }
    }
    const links: Array<[string, string, unknown[], string]> = [
        ["SafeYieldManager", "yieldHandlers", [3], addresses.SkySavingsYieldHandler],
        ["SkySavingsYieldHandler", "RATE_PROVIDER", [], addresses.ChainlinkSsrRateProvider],
        ["SkySavingsYieldHandler", "USDC", [], config.contracts.SafeYieldManager.USDC],
        ["ChainlinkSsrRateProvider", "SHARE_TOKEN", [], config.contracts.SkySavingsYieldHandler.SUSDS],
    ];
    if (config.contracts.SkySavingsYieldHandler.PROTOCOL !== "3")
        throw new Error("Savings handler must use protocol 3");
    for (const [name, getter, args, expected] of links) {
        if (String(await read(addresses[name], name, getter, args)).toLowerCase() !== expected.toLowerCase())
            throw new Error(`Deployment wiring mismatch: ${name}.${getter}`);
    }
    const savings = config.savings;
    if (
        !savings ||
        typeof savings.maxToleranceBps !== "string" ||
        typeof savings.maxExposureBps !== "string" ||
        typeof savings.opensEnabled !== "boolean" ||
        typeof savings.closesEnabled !== "boolean" ||
        typeof savings.poolAllowed !== "boolean"
    )
        throw new Error("Missing reviewed savings limits or switches");
    const slot = String(await read(addresses.SkySavingsYieldHandler, "SkySavingsYieldHandler", "savingsConfigSlot"));
    const packed = BigInt(await readStorage(addresses.SafeYieldManager, slot));
    const tolerance = packed & 0xffffn || BigInt(config.contracts.SkySavingsYieldHandler.DEFAULT_MAX_TOLERANCE_BPS);
    const exposure =
        (packed >> 16n) & 0xffffn || BigInt(config.contracts.SkySavingsYieldHandler.DEFAULT_MAX_EXPOSURE_BPS);
    if (tolerance.toString() !== savings.maxToleranceBps || exposure.toString() !== savings.maxExposureBps)
        throw new Error("Live savings limits differ from the reviewed configuration");
    const poolParam = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address"],
        [config.contracts.SkySavingsYieldHandler.PSM3, config.contracts.SkySavingsYieldHandler.SUSDS],
    );
    for (const [getter, args, expected] of [
        ["protocolEnabledForOpen", [3], savings.opensEnabled],
        ["protocolEnabledForClose", [3], savings.closesEnabled],
        ["isPoolParamAllowed", [3, poolParam], savings.poolAllowed],
    ] as const) {
        if ((await read(addresses.SafeYieldManager, "SafeYieldManager", getter, [...args])) !== expected)
            throw new Error(`Live savings switch mismatch: ${getter}`);
    }
    if (typeof config.operator !== "string" || !ethers.isAddress(config.operator))
        throw new Error("Missing reviewed operator");
    const operator = String(await read(config.contracts.SafeYieldManager.REGISTRY, "ProtocolRegistry", "safeOperator"));
    if (operator.toLowerCase() !== config.operator.toLowerCase()) throw new Error("Live registry operator mismatch");
}

function readManifest(file: string): { contracts: Record<string, string>; chainId?: number } {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const contracts = parsed.contracts ?? parsed;
    validateManifest(contracts);
    return { contracts, chainId: parsed.chainId };
}

function gitState(): { head: string; dirty: boolean } {
    try {
        const head = execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] })
            .toString()
            .trim();
        const dirty =
            execSync("git status --porcelain", { stdio: ["ignore", "pipe", "ignore"] })
                .toString()
                .trim() !== "";
        return { head, dirty };
    } catch {
        return { head: "unknown", dirty: true };
    }
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const manifestPath = path.resolve(env.MANIFEST || "deployments/base.json");
    const only = env.CONTRACTS ? new Set(env.CONTRACTS.split(",").map((s) => s.trim())) : undefined;
    const allowDrift = env.ALLOW_METADATA_DRIFT === "true";
    const mode = env.CHECK_MODE || "release";
    if (mode !== "release" && mode !== "code-only") throw new Error("CHECK_MODE must be release or code-only");
    const { head, dirty } = gitState();

    console.log(`Checkout: ${head}${dirty ? " (dirty working tree)" : ""} | manifest: ${manifestPath}`);
    const manifest = readManifest(manifestPath);
    if (mode === "release") {
        assertAuditedCheckout(head, dirty, env.AUDITED_COMMIT);
        if (only) throw new Error("Release verification cannot filter out contracts with CONTRACTS");
        if (allowDrift) throw new Error("Release verification cannot allow metadata drift");
        if (!env.RELEASE_CONFIG) throw new Error("Set RELEASE_CONFIG to the reviewed deployment configuration JSON");
        const chainId = (await hre.ethers.provider.getNetwork()).chainId;
        if (manifest.chainId !== undefined && BigInt(manifest.chainId) !== chainId)
            throw new Error("Manifest chainId does not match the provider");
        await hre.run("compile", { force: true });
        await checkReleaseConfiguration(
            manifest.contracts,
            JSON.parse(fs.readFileSync(env.RELEASE_CONFIG, "utf8")),
            chainId,
            async (address, name, getter, args = []) =>
                (await hre.ethers.getContractAt(name, address))[getter](...args),
        );
    } else {
        console.log(
            "Diagnostic code-template comparison only; deployment configuration and audited provenance are NOT verified.",
        );
    }

    const rows = await checkManifest(manifest.contracts, hre.ethers.provider, hre.artifacts, only);
    for (const row of rows) {
        const size = row.expectedLength ? ` (${row.expectedLength} bytes, ${row.immutableSlots} immutable slots)` : "";
        console.log(`${row.status.padEnd(11)} ${row.name.padEnd(26)} ${row.address}${size}`);
        if (row.status !== "EXACT") console.log(`            ${row.detail}`);
    }

    const passing = (row: Row) => row.status === "EXACT" || (allowDrift && row.status === "RUNTIME");
    const failed = rows.filter((row) => !passing(row));
    console.log(
        `\n${rows.length - failed.length}/${rows.length} match${failed.length ? `; failing: ${failed.map((r) => r.name).join(", ")}` : ""}`,
    );
    if (failed.length > 0) process.exitCode = 1;
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
