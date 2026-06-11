// Coverage gate: fails (exit 1) if branch coverage on any gated production
// contract is below THRESHOLD.
//
// Reads ./coverage.json produced by `yarn coverage*` (solidity-coverage /
// Istanbul format: per-file `b` maps a branchId to an array of per-outcome hit
// counts). Run AFTER a coverage run that exercises the gated contracts.
//
// Scope: only RatehopperUniV3Positions.sol is gated for now. The legacy
// debt-swap contracts and protocol handlers depend on Base-fork suites that
// are not yet fully covered; add their paths to GATED once their coverage is
// brought up.

const fs = require("fs");
const path = require("path");

const COVERAGE_FILE = path.join(__dirname, "..", "coverage.json");
const THRESHOLD = 95;

// Production contracts subject to the gate (suffix match on the coverage key).
const GATED = ["contracts/RatehopperUniV3Positions.sol"];

function isGated(key) {
    const k = key.replace(/\\/g, "/");
    return GATED.some((g) => k.endsWith(g));
}

function main() {
    if (!fs.existsSync(COVERAGE_FILE)) {
        console.error(`Coverage file not found at ${COVERAGE_FILE}. Run a coverage command first.`);
        process.exit(1);
    }

    const cov = JSON.parse(fs.readFileSync(COVERAGE_FILE, "utf8"));
    const rows = [];
    let totalBranches = 0;
    let coveredBranches = 0;

    for (const [key, data] of Object.entries(cov)) {
        if (!isGated(key)) continue;

        const branches = data.b || {};
        let fileTotal = 0;
        let fileCovered = 0;
        for (const hits of Object.values(branches)) {
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

    if (rows.length === 0) {
        console.error("No gated contracts found in coverage.json — was the coverage run scoped correctly?");
        process.exit(1);
    }

    rows.sort((a, b) => a.pct - b.pct);
    console.log(`Branch coverage for gated contracts (threshold ${THRESHOLD}%):\n`);
    for (const r of rows) {
        const flag = r.pct < THRESHOLD ? "FAIL" : " ok ";
        console.log(`  [${flag}] ${r.key}: ${r.fileCovered}/${r.fileTotal} branches (${r.pct.toFixed(2)}%)`);
    }

    const overall = totalBranches === 0 ? 100 : (coveredBranches / totalBranches) * 100;
    console.log(`\nOverall: ${coveredBranches}/${totalBranches} branches (${overall.toFixed(2)}%) — threshold ${THRESHOLD}%`);

    const failing = rows.filter((r) => r.pct < THRESHOLD);
    if (failing.length > 0) {
        console.error(`\nBranch coverage below ${THRESHOLD}% in ${failing.length} file(s).`);
        process.exit(1);
    }
    console.log(`\nAll gated contracts meet the ${THRESHOLD}% branch coverage gate.`);
}

main();
