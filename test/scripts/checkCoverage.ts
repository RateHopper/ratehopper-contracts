import { expect } from "chai";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
const { checkCoverage, GATED, BRANCHLESS } = require("../../scripts/checkCoverage");

describe("scripts/checkCoverage", function () {
    function report(): Record<string, any> {
        return Object.fromEntries(
            GATED.map((name: string) => [
                name,
                BRANCHLESS.has(name)
                    ? { b: {}, branchMap: {} }
                    : { b: { "0": [1, 1] }, branchMap: { "0": { locations: [{}, {}] } } },
            ]),
        );
    }

    it("accepts a complete report, including the three genuinely branchless contracts", function () {
        expect(checkCoverage(report()).failing).to.deep.equal([]);
        expect(checkCoverage(report()).rows).to.have.length(GATED.length);
    });

    for (const name of GATED) {
        it(`rejects a report missing ${name}`, function () {
            const data = report();
            delete data[name];
            expect(() => checkCoverage(data)).to.throw("Expected exactly one coverage entry");
        });
    }

    it("rejects an empty report and the one-file report that previously passed", function () {
        expect(() => checkCoverage({})).to.throw();
        expect(() =>
            checkCoverage({ "contracts/yield/handlers/SavingsStorage.sol": { b: {}, branchMap: {} } }),
        ).to.throw();
    });

    for (const malformed of [
        null,
        [],
        {},
        { b: {} },
        { b: {}, branchMap: {} },
        { b: { "0": [1] }, branchMap: { "0": { locations: [{}, {}] } } },
        { b: {}, branchMap: { "0": { locations: [{}, {}] } } },
        ...[-1, NaN, Infinity, "1", 0.5].map((hit) => ({
            b: { "0": [hit, 1] },
            branchMap: { "0": { locations: [{}, {}] } },
        })),
    ]) {
        it(`rejects malformed or truncated outcomes ${JSON.stringify(malformed)}`, function () {
            const data = report();
            data[GATED[0]] = malformed;
            expect(() => checkCoverage(data)).to.throw();
        });
    }

    it("does not allow duplicate suffixes or a misleading filename prefix", function () {
        const data = report();
        data[`other/${GATED[0]}`] = data[GATED[0]];
        expect(() => checkCoverage(data)).to.throw("found 2");
        delete data[`other/${GATED[0]}`];
        data[`fake${GATED[0]}`] = data[GATED[0]];
        delete data[GATED[0]];
        expect(() => checkCoverage(data)).to.throw("found 0");
    });

    it("fails each file below the threshold even if other files have full coverage", function () {
        const data = report();
        data[GATED[0]].b["0"] = [0, 1];
        expect(checkCoverage(data).failing.map((r: any) => r.key)).to.deep.equal([GATED[0]]);
    });

    it("sets a failing CLI exit code for malformed, incomplete and below-threshold reports", function () {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "coverage-gate-"));
        try {
            fs.mkdirSync(path.join(directory, "scripts"));
            const script = path.join(directory, "scripts/checkCoverage.js");
            fs.copyFileSync(path.resolve(__dirname, "../../scripts/checkCoverage.js"), script);
            const below = report();
            below[GATED[0]].b["0"] = [0, 1];
            for (const [content, status] of [
                ["{", 1],
                ["{}", 1],
                [JSON.stringify(below), 1],
                [JSON.stringify(report()), 0],
            ] as const) {
                fs.writeFileSync(path.join(directory, "coverage.json"), content);
                const result = spawnSync(process.execPath, [script], { cwd: directory, encoding: "utf8" });
                expect(result.status, result.stderr).to.equal(status);
            }
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});
