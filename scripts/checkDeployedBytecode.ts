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
 * For every entry of the manifest it compiles nothing and trusts nothing but
 * the artifacts of the current checkout and `eth_getCode`: the runtime
 * bytecode is compared byte for byte after masking the immutables (they are
 * constructor arguments, so they differ per deployment) and setting the CBOR
 * metadata tail apart (its hash pins the exact source text and compiler
 * settings, so a difference there means the source is not byte-identical
 * even when the code is).
 *
 *   EXACT       code and metadata both match: this checkout IS the deployed build
 *   RUNTIME     code matches, metadata differs: same code, source text or
 *               settings drifted (comments, formatting, a path) — explain or fail
 *   MISMATCH    the code differs; the detail names the first offset
 *   NO_CODE     nothing deployed at the address
 *   NO_ARTIFACT the manifest names a contract this checkout does not build
 *   NOT_IN_MANIFEST  CONTRACTS names a contract the manifest does not list
 *
 * Run it at the audited commit (tag), against the manifest the deploy wrote:
 *   AUDITED_COMMIT=<sha> npx hardhat run scripts/checkDeployedBytecode.ts --network base
 * Env: MANIFEST (default deployments/base.json; an Ignition deployed_addresses.json
 * also works), CONTRACTS (comma-separated contract names to check, default all),
 * AUDITED_COMMIT (refuse to run unless HEAD is this commit), ALLOW_METADATA_DRIFT=true
 * (treat RUNTIME as a pass). Exit code 1 unless every checked contract passes.
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

function readManifest(file: string): Record<string, string> {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed.contracts ?? parsed;
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
    const { head, dirty } = gitState();

    console.log(`Checkout: ${head}${dirty ? " (dirty working tree)" : ""} | manifest: ${manifestPath}`);
    if (env.AUDITED_COMMIT && !head.startsWith(env.AUDITED_COMMIT)) {
        throw new Error(`HEAD ${head} is not the audited commit ${env.AUDITED_COMMIT}; check out that commit first`);
    }
    if (dirty) console.log("Warning: uncommitted changes are part of what is being compared");

    const rows = await checkManifest(readManifest(manifestPath), hre.ethers.provider, hre.artifacts, only);
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
