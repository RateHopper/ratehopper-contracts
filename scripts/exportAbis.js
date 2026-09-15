const fs = require("fs");
const path = require("path");

// Contract name → source folder under contracts/ (artifact paths mirror it).
const contracts = {
    LeveragedPosition: "debt",
    SafeDebtManager: "debt",
    SafeExecTransactionWrapper: "debt",
    SafeYieldManager: "yield",
    RatehopperUniV3Positions: "legacy",
};

const rootDir = path.join(__dirname, "..");
const abisDir = path.join(rootDir, "abis");

fs.mkdirSync(abisDir, { recursive: true });

for (const [contractName, sourceDir] of Object.entries(contracts)) {
    const artifactPath = path.join(
        rootDir,
        "artifacts",
        "contracts",
        sourceDir,
        `${contractName}.sol`,
        `${contractName}.json`,
    );
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    const abiPath = path.join(abisDir, `${contractName}.json`);

    fs.writeFileSync(abiPath, `${JSON.stringify(artifact.abi, null, 4)}\n`);
    console.log(`Exported ${path.relative(rootDir, abiPath)}`);
}
