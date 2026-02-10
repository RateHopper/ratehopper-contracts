/**
 * Unified verification script for all deployed contracts.
 *
 * Reads deployed addresses and constructor args from Ignition deployment state,
 * checks each contract's verification status via the Etherscan V2 API, and
 * submits any unverified contracts via hardhat-verify.
 *
 * This bypasses a known hardhat-verify v2.x bug where GET requests to the
 * Etherscan V2 API lose the chainid query parameter, causing status checks
 * to fail even though the submission succeeds.
 *
 * Usage:
 *   npx hardhat run scripts/verifyAll.ts --network base
 *
 * Environment Variables Required:
 *   - EXPLORER_KEY: Etherscan / Basescan API key
 */
import hre from "hardhat";
import fs from "fs";
import path from "path";
import readline from "readline";

const ETHERSCAN_V2_API = "https://api.etherscan.io/v2/api";

const CHAIN_CONFIG: Record<number, { chainid: number; browserURL: string }> = {
    8453: { chainid: 8453, browserURL: "https://basescan.org" },
    84532: { chainid: 84532, browserURL: "https://sepolia.basescan.org" },
};

/**
 * Parse the Ignition journal to extract constructor args for each deployed contract.
 */
async function getConstructorArgsFromJournal(journalPath: string): Promise<Record<string, any[]>> {
    const result: Record<string, any[]> = {};
    const fileStream = fs.createReadStream(journalPath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
        if (!line.trim()) continue;
        try {
            const entry = JSON.parse(line);
            if (entry.type === "DEPLOYMENT_EXECUTION_STATE_INITIALIZE" && entry.constructorArgs) {
                result[entry.futureId] = entry.constructorArgs;
            }
        } catch {
            // skip malformed lines
        }
    }

    return result;
}

/**
 * Check if a contract is verified via the Etherscan V2 API.
 */
async function checkIfVerified(apiKey: string, chainid: number, address: string): Promise<boolean> {
    const url = `${ETHERSCAN_V2_API}?chainid=${chainid}&module=contract&action=getsourcecode&address=${address}&apikey=${apiKey}`;
    const response = await fetch(url);
    const json = (await response.json()) as any;

    if (json.status !== "1" || !json.result?.[0]) {
        return false;
    }

    const sourceCode = json.result[0].SourceCode;
    return sourceCode !== undefined && sourceCode !== null && sourceCode !== "";
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
    const chainId = (await hre.ethers.provider.getNetwork()).chainId;
    const chainConfig = CHAIN_CONFIG[Number(chainId)];
    if (!chainConfig) {
        throw new Error(`Unsupported chain ID: ${chainId}`);
    }

    const apiKey = process.env.EXPLORER_KEY;
    if (!apiKey) {
        throw new Error("EXPLORER_KEY environment variable is required");
    }

    // Read deployed addresses and constructor args from Ignition state
    const deploymentDir = path.join(__dirname, "..", "ignition", "deployments", `chain-${chainId}`);
    const addressesFile = path.join(deploymentDir, "deployed_addresses.json");
    const journalFile = path.join(deploymentDir, "journal.jsonl");

    if (!fs.existsSync(addressesFile)) {
        throw new Error(`No deployment found at ${addressesFile}. Deploy first with: yarn deploy`);
    }

    const addresses: Record<string, string> = JSON.parse(fs.readFileSync(addressesFile, "utf-8"));
    const constructorArgsMap = fs.existsSync(journalFile) ? await getConstructorArgsFromJournal(journalFile) : {};

    console.log(`\nVerifying ${Object.keys(addresses).length} contracts on chain ${chainId}\n`);
    console.log("=".repeat(60));

    let verified = 0;
    let alreadyVerified = 0;
    let failed = 0;

    for (const [futureId, address] of Object.entries(addresses)) {
        const contractName = futureId.split("#")[1];
        const constructorArguments = constructorArgsMap[futureId] ?? [];
        console.log(`\n${contractName} (${address})`);

        // 1. Check if already verified via Etherscan V2 API
        const isVerified = await checkIfVerified(apiKey, chainConfig.chainid, address);
        if (isVerified) {
            console.log(`  Already verified: ${chainConfig.browserURL}/address/${address}#code`);
            alreadyVerified++;
            continue;
        }

        // 2. Submit verification via hardhat verify
        console.log(`  Submitting (${constructorArguments.length} constructor args)...`);
        try {
            await hre.run("verify:verify", {
                address,
                constructorArguments,
                noCompile: true,
            });
            console.log(`  Verified!`);
            verified++;
        } catch (e: any) {
            if (e.message?.includes("Already Verified") || e.message?.includes("already verified")) {
                console.log(`  Already verified`);
                alreadyVerified++;
            } else {
                // Submission may have succeeded despite the V2 status check bug.
                // Poll the V2 API with retries to confirm.
                console.log(`  Plugin error, polling V2 API for status...`);
                let confirmed = false;
                for (let attempt = 1; attempt <= 5; attempt++) {
                    await sleep(10000);
                    const nowVerified = await checkIfVerified(apiKey, chainConfig.chainid, address);
                    if (nowVerified) {
                        console.log(
                            `  Verified (confirmed on attempt ${attempt}): ${chainConfig.browserURL}/address/${address}#code`,
                        );
                        verified++;
                        confirmed = true;
                        break;
                    }
                    console.log(`  Attempt ${attempt}/5: not yet verified, retrying...`);
                }
                if (!confirmed) {
                    console.log(`  Failed: ${e.message}`);
                    failed++;
                }
            }
        }
    }

    console.log("\n" + "=".repeat(60));
    console.log(`\nVerification complete: ${verified} newly verified, ${alreadyVerified} already verified, ${failed} failed`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
