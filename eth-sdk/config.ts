import { defineConfig } from "@gnosis-guild/eth-sdk";

/**
 * eth-sdk configuration for Zodiac Roles SDK
 *
 * This defines the contracts we want to manage permissions for.
 * The SDK will generate type-safe APIs based on these contract addresses.
 */
export default defineConfig({
    contracts: {
        base: {
            usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",

            // Deployed contracts
            safeDebtManager: "0xDb2C9C10c909Cd6ab69C9427120eE7Ff034748c1",
        },
    },
});
