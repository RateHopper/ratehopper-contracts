import { ethers } from "hardhat";
import Safe from "@safe-global/protocol-kit";
import dotenv from "dotenv";
import rolesAbi from "../externalAbi/zodiac/role.json";
dotenv.config();

/**
 * Deploy Zodiac Roles Modifier using ModuleProxyFactory
 *
 * This script:
 * 1. Deploys a minimal proxy pointing to the canonical Roles mastercopy
 * 2. Initializes it with the Safe as avatar and owner
 * 3. Automatically enables the module on the Safe using Safe SDK
 *
 * Addresses on Base Mainnet:
 * - ModuleProxyFactory: 0x000000000000aDdB49795b0f9bA5BC298cDda236
 * - Roles Mastercopy: 0x9646fDAD06d3e24444381f44362a3B0eB343D337
 *
 * Environment Variables Required:
 * - SAFE_WALLET_ADDRESS: Your Safe wallet address (avatar)
 * - MY_SAFE_OWNER_KEY: Private key of a Safe owner (to enable module)
 */

// Contract addresses on Base Mainnet
const MODULE_PROXY_FACTORY = "0x000000000000aDdB49795b0f9bA5BC298cDda236";
const ROLES_MASTERCOPY = "0x9646fDAD06d3e24444381f44362a3B0eB343D337";

// ModuleProxyFactory ABI - only the deployModule function we need
const MODULE_PROXY_FACTORY_ABI = [
    "function deployModule(address masterCopy, bytes memory initializer, uint256 saltNonce) public returns (address proxy)",
    "event ModuleProxyCreation(address indexed proxy, address indexed masterCopy)",
];

async function main() {
    console.log("\n🚀 Deploying Roles Modifier Proxy using ModuleProxyFactory...\n");

    // Get deployer
    const [deployer] = await ethers.getSigners();
    console.log("Deployer address:", deployer.address);
    console.log("Deployer balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH\n");

    // Get parameters from environment
    const safeAddress = process.env.TESTING_SAFE_WALLET_ADDRESS;
    const ownerAddress = "0x9E073c36F63BF1c611026fdA1fF6007A81932231";

    if (!safeAddress || safeAddress === "YOUR_SAFE_ADDRESS_HERE") {
        throw new Error("❌ Please set SAFE_WALLET_ADDRESS in your .env file");
    }

    console.log("Configuration:");
    console.log("- Safe (Avatar):", safeAddress);
    console.log("- Owner:", ownerAddress);
    console.log("- Target:", safeAddress); // Usually same as avatar
    console.log("- Mastercopy:", ROLES_MASTERCOPY);
    console.log("- Factory:", MODULE_PROXY_FACTORY);
    console.log();

    // Connect to the factory
    const factory = new ethers.Contract(MODULE_PROXY_FACTORY, MODULE_PROXY_FACTORY_ABI, deployer);

    // Encode initialization parameters for Roles.setUp()
    // setUp expects: abi.encode(owner, avatar, target)
    const initializeParams = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "address"],
        [ownerAddress, safeAddress, safeAddress],
    );

    // Encode the setUp call
    const rolesInterface = new ethers.Interface(rolesAbi);
    const initializer = rolesInterface.encodeFunctionData("setUp", [initializeParams]);

    // Generate a unique salt nonce (using timestamp)
    const saltNonce = Date.now();

    console.log("📝 Deployment parameters:");
    console.log("- Salt nonce:", saltNonce);
    console.log("- Initializer:", initializer);
    console.log();

    // Deploy the proxy
    console.log("⏳ Deploying Roles proxy...");
    const tx = await factory.deployModule(ROLES_MASTERCOPY, initializer, saltNonce);

    console.log("Transaction hash:", tx.hash);
    console.log("⏳ Waiting for confirmation...");

    const receipt = await tx.wait();
    console.log("✅ Transaction confirmed in block:", receipt.blockNumber);
    console.log();

    // Parse the event to get the deployed proxy address
    const event = receipt.logs.find((log: any) => {
        try {
            const parsedLog = factory.interface.parseLog(log);
            return parsedLog?.name === "ModuleProxyCreation";
        } catch {
            return false;
        }
    });

    if (!event) {
        throw new Error("❌ Could not find ModuleProxyCreation event");
    }

    const parsedEvent = factory.interface.parseLog(event);
    const proxyAddress = parsedEvent?.args.proxy;

    console.log("✅ Roles Modifier Proxy deployed!");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📍 Proxy Address:", proxyAddress);
    console.log("📍 Mastercopy:", ROLES_MASTERCOPY);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log();

    // Verify the deployment
    console.log("🔍 Verifying deployment...");
    const rolesProxy = new ethers.Contract(proxyAddress, rolesAbi, deployer);

    const deployedOwner = await rolesProxy.owner();
    const deployedAvatar = await rolesProxy.avatar();

    console.log("Owner:", deployedOwner);
    console.log("Avatar:", deployedAvatar);

    if (deployedOwner !== ownerAddress || deployedAvatar !== safeAddress) {
        console.warn("⚠️  Warning: Deployed parameters don't match expected values!");
    } else {
        console.log("✅ Deployment verified successfully!");
    }

    // Enable the module on the Safe using Safe SDK
    console.log();
    console.log("📌 Enabling module on Safe...");

    if (!process.env.TESTING_SAFE_OWNER_KEY) {
        throw new Error("❌ MY_SAFE_OWNER_KEY not set in .env file");
    }

    try {
        const safeWallet = await Safe.init({
            provider: "https://base.llamarpc.com",
            signer: process.env.TESTING_SAFE_OWNER_KEY,
            safeAddress: safeAddress,
        });

        const enableModuleTx = await safeWallet.createEnableModuleTx(proxyAddress);
        const safeTxHash = await safeWallet.executeTransaction(enableModuleTx);

        console.log("✅ Safe transaction hash:", safeTxHash);
        console.log();
        console.log("🎉 Roles Modifier is now active on your Safe!");
        console.log();

        // Verify modules
        const modules = await safeWallet.getModules();
        console.log("📋 Enabled modules:", modules);
    } catch (error: any) {
        console.log();
        console.log("⚠️  Could not enable module automatically.");
        console.log("This is expected if the module is already enabled.");
        console.log();
        console.log("Error details:", error.message);
        throw error;
    }

    console.log();
    console.log("🔗 View on BaseScan:");
    console.log(`   https://basescan.org/address/${proxyAddress}`);
    console.log();

    // Save deployment info
    const deploymentInfo = {
        network: "base",
        timestamp: new Date().toISOString(),
        deployer: deployer.address,
        factory: MODULE_PROXY_FACTORY,
        mastercopy: ROLES_MASTERCOPY,
        proxy: proxyAddress,
        safe: safeAddress,
        owner: ownerAddress,
        txHash: tx.hash,
        blockNumber: receipt.blockNumber,
    };

    console.log("💾 Deployment Info:");
    console.log(JSON.stringify(deploymentInfo, null, 2));
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("\n❌ Deployment failed:");
        console.error(error);
        process.exit(1);
    });
