const fs = require("fs");
const path = require("path");

const contracts = [
    "LeveragedPosition",
    "RatehopperUniV3Positions",
    "SafeDebtManager",
    "SafeExecTransactionWrapper",
];

const rootDir = path.join(__dirname, "..");
const abisDir = path.join(rootDir, "abis");

fs.mkdirSync(abisDir, { recursive: true });

for (const contractName of contracts) {
    const artifactPath = path.join(
        rootDir,
        "artifacts",
        "contracts",
        `${contractName}.sol`,
        `${contractName}.json`,
    );
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    const abiPath = path.join(abisDir, `${contractName}.json`);

    fs.writeFileSync(abiPath, `${JSON.stringify(artifact.abi, null, 4)}\n`);
    console.log(`Exported ${path.relative(rootDir, abiPath)}`);
}
