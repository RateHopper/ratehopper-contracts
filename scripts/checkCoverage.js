// Coverage gate: fails (exit 1) if branch coverage on any gated production
// contract is below THRESHOLD.
//
// Reads ./coverage.json produced by `yarn coverage*` (solidity-coverage /
// Istanbul format: per-file `b` maps a branchId to an array of per-outcome hit
// counts). Run AFTER a coverage run that exercises the gated contracts.
//
// Scope: RatehopperUniV3Positions.sol (legacy) and the SafeYieldManager
// stack. The debt-swap contracts and protocol handlers depend on Base-fork
// suites that are not yet fully covered; add their paths to GATED once their
// coverage is brought up.

const fs = require("fs");
const path = require("path");

const COVERAGE_FILE = path.join(__dirname, "..", "coverage.json");
const THRESHOLD = 95;

// Production contracts subject to the gate (suffix match on the coverage key).
const GATED = [
    "contracts/legacy/RatehopperUniV3Positions.sol",
    "contracts/yield/SafeYieldManager.sol",
    "contracts/yield/handlers/BaseYieldHandler.sol",
    "contracts/yield/handlers/V3StyleYieldHandler.sol",
    "contracts/yield/handlers/UniV3YieldHandler.sol",
    "contracts/yield/handlers/AerodromeYieldHandler.sol",
    "contracts/yield/handlers/UniV4YieldHandler.sol",
    "contracts/yield/handlers/YieldStorage.sol",
    "contracts/yield/libraries/TwapOracle.sol",
    "contracts/yield/handlers/SavingsStorage.sol",
    "contracts/yield/handlers/BaseSavingsHandler.sol",
    "contracts/yield/handlers/SkySavingsYieldHandler.sol",
    "contracts/yield/savings/ChainlinkSsrRateProvider.sol",
];

const BRANCHLESS = new Set([
    "contracts/yield/handlers/UniV3YieldHandler.sol",
    "contracts/yield/handlers/YieldStorage.sol",
    "contracts/yield/handlers/SavingsStorage.sol",
]);

function object(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkCoverage(cov) {
    if (!object(cov)) throw new Error("Invalid coverage report: expected a file map");
    const rows = [];
    let totalBranches = 0;
    let coveredBranches = 0;

    for (const contract of GATED) {
        const matches = Object.entries(cov).filter(([key]) => {
            const normalized = key.replace(/\\/g, "/");
            return normalized === contract || normalized.endsWith(`/${contract}`);
        });
        if (matches.length !== 1)
            throw new Error(`Expected exactly one coverage entry for ${contract}; found ${matches.length}`);
        const [key, data] = matches[0];
        if (!object(data) || !object(data.b) || !object(data.branchMap))
            throw new Error(`Malformed branch coverage: ${contract}`);
        const branches = data.b;
        const ids = Object.keys(branches).sort();
        if (JSON.stringify(ids) !== JSON.stringify(Object.keys(data.branchMap).sort()))
            throw new Error(`Incomplete branch counts: ${contract}`);
        if (ids.length === 0 && !BRANCHLESS.has(contract)) throw new Error(`Unexpected empty branch map: ${contract}`);
        let fileTotal = 0;
        let fileCovered = 0;
        for (const [id, hits] of Object.entries(branches)) {
            const locations = data.branchMap[id]?.locations;
            if (
                !Array.isArray(hits) ||
                !Array.isArray(locations) ||
                hits.length === 0 ||
                hits.length !== locations.length ||
                hits.some((h) => !Number.isSafeInteger(h) || h < 0)
            )
                throw new Error(`Malformed branch outcomes: ${contract}:${id}`);
            for (const h of hits) {
                fileTotal += 1;
                if (h > 0) fileCovered += 1;
            }
        }

        totalBranches += fileTotal;
        coveredBranches += fileCovered;
        const pct = fileTotal === 0 ? 100 : (fileCovered / fileTotal) * 100;
        rows.push({ key, fileCovered, fileTotal, pct });
    }

    rows.sort((a, b) => a.pct - b.pct);
    return { rows, totalBranches, coveredBranches, failing: rows.filter((r) => r.pct < THRESHOLD) };
}

function main() {
    if (!fs.existsSync(COVERAGE_FILE))
        throw new Error(`Coverage file not found at ${COVERAGE_FILE}. Run coverage first.`);
    const { rows, totalBranches, coveredBranches, failing } = checkCoverage(
        JSON.parse(fs.readFileSync(COVERAGE_FILE, "utf8")),
    );
    console.log(`Branch coverage for gated contracts (threshold ${THRESHOLD}%):\n`);
    for (const r of rows) {
        const flag = r.pct < THRESHOLD ? "FAIL" : " ok ";
        console.log(`  [${flag}] ${r.key}: ${r.fileCovered}/${r.fileTotal} branches (${r.pct.toFixed(2)}%)`);
    }

    const overall = totalBranches === 0 ? 100 : (coveredBranches / totalBranches) * 100;
    console.log(
        `\nOverall: ${coveredBranches}/${totalBranches} branches (${overall.toFixed(2)}%) — threshold ${THRESHOLD}%`,
    );

    if (failing.length > 0) {
        console.error(`\nBranch coverage below ${THRESHOLD}% in ${failing.length} file(s).`);
        process.exitCode = 1;
        return;
    }
    console.log(`\nAll gated contracts meet the ${THRESHOLD}% branch coverage gate.`);
}

module.exports = { checkCoverage, GATED, BRANCHLESS };
if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
