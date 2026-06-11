import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "hardhat-contract-sizer";
import "hardhat-gas-reporter";
import dotenv from "dotenv";
dotenv.config();
require("hardhat-tracer");
require("@openzeppelin/hardhat-upgrades");

const baseUrl = process.env.BASE_RPC_URL || "https://mainnet.base.org";

// Only configure signing accounts when a deployer key is present. Hardhat rejects
// `[undefined]`, which breaks `compile`/`coverage` in CI where no key is set.
const deployerAccounts = process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [];

const config: HardhatUserConfig = {
    solidity: {
        compilers: [
            {
                version: "0.7.6",
            },
            {
                version: "0.8.28",
                settings: {
                    optimizer: {
                        enabled: true,
                        runs: 200,
                    },
                    viaIR: true,
                    evmVersion: "cancun",
                },
            },
        ],
    },
    etherscan: {
        apiKey: process.env.EXPLORER_KEY!,
    },
    sourcify: {
        enabled: true,
    },
    mocha: {
        timeout: 300000, // 5 minutes for memory-intensive tests
        parallel: false, // Disable parallel to reduce memory usage
        bail: false, // Continue running tests even if one fails
        slow: 30000, // Mark tests as slow if they take more than 30 seconds
    },
    gasReporter: {
        enabled: process.env.REPORT_GAS ? true : false,
    },
    networks: {
        base: {
            url: baseUrl,
            chainId: 8453,
            timeout: 10_000_000,
            accounts: deployerAccounts,
            gasPrice: "auto",
            gasMultiplier: 1.2,
        },
        baseSepolia: {
            url: "https://sepolia.base.org",
            chainId: 84532,
            accounts: deployerAccounts,
        },
        sepolia: {
            url: "https://eth-sepolia.public.blastapi.io",
            chainId: 11155111,
            accounts: deployerAccounts,
        },
        localhost: {
            url: "http://localhost:8545",
            timeout: 100_000_000,
        },
        hardhat: {
            chainId: 8453,
            chains: {
                8453: {
                    hardforkHistory: {
                        london: 1,
                    },
                },
            },
            forking: {
                url: baseUrl,
            },
        },
    },
};

export default config;
