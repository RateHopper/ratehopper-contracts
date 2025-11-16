import { ethers } from "hardhat";
import dotenv from "dotenv";
dotenv.config();

/**
 * Deploy Zodiac Roles Modifier using ModuleProxyFactory
 *
 * This script deploys a minimal proxy pointing to the canonical Roles mastercopy
 * using the official Zodiac ModuleProxyFactory pattern.
 *
 * Addresses on Base Mainnet:
 * - ModuleProxyFactory: 0x000000000000aDdB49795b0f9bA5BC298cDda236
 * - Roles Mastercopy: 0x9646fDAD06d3e24444381f44362a3B0eB343D337
 *
 * Environment Variables Required:
 * - SAFE_WALLET_ADDRESS: Your Safe wallet address (avatar)
 * - ADMIN_ADDRESS: Address that will own the Roles modifier
 */

// Contract addresses on Base Mainnet
const MODULE_PROXY_FACTORY = "0x000000000000aDdB49795b0f9bA5BC298cDda236";
const ROLES_MASTERCOPY = "0x9646fDAD06d3e24444381f44362a3B0eB343D337";

// ModuleProxyFactory ABI - only the deployModule function we need
const MODULE_PROXY_FACTORY_ABI = [
    "function deployModule(address masterCopy, bytes memory initializer, uint256 saltNonce) public returns (address proxy)",
    "event ModuleProxyCreation(address indexed proxy, address indexed masterCopy)",
];

// Roles setUp function signature for initialization
const ROLES_SETUP_ABI = ["function setUp(bytes memory initializeParams) public"];

async function main() {
    console.log("\n🚀 Deploying Roles Modifier Proxy using ModuleProxyFactory...\n");

    // Get deployer
    const [deployer] = await ethers.getSigners();
    console.log("Deployer address:", deployer.address);
    console.log("Deployer balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH\n");

    // Get parameters from environment
    const safeAddress = process.env.SAFE_WALLET_ADDRESS;
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
    const rolesInterface = new ethers.Interface(ROLES_SETUP_ABI);
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
    const rolesProxy = new ethers.Contract(
        proxyAddress,
        [
            "function owner() view returns (address)",
            "function avatar() view returns (address)",
            "function target() view returns (address)",
        ],
        deployer,
    );

    const deployedOwner = await rolesProxy.owner();
    const deployedAvatar = await rolesProxy.avatar();
    const deployedTarget = await rolesProxy.target();

    console.log("Owner:", deployedOwner);
    console.log("Avatar:", deployedAvatar);
    console.log("Target:", deployedTarget);
    console.log();

    if (deployedOwner !== ownerAddress || deployedAvatar !== safeAddress || deployedTarget !== safeAddress) {
        console.warn("⚠️  Warning: Deployed parameters don't match expected values!");
    } else {
        console.log("✅ Deployment verified successfully!");
    }

    console.log();
    console.log("📋 Next Steps:");
    console.log("1. Add this module to your Safe:");
    console.log(`   - Go to: https://app.safe.global/home?safe=base:${safeAddress}`);
    console.log("   - Settings → Modules → Add Module");
    console.log(`   - Enter address: ${proxyAddress}`);
    console.log();
    console.log("2. Or use Safe transaction builder to call:");
    console.log(`   enableModule(${proxyAddress})`);
    console.log();
    console.log("3. View on BaseScan:");
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
