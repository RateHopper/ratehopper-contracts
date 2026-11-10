const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const kind = process.argv[2];
if (kind !== "scripts" && kind !== "yield-fork") throw new Error("Expected scripts or yield-fork");
if (!process.env.BASE_RPC_URL)
    throw new Error("BASE_RPC_URL must point to a Base archive RPC for required security tests");
const directory = kind === "scripts" ? "test/scripts" : "test/yield";
const files = fs
    .readdirSync(path.join(root, directory))
    .filter(
        (name) =>
            !name.startsWith(".") &&
            (kind === "scripts" ? name.endsWith(".ts") : /^safeYieldManager.*Fork\.ts$/.test(name)),
    )
    .sort();
if (files.length === 0) throw new Error(`No security suites found in ${directory}`);
let failed = false;
for (const file of files) {
    const block = kind === "scripts" || file.includes("SkySavings") ? "53100000" : "49470000";
    console.log(`\nRunning ${directory}/${file} in an isolated Hardhat process at Base block ${block}`);
    const result = spawnSync(
        process.execPath,
        [
            "--max-old-space-size=12288",
            require.resolve("hardhat/internal/cli/cli"),
            "test",
            "--no-compile",
            `${directory}/${file}`,
        ],
        {
            cwd: root,
            stdio: "inherit",
            env: { ...process.env, BASE_FORK_BLOCK_NUMBER: block },
        },
    );
    if (result.status !== 0) {
        failed = true;
        console.error(`Failed: ${file} (${result.signal || result.status})`);
    }
}
process.exitCode = failed ? 1 : 0;
