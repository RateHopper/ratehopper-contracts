import { defineConfig, configVariable } from "hardhat/config";
import HardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
// import HardhatUpgrades from "@openzeppelin/hardhat-upgrades"; // TODO: Re-enable when compatible with Hardhat 3
import dotenv from "dotenv";
dotenv.config();

// Use BASE_RPC_URL env var if available, otherwise fall back to public endpoint
const baseUrl = process.env.BASE_RPC_URL || "https://base.llamarpc.com";
console.log("Using RPC URL:", baseUrl);
console.log("Fork block:", process.env.FORK_BLOCK_NUMBER || "latest");

export default defineConfig({
    plugins: [HardhatToolboxMochaEthers],
    solidity: {
        profiles: {
            default: {
                version: "0.8.28",
                settings: {
                    optimizer: {
                        enabled: true,
                        runs: 200,
                    },
                    viaIR: true,
                },
            },
            legacy: {
                version: "0.7.6",
            },
        },
    },
    networks: {
        hardhat: {
            type: "edr-simulated",
            chainId: 8453,
            // Note: Using "l1" instead of "op" as workaround for EDR OP stack block builder bug
            // See: https://github.com/NomicFoundation/edr/issues
            chainType: "l1",
            forking: {
                url: baseUrl,
                enabled: true,
                // Pin to a specific block for reproducible tests
                // Update this periodically as needed
                blockNumber: process.env.FORK_BLOCK_NUMBER ? parseInt(process.env.FORK_BLOCK_NUMBER) : undefined,
            },
        },
        base: {
            type: "http",
            chainType: "op",
            chainId: 8453,
            url: baseUrl,
            accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
        },
        baseSepolia: {
            type: "http",
            chainType: "op",
            chainId: 84532,
            url: "https://sepolia.base.org",
            accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
        },
        sepolia: {
            type: "http",
            chainType: "l1",
            chainId: 11155111,
            url: "https://eth-sepolia.public.blastapi.io",
            accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
        },
        localhost: {
            type: "http",
            chainType: "l1",
            url: "http://localhost:8545",
        },
    },
    test: {
        mocha: {
            timeout: 300000,
            parallel: false,
            bail: false,
            slow: 30000,
        },
    },
    // TODO: etherscan config needs to be updated for Hardhat 3
    // The verification plugin may need different configuration
    // etherscan: {
    //     apiKey: configVariable("EXPLORER_KEY"),
    //     customChains: [
    //         {
    //             network: "base",
    //             chainId: 8453,
    //             urls: {
    //                 apiURL: "https://api.basescan.org/api",
    //                 browserURL: "https://basescan.org",
    //             },
    //         },
    //         {
    //             network: "baseSepolia",
    //             chainId: 84532,
    //             urls: {
    //                 apiURL: "https://api-sepolia.basescan.org/api",
    //                 browserURL: "https://sepolia.basescan.org",
    //             },
    //         },
    //     ],
    // },
});
