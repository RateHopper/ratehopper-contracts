import { expect } from "chai";
import { artifacts, ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { MOCK_SRC, deployRegistered, open } from "../helpers/savingsHarness";
import {
    ACTIVITY_EVENTS,
    CATALOGUE,
    WATCHED_CONTRACTS,
    formatAlert,
    interfacesFor,
    pollOnce,
} from "../../scripts/watchAdminEvents";

// ─────────────────────────────────────────────────────────────────────────
//  Every event a watched contract can emit must be classified: either an
//  admin/role change that pages someone, or position activity that does not.
//  A new event added without a classification fails here, not in production.
// ─────────────────────────────────────────────────────────────────────────

describe("scripts/watchAdminEvents", function () {
    it("classifies every event of every watched contract", async function () {
        for (const name of WATCHED_CONTRACTS) {
            const abiEvents = (await artifacts.readArtifact(name)).abi
                .filter((f: { type: string }) => f.type === "event")
                .map((f: { name: string }) => f.name);
            const alerted = CATALOGUE.filter((e) => e.contract === name).map((e) => e.event);
            const ignored = ACTIVITY_EVENTS[name];
            const unclassified = abiEvents.filter((e: string) => !alerted.includes(e) && !ignored.includes(e));
            expect(unclassified, `${name} events without a classification`).to.deep.equal([]);
            expect(
                alerted.filter((e) => ignored.includes(e)),
                `${name} events classified twice`,
            ).to.deep.equal([]);
        }
    });

    it("turns admin and role changes into alerts and leaves position activity alone", async function () {
        const f = await loadFixture(deployRegistered);
        const { manager, managerAddr, deployer, pauser, stranger } = f;
        const from = (await ethers.provider.getBlockNumber()) + 1;

        await (await open(f, MOCK_SRC)).wait();
        await (await manager.connect(pauser).setProtocolEnabledForOpen(MOCK_SRC.protocol, false)).wait();
        await (await manager.connect(deployer).setPauser(stranger.address)).wait();
        await (await manager.connect(stranger).pause()).wait();
        await (await manager.connect(deployer).grantRole(await manager.DEFAULT_ADMIN_ROLE(), stranger.address)).wait();

        const alerts = await pollOnce(
            ethers.provider,
            { [managerAddr.toLowerCase()]: "SafeYieldManager" },
            await interfacesFor(artifacts),
            from,
            await ethers.provider.getBlockNumber(),
        );
        expect(alerts.map((a) => [a.event, a.severity])).to.deep.equal([
            ["ProtocolStatusChanged", "high"],
            ["PauserUpdated", "critical"],
            ["Paused", "critical"],
            ["RoleGranted", "critical"],
        ]);
        expect(alerts[0].args).to.deep.equal({
            protocol: String(MOCK_SRC.protocol),
            forOpen: "true",
            enabled: "false",
        });
        expect(alerts[1].args.newPauser).to.equal(stranger.address);
        expect(alerts.every((a) => a.contract === "SafeYieldManager" && a.txHash.startsWith("0x"))).to.equal(true);
    });

    it("renders an alert as one line naming severity, contract, event and arguments", async function () {
        const line = formatAlert({
            severity: "critical",
            contract: "SafeYieldManager",
            address: "0x8a569BffA5141D6551383F8575Ce4C03dfdBD1Bc",
            event: "PauserUpdated",
            meaning: "the pauser key changed",
            args: { previousPauser: "0x1", newPauser: "0x2" },
            blockNumber: 42,
            txHash: "0xabc",
        });
        expect(line).to.include("CRITICAL");
        expect(line).to.include("SafeYieldManager.PauserUpdated");
        expect(line).to.include("newPauser=0x2");
        expect(line).to.include("0xabc");
    });
});
