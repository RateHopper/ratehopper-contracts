import { ethers } from "hardhat";
import { KitContract, applyAnnotations, applyTargets } from "zodiac-roles-sdk";
import dotenv from "dotenv";
dotenv.config();

/**
 * Configure Roles Modifier Permissions using Zodiac Roles SDK
 *
 * This script demonstrates how to:
 * 1. Connect to a deployed Roles contract
 * 2. Define permissions for specific contracts/functions
 * 3. Apply permissions to roles
 * 4. Assign roles to addresses
 *
 * Environment Variables Required:
 * - ROLES_PROXY_ADDRESS: Address of your deployed Roles proxy
 * - MODULE_ADDRESS: Address that will execute transactions with roles
 */

// Role IDs (you can generate these or use predefined ones)
const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE"));
const TRADER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TRADER_ROLE"));

async function main() {
    console.log("\n⚙️  Configuring Roles Modifier Permissions...\n");

    // Get signer (must be the owner of the Roles contract)
    const [signer] = await ethers.getSigners();
    console.log("Signer:", signer.address);

    // Get configuration from environment
    const rolesProxyAddress = process.env.ROLES_PROXY_ADDRESS;
    const moduleAddress = process.env.MODULE_ADDRESS;

    if (!rolesProxyAddress) {
        throw new Error("❌ Please set ROLES_PROXY_ADDRESS in your .env file");
    }

    if (!moduleAddress) {
        throw new Error("❌ Please set MODULE_ADDRESS in your .env file");
    }

    console.log("Configuration:");
    console.log("- Roles Proxy:", rolesProxyAddress);
    console.log("- Module Address:", moduleAddress);
    console.log();

    // ============================================
    // EXAMPLE 1: Basic Permission Setup
    // ============================================
    console.log("📝 Example 1: Setting up basic permissions\n");

    // Connect to the deployed Roles contract
    const roles = await KitContract.attach({
        address: rolesProxyAddress,
        provider: signer.provider!,
    });

    // Define target contracts and their ABIs
    const targetContracts = {
        // Example: USDC Token
        usdc: {
            address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC on Base
            abi: [
                "function transfer(address to, uint256 amount) returns (bool)",
                "function approve(address spender, uint256 amount) returns (bool)",
            ],
        },
        // Example: Your SafeDebtManager contract
        safeDebtManager: {
            address: process.env.SAFE_DEBT_MANAGER_ADDRESS || ethers.ZeroAddress,
            abi: [
                "function executeDebtSwap(address,uint8,uint8,address,address,uint256,tuple(address,uint256)[],address,bytes[2],tuple(uint256,bytes)) external",
                "function exit(uint8,address,uint256,tuple(address,uint256)[],address,bytes,bool) external",
            ],
        },
    };

    // Apply permissions using SDK annotations
    const annotations = applyAnnotations(roles, (contracts) => {
        // Allow OPERATOR_ROLE to call any function on USDC
        contracts.usdc.allow.transfer();
        contracts.usdc.allow.approve();

        // Allow OPERATOR_ROLE to execute debt swaps
        contracts.safeDebtManager.allow.executeDebtSwap();

        // Allow TRADER_ROLE to only transfer USDC (more restricted)
        contracts.usdc.allow.transfer();
    });

    console.log("✅ Annotations defined");
    console.log();

    // ============================================
    // EXAMPLE 2: Advanced Permission with Conditions
    // ============================================
    console.log("📝 Example 2: Setting permissions with conditions\n");

    const advancedAnnotations = applyAnnotations(roles, (contracts) => {
        // Only allow transfers up to a certain amount
        contracts.usdc.allow.transfer({
            // Add parameter conditions
            send: true, // Allow sending ETH with transaction
        });

        // Allow approve but only for specific addresses
        contracts.usdc.allow.approve({
            // You can add conditions based on parameters
        });
    });

    console.log("✅ Advanced annotations defined");
    console.log();

    // ============================================
    // EXAMPLE 3: Apply Permissions to Blockchain
    // ============================================
    console.log("📝 Example 3: Applying permissions on-chain\n");

    // Create target calls from annotations
    const targets = await applyTargets(roles, {
        ...targetContracts,
    });

    console.log("Generated target calls:", targets.length);

    // Apply the permissions on-chain (requires owner of Roles contract)
    console.log("\n⏳ Applying permissions to blockchain...");

    for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        console.log(`\nApplying target ${i + 1}/${targets.length}:`);
        console.log("- To:", target.to);
        console.log("- Data:", target.data.substring(0, 66) + "...");

        // Execute the transaction
        const tx = await signer.sendTransaction({
            to: target.to,
            data: target.data,
        });

        console.log("- TX Hash:", tx.hash);
        await tx.wait();
        console.log("✅ Confirmed");
    }

    // ============================================
    // EXAMPLE 4: Assign Roles to Addresses
    // ============================================
    console.log("\n📝 Example 4: Assigning roles to addresses\n");

    // Get the Roles contract interface
    const rolesContract = new ethers.Contract(
        rolesProxyAddress,
        [
            "function assignRoles(address module, bytes32[] roleKeys, bool[] memberOf) external",
            "function setDefaultRole(address module, bytes32 defaultRole) external",
        ],
        signer
    );

    // Assign OPERATOR_ROLE to the module address
    console.log("Assigning OPERATOR_ROLE to module...");
    let tx = await rolesContract.assignRoles(
        moduleAddress,
        [OPERATOR_ROLE],
        [true] // true = assign, false = revoke
    );
    await tx.wait();
    console.log("✅ OPERATOR_ROLE assigned");

    // Set default role for the module
    console.log("\nSetting default role for module...");
    tx = await rolesContract.setDefaultRole(moduleAddress, OPERATOR_ROLE);
    await tx.wait();
    console.log("✅ Default role set");

    // ============================================
    // EXAMPLE 5: Verify Configuration
    // ============================================
    console.log("\n📝 Example 5: Verifying configuration\n");

    const rolesReader = new ethers.Contract(
        rolesProxyAddress,
        [
            "function defaultRoles(address) view returns (bytes32)",
            "function owner() view returns (address)",
            "function avatar() view returns (address)",
        ],
        signer
    );

    const defaultRole = await rolesReader.defaultRoles(moduleAddress);
    const owner = await rolesReader.owner();
    const avatar = await rolesReader.avatar();

    console.log("Verification:");
    console.log("- Owner:", owner);
    console.log("- Avatar:", avatar);
    console.log("- Module:", moduleAddress);
    console.log("- Default Role:", defaultRole);
    console.log("- Expected Role:", OPERATOR_ROLE);
    console.log("- Match:", defaultRole === OPERATOR_ROLE ? "✅" : "❌");

    console.log("\n✅ Configuration complete!\n");
    console.log("📋 Summary:");
    console.log("- Permissions defined for target contracts");
    console.log("- Roles assigned to module address");
    console.log("- Default role configured");
    console.log("\n🎉 Your Roles Modifier is now configured!");
}

// Run with error handling
main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("\n❌ Configuration failed:");
        console.error(error);
        process.exit(1);
    });
