import { expect } from "chai";
const { WIPE_ORDER, plannedWipes } = require("../../scripts/wipeYieldStack");

const init = (futureId: string) => JSON.stringify({ type: "DEPLOYMENT_EXECUTION_STATE_INITIALIZE", futureId });
const wipe = (futureId: string) => JSON.stringify({ type: "WIPE_APPLY", futureId });
const journal = (...lines: string[]) => lines.join("\n") + "\n";

describe("scripts/wipeYieldStack", function () {
    it("orders the Sep 2026 stack manager first and leaves the timelock alone", function () {
        const text = journal(
            init("TimelockControllerModule#TimelockController"),
            init("DeployYieldManager#UniV3YieldHandler"),
            init("DeployYieldManager#AerodromeYieldHandler"),
            "",
            init("DeployYieldManager#UniV4YieldHandler"),
            init("DeployYieldManager#SafeYieldManager"),
            init("DeployCore#SafeDebtManager"),
        );
        expect(plannedWipes(text)).to.deep.equal([
            "DeployYieldManager#SafeYieldManager",
            "DeployYieldManager#UniV3YieldHandler",
            "DeployYieldManager#AerodromeYieldHandler",
            "DeployYieldManager#UniV4YieldHandler",
        ]);
    });

    it("wipes the savings handler before its rate provider", function () {
        const text = journal(...WIPE_ORDER.slice().reverse().map(init));
        expect(plannedWipes(text)).to.deep.equal(WIPE_ORDER);
    });

    it("skips futures already wiped and counts a re-initialised one again", function () {
        const text = journal(
            init("DeployYieldManager#SafeYieldManager"),
            init("DeployYieldManager#UniV3YieldHandler"),
            wipe("DeployYieldManager#SafeYieldManager"),
            wipe("DeployYieldManager#UniV3YieldHandler"),
            init("DeployYieldManager#UniV3YieldHandler"),
        );
        expect(plannedWipes(text)).to.deep.equal(["DeployYieldManager#UniV3YieldHandler"]);
    });

    it("returns nothing for a journal without yield futures", function () {
        expect(plannedWipes(journal(init("DeployCore#SafeDebtManager")))).to.deep.equal([]);
    });

    it("refuses a yield future it has no position for in the wipe order", function () {
        expect(() => plannedWipes(journal(init("DeployYieldManager#NewYieldHandler")))).to.throw(
            "DeployYieldManager#NewYieldHandler",
        );
    });
});
