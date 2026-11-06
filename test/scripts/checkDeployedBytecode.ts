import { expect } from "chai";
import { artifacts, ethers, network } from "hardhat";
import { checkManifest, compareRuntime, immutableRefsFor } from "../../scripts/checkDeployedBytecode";

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
});
