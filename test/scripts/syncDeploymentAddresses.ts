import { expect } from "chai";
const { buildManifest } = require("../../scripts/syncDeploymentAddresses");

const existing = {
    chainId: 8453,
    network: "base",
    contracts: {
        "DeployCore#SafeDebtManager": "0x01442908D719FAac386Cd02527B51887389CBbF5",
        "DeployYieldManager#SafeYieldManager": "0x8a569BffA5141D6551383F8575Ce4C03dfdBD1Bc",
    },
};
const NEW_MANAGER = "0x1111111111111111111111111111111111111111";

describe("scripts/syncDeploymentAddresses", function () {
    it("replaces the manifest from the default journal", function () {
        const contracts = { "DeployYieldManager#SafeYieldManager": NEW_MANAGER };
        const manifest = buildManifest({ chainId: 8453, network: "base", contracts, existing, merge: false });
        expect(manifest).to.deep.equal({ chainId: 8453, network: "base", contracts });
    });

    it("keeps the debt stack when merging a non-default journal", function () {
        const manifest = buildManifest({
            chainId: 8453,
            network: "base",
            contracts: {
                "DeployYieldManager#SafeYieldManager": NEW_MANAGER,
                "DeployYieldManager#SkySavingsYieldHandler": "0x2222222222222222222222222222222222222222",
            },
            existing,
            merge: true,
        });
        expect(manifest.contracts).to.deep.equal({
            "DeployCore#SafeDebtManager": "0x01442908D719FAac386Cd02527B51887389CBbF5",
            "DeployYieldManager#SafeYieldManager": NEW_MANAGER,
            "DeployYieldManager#SkySavingsYieldHandler": "0x2222222222222222222222222222222222222222",
        });
    });

    it("refuses a merge that lists one contract name under two keys", function () {
        expect(() =>
            buildManifest({
                chainId: 8453,
                network: "base",
                contracts: { "DeployYieldManagerV2#SafeYieldManager": NEW_MANAGER },
                existing,
                merge: true,
            }),
        ).to.throw("SafeYieldManager would be listed as both");
    });

    it("refuses to merge without a manifest or across chains", function () {
        const contracts = { "DeployYieldManager#SafeYieldManager": NEW_MANAGER };
        expect(() => buildManifest({ chainId: 8453, network: "base", contracts, merge: true })).to.throw(
            "no existing manifest",
        );
        expect(() =>
            buildManifest({
                chainId: 84532,
                network: "base-sepolia",
                contracts,
                existing,
                merge: true,
            }),
        ).to.throw("not 84532");
    });
});
