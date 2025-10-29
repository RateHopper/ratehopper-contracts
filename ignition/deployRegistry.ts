import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { ethers } from "hardhat";
import { FLUID_VAULT_RESOLVER } from "./constants";
import { getCTokenMappingArrays, getMTokenMappingArrays } from "../contractAddresses";
import { WETH_ADDRESS } from "../test/constants";

// Gas options utility function
export async function getGasOptions() {
    const feeData = await ethers.provider.getFeeData();
    
    // Get current network to adjust gas strategy
    const network = await ethers.provider.getNetwork();
    const chainId = network.chainId;
    
    if (chainId === 8453n) { // Base network
        // For Base network, use higher gas prices to avoid underpricing
        const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas 
            ? (feeData.maxPriorityFeePerGas * 15n) / 10n // 50% higher
            : ethers.parseUnits("2", "gwei");
        
        const maxFeePerGas = feeData.maxFeePerGas 
            ? (feeData.maxFeePerGas * 15n) / 10n // 50% higher
            : ethers.parseUnits("10", "gwei");
        
        return {
            maxFeePerGas,
            maxPriorityFeePerGas,
        };
    } else {
        // For other networks, use conservative approach
        const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? ethers.parseUnits("2", "gwei");
        const baseFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice ?? ethers.parseUnits("20", "gwei");
        // Add a larger buffer to avoid underpricing
        const maxFeePerGas = (baseFeePerGas * 15n) / 10n + maxPriorityFeePerGas;
        
        return {
            maxFeePerGas,
            maxPriorityFeePerGas,
        };
    }
}

// ProtocolRegistry module
export const ProtocolRegistryModule = buildModule("ProtocolRegistry", (m) => {
    const wethAddress = m.getParameter("wethAddress", WETH_ADDRESS);
    const registry = m.contract("ProtocolRegistry", [wethAddress]);
    return { registry };
});

// Setup function for registry configuration
export async function setupRegistry(registry: any) {
    const gasOptions = await getGasOptions();
    
    try {
        // Set up Moonwell token mappings
        console.log("Setting up Moonwell token mappings...");
        const [mTokens, mContracts] = getMTokenMappingArrays();
        const mTokenTx = await registry.batchSetTokenMContracts(mTokens, mContracts, {
            ...gasOptions,
            gasLimit: 2000000,
        });
        await mTokenTx.wait();
        console.log("Moonwell token mappings set in ProtocolRegistry");
    } catch (error) {
        console.log("Moonwell token mappings may already be set, continuing...");
    }

    try {
        // Set up Compound token mappings
        console.log("Setting up Compound token mappings...");
        const [cTokens, cContracts] = getCTokenMappingArrays();
        const cTokenTx = await registry.batchSetTokenCContracts(cTokens, cContracts, {
            ...gasOptions,
            gasLimit: 2000000,
        });
        await cTokenTx.wait();
        console.log("Compound token mappings set in ProtocolRegistry");
    } catch (error) {
        console.log("Compound token mappings may already be set, continuing...");
    }

    try {
        // Set Fluid vault resolver
        console.log("Setting Fluid vault resolver...");
        const resolverTx = await registry.setFluidVaultResolver(FLUID_VAULT_RESOLVER, {
            ...gasOptions,
            gasLimit: 200000,
        });
        await resolverTx.wait();
        console.log("Fluid vault resolver set in ProtocolRegistry");
    } catch (error) {
        console.log("Fluid vault resolver may already be set, continuing...");
    }

    // Add tokens to whitelist
    await addTokensToWhitelist(registry, gasOptions);
}

async function addTokensToWhitelist(registry: any, gasOptions: any) {
    console.log("Adding tokens to whitelist...");
    
    // Token addresses
    const WETH_ADDRESS = "0x4200000000000000000000000000000000000006";
    const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Circle
    const USDbC_ADDRESS = "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA"; // Coinbase
    const cbETH_ADDRESS = "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22";
    const cbBTC_ADDRESS = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf";
    const eUSD_ADDRESS = "0xCfA3Ef56d303AE4fAabA0592388F19d7C3399FB4";
    const MAI_ADDRESS = "0xbf1aeA8670D2528E08334083616dD9C5F3B087aE";
    const DAI_ADDRESS = "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb";
    const sUSDS_ADDRESS = "0x5875eee11cf8398102fdad704c9e96607675467a";
    const AERO_ADDRESS = "0x940181a94a35a4569e4529a3cdfb74e38fd98631";
    const wstETH_ADDRESS = "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452";
    const rETH_ADDRESS = "0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c";
    const weETH_ADDRESS = "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A";
    const EURC_ADDRESS = "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42";
    const wrsETH_ADDRESS = "0xedfa23602d0ec14714057867a78d01e94176bea0";
    const WELL_ADDRESS = "0xA88594D404727625A9437C3f886C7643872296AE";
    const USDS_ADDRESS = "0x820c137fa70c8691f0e44dc420a5e53c168921dc";
    const tBTC_ADDRESS = "0x236aa50979d5f3de3bd1eeb40e81137f22ab794b";
    const LBTC_ADDRESS = "0xecAc9C5F704e954931349Da37F60E39f515c11c1";
    const VIRTUAL_ADDRESS = "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b";

    const tokens = [
        USDC_ADDRESS,
        cbETH_ADDRESS,
        WETH_ADDRESS,
        USDbC_ADDRESS,
        cbBTC_ADDRESS,
        eUSD_ADDRESS,
        MAI_ADDRESS,
        DAI_ADDRESS,
        sUSDS_ADDRESS,
        AERO_ADDRESS,
        wstETH_ADDRESS,
        rETH_ADDRESS,
        weETH_ADDRESS,
        EURC_ADDRESS,
        wrsETH_ADDRESS,
        WELL_ADDRESS,
        USDS_ADDRESS,
        tBTC_ADDRESS,
        LBTC_ADDRESS,
        VIRTUAL_ADDRESS,
    ];

    // Retry logic for whitelist transaction
    let attempts = 0;
    const maxAttempts = 3;
    
    while (attempts < maxAttempts) {
        try {
            // Get fresh gas options for each attempt
            const currentGasOptions = await getGasOptions();
            
            console.log(`Attempting to whitelist tokens (attempt ${attempts + 1}/${maxAttempts})...`);
            const whitelistTx = await registry.addToWhitelistBatch(tokens, {
                ...currentGasOptions,
                gasLimit: 3000000,
            });
            
            console.log(`Whitelist transaction sent: ${whitelistTx.hash}`);
            await whitelistTx.wait();
            console.log("Tokens added to whitelist successfully");
            return; // Success, exit the retry loop
            
        } catch (error: any) {
            attempts++;
            console.log(`Whitelist attempt ${attempts} failed:`, error.message);
            
            if (attempts < maxAttempts) {
                console.log(`Waiting 10 seconds before retry...`);
                await new Promise(resolve => setTimeout(resolve, 10000));
            } else {
                console.log("All whitelist attempts failed, but continuing deployment...");
                console.log("You may need to whitelist tokens manually later.");
            }
        }
    }
}