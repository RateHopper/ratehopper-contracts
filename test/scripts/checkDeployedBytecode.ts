import { expect } from "chai";
import { artifacts, ethers, network } from "hardhat";
import {
    checkManifest,
    compareRuntime,
    immutableRefsFor,
    validateManifest,
    assertAuditedCheckout,
    checkReleaseConfiguration,
    RELEASE_GETTERS,
    ReleaseConfig,
} from "../../scripts/checkDeployedBytecode";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import fs from "fs";
import os from "os";
import path from "path";
import { main } from "../../scripts/checkDeployedBytecode";
import { deployRegistered } from "../helpers/savingsHarness";

// ─────────────────────────────────────────────────────────────────────────
//  The launch control "bytecode matches the audited build" has to tell three
//  things apart: the code that is live, the immutables a deploy bakes into it,
//  and the metadata hash that only proves the source text is byte-identical.
// ─────────────────────────────────────────────────────────────────────────

describe("scripts/checkDeployedBytecode", function () {
    async function deployLoud(protocol: number) {
        const Loud = await ethers.getContractFactory("MockLoudYieldHandler");
        const loud = await Loud.deploy(protocol);
        await loud.waitForDeployment();
        return loud.getAddress();
    }

    async function expectedFor(name: string) {
        const artifact = await artifacts.readArtifact(name);
        return { expected: artifact.deployedBytecode, refs: await immutableRefsFor(artifacts, artifact) };
    }

    it("reports EXACT for a contract deployed from the current build", async function () {
        const address = await deployLoud(3);
        const { expected, refs } = await expectedFor("MockLoudYieldHandler");
        const result = compareRuntime(expected, await ethers.provider.getCode(address), refs);
        expect(result.status).to.equal("EXACT");
        expect(result.metadataMatches).to.equal(true);
        expect(refs.length).to.be.greaterThan(0);
    });

    it("masks immutables, so a different constructor argument still matches", async function () {
        const address = await deployLoud(7);
        const { expected, refs } = await expectedFor("MockLoudYieldHandler");
        const onchain = await ethers.provider.getCode(address);
        expect(compareRuntime(expected, onchain, refs).status).to.equal("EXACT");
        expect(compareRuntime(expected, onchain, []).status).to.equal("MISMATCH");
    });

    it("reports RUNTIME when only the metadata hash differs", async function () {
        const address = await deployLoud(3);
        const { expected, refs } = await expectedFor("MockLoudYieldHandler");
        const bytes = ethers.getBytes(expected);
        bytes[bytes.length - 10] ^= 0xff;
        await network.provider.send("hardhat_setCode", [address, ethers.hexlify(bytes)]);
        const result = compareRuntime(expected, await ethers.provider.getCode(address), refs);
        expect(result.status).to.equal("RUNTIME");
        expect(result.metadataMatches).to.equal(false);
    });

    it("reports MISMATCH with the first differing offset when the code body differs", async function () {
        const address = await deployLoud(3);
        const { expected, refs } = await expectedFor("MockLoudYieldHandler");
        const bytes = ethers.getBytes(expected);
        bytes[0] ^= 0x01;
        await network.provider.send("hardhat_setCode", [address, ethers.hexlify(bytes)]);
        const result = compareRuntime(expected, await ethers.provider.getCode(address), refs);
        expect(result.status).to.equal("MISMATCH");
        expect(result.detail).to.include("offset 0");
    });

    it("reports MISMATCH for another contract's code and NO_CODE for an empty address", async function () {
        const address = await deployLoud(3);
        const { expected, refs } = await expectedFor("MockBlindYieldHandler");
        expect(compareRuntime(expected, await ethers.provider.getCode(address), refs).status).to.equal("MISMATCH");
        expect(compareRuntime(expected, "0x", refs).status).to.equal("NO_CODE");
    });

    it("fails loudly when a CONTRACTS filter names nothing in the manifest", async function () {
        const address = await deployLoud(3);
        const rows = await checkManifest(
            { "Mock#MockLoudYieldHandler": address },
            ethers.provider,
            artifacts,
            new Set(["MockLoudYieldHandler", "SafeYeldManager"]),
        );
        expect(rows.map((r) => [r.name, r.status])).to.deep.equal([
            ["MockLoudYieldHandler", "EXACT"],
            ["SafeYeldManager", "NOT_IN_MANIFEST"],
        ]);
    });

    it("walks a deployments manifest keyed Module#Contract and flags unknown artifacts", async function () {
        const address = await deployLoud(3);
        const rows = await checkManifest(
            { "Mock#MockLoudYieldHandler": address, "Mock#NoSuchContract": address },
            ethers.provider,
            artifacts,
        );
        expect(rows.map((r) => [r.name, r.status])).to.deep.equal([
            ["MockLoudYieldHandler", "EXACT"],
            ["NoSuchContract", "NO_ARTIFACT"],
        ]);
    });

    it("rejects empty, malformed, zero-address and ambiguous manifests", async function () {
        for (const manifest of [
            {},
            null,
            [],
            { SafeYieldManager: ethers.ZeroAddress },
            { SafeYieldManager: "not an address" },
            {
                "A#SafeYieldManager": ethers.Wallet.createRandom().address,
                "B#SafeYieldManager": ethers.Wallet.createRandom().address,
            },
        ]) {
            expect(() => validateManifest(manifest)).to.throw();
        }
        await expect(checkManifest({}, ethers.provider, artifacts)).to.be.rejectedWith("at least one contract");
    });

    it("rejects an empty wrapped manifest through the real command entrypoint", async function () {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bytecode-manifest-"));
        try {
            const file = path.join(directory, "empty.json");
            fs.writeFileSync(file, JSON.stringify({ chainId: 8453, contracts: {} }));
            await expect(main({ MANIFEST: file, CHECK_MODE: "code-only" })).to.be.rejectedWith("at least one contract");
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it("refuses an artifact with no compiler build info instead of assuming no immutables", async function () {
        const artifact = await artifacts.readArtifact("MockLoudYieldHandler");
        const missing = { getBuildInfo: async () => undefined } as unknown as typeof artifacts;
        await expect(immutableRefsFor(missing, artifact)).to.be.rejectedWith("Missing build info");
    });

    it("requires the full audited commit and a clean checkout", function () {
        const head = "ab".repeat(20);
        expect(() => assertAuditedCheckout(head, false, head)).not.to.throw();
        for (const commit of [undefined, head.slice(0, 7), "cd".repeat(20)])
            expect(() => assertAuditedCheckout(head, false, commit)).to.throw("full 40-character");
        expect(() => assertAuditedCheckout(head, true, head)).to.throw("clean audited checkout");
    });

    async function releaseFixture() {
        const f = await loadFixture(deployRegistered);
        const manifest = {
            SafeYieldManager: f.managerAddr,
            SkySavingsYieldHandler: f.handlerAddr,
            ChainlinkSsrRateProvider: f.providerAddr,
        };
        const read = async (address: string, name: string, getter: string, args: unknown[] = []) =>
            (await ethers.getContractAt(name, address))[getter](...args);
        const config: ReleaseConfig = {
            chainId: 8453,
            contracts: {},
            savings: {
                maxToleranceBps: String(await f.handler.DEFAULT_MAX_TOLERANCE_BPS()),
                maxExposureBps: String(await f.handler.DEFAULT_MAX_EXPOSURE_BPS()),
                opensEnabled: true,
                closesEnabled: true,
                poolAllowed: true,
            },
            operator: f.operatorEOA.address,
        };
        for (const [name, getters] of Object.entries(RELEASE_GETTERS)) {
            config.contracts[name] = {};
            for (const getter of getters)
                config.contracts[name][getter] = String(
                    await read(manifest[name as keyof typeof manifest], name, getter),
                );
        }
        return { f, manifest, config, read };
    }

    it("checks required savings wiring and every declared immutable against reviewed values", async function () {
        const { manifest, config, read } = await releaseFixture();
        await checkReleaseConfiguration(manifest, config, 8453n, read);
        for (const [name, getters] of Object.entries(RELEASE_GETTERS)) {
            for (const getter of getters) {
                const changed = structuredClone(config);
                changed.contracts[name][getter] = "unexpected";
                await expect(checkReleaseConfiguration(manifest, changed, 8453n, read)).to.be.rejectedWith(
                    `Configuration mismatch: ${name}.${getter}`,
                );
            }
        }
    });

    it("rejects a missing required contract, a missing bound, and either wrong chain", async function () {
        const { manifest, config, read } = await releaseFixture();
        for (const name of Object.keys(RELEASE_GETTERS)) {
            const missing: Record<string, string> = { ...manifest };
            delete missing[name];
            await expect(checkReleaseConfiguration(missing, config, 8453n, read)).to.be.rejectedWith(
                "Required release contract missing",
            );
        }
        await expect(checkReleaseConfiguration(manifest, config, 1n, read)).to.be.rejectedWith("Base chain");
        await expect(checkReleaseConfiguration(manifest, { ...config, chainId: 1 }, 8453n, read)).to.be.rejectedWith(
            "Base chain",
        );
        delete config.contracts.ChainlinkSsrRateProvider.MAX_FEED_AGE;
        await expect(checkReleaseConfiguration(manifest, config, 8453n, read)).to.be.rejectedWith(
            "Missing reviewed configuration",
        );
    });

    it("rejects a different feed and age bound even when the runtime template matches", async function () {
        const { f, manifest, config, read } = await releaseFixture();
        const Feed = await ethers.getContractFactory("MockAggregatorV3");
        const feed = await Feed.deploy();
        const latest = (await ethers.provider.getBlock("latest"))!;
        await feed.set(await f.provider.rate(f.susdsAddr), latest.timestamp);
        const Provider = await ethers.getContractFactory("ChainlinkSsrRateProvider");
        const wrong = await Provider.deploy(
            await feed.getAddress(),
            await f.provider.SSR_ORACLE(),
            f.susdsAddr,
            4_294_967_295,
            await f.provider.MAX_DISAGREEMENT_BPS(),
            await f.provider.MAX_RATE(),
        );
        const address = await wrong.getAddress();
        const { expected, refs } = await expectedFor("ChainlinkSsrRateProvider");
        expect(compareRuntime(expected, await ethers.provider.getCode(address), refs).status).to.equal("EXACT");
        await expect(
            checkReleaseConfiguration({ ...manifest, ChainlinkSsrRateProvider: address }, config, 8453n, read),
        ).to.be.rejectedWith("ChainlinkSsrRateProvider.FEED");
    });

    it("rejects correct-looking contracts that are not connected to the registered manager", async function () {
        const { f, manifest, config, read } = await releaseFixture();
        const replacement = await f.Handler.deploy(
            f.usdcAddr,
            await f.provider.getAddress(),
            50,
            1000,
            f.psm3Addr,
            f.susdsAddr,
            0,
        );
        const replacementAddress = await replacement.getAddress();
        const changed = structuredClone(config);
        for (const getter of RELEASE_GETTERS.SkySavingsYieldHandler)
            changed.contracts.SkySavingsYieldHandler[getter] = String(
                await read(replacementAddress, "SkySavingsYieldHandler", getter),
            );
        await expect(
            checkReleaseConfiguration(
                { ...manifest, SkySavingsYieldHandler: replacementAddress },
                changed,
                8453n,
                read,
            ),
        ).to.be.rejectedWith("Deployment wiring mismatch");
    });

    it("rejects changed live savings limits even though constructor defaults still match", async function () {
        const { f, manifest, config, read } = await releaseFixture();
        await f.manager
            .connect(f.deployer)
            .configureHandler(3, ethers.AbiCoder.defaultAbiCoder().encode(["uint16", "uint16"], [100, 5000]));
        await expect(checkReleaseConfiguration(manifest, config, 8453n, read)).to.be.rejectedWith(
            "Live savings limits",
        );
        config.savings.maxToleranceBps = "100";
        config.savings.maxExposureBps = "5000";
        await checkReleaseConfiguration(manifest, config, 8453n, read);
    });

    it("rejects wrong switches, pool permission and registry operator", async function () {
        const { f, manifest, config, read } = await releaseFixture();
        for (const key of ["opensEnabled", "closesEnabled", "poolAllowed"] as const) {
            const wrong = structuredClone(config);
            wrong.savings[key] = false;
            await expect(checkReleaseConfiguration(manifest, wrong, 8453n, read)).to.be.rejectedWith(
                "Live savings switch mismatch",
            );
        }
        await f.reg.setOperator(f.stranger.address);
        await expect(checkReleaseConfiguration(manifest, config, 8453n, read)).to.be.rejectedWith(
            "Live registry operator mismatch",
        );
    });

    it("requires explicit reviewed mutable configuration", async function () {
        const { manifest, config, read } = await releaseFixture();
        const missing = { ...config, savings: undefined } as unknown as ReleaseConfig;
        await expect(checkReleaseConfiguration(manifest, missing, 8453n, read)).to.be.rejectedWith(
            "Missing reviewed savings",
        );
        await expect(checkReleaseConfiguration(manifest, { ...config, operator: "" }, 8453n, read)).to.be.rejectedWith(
            "Missing reviewed operator",
        );
    });
});
