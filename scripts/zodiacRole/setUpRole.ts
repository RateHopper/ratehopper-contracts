import { ethers } from "hardhat";
import { allow } from "zodiac-roles-sdk/kit";
import { processPermissions, planApplyRole } from "zodiac-roles-sdk";
import dotenv from "dotenv";
import rolesAbi from "../../externalAbi/zodiac/role.json";
dotenv.config();

/**
 * Configure Roles Modifier using the Official SDK Pattern
 *
 * This example uses the recommended SDK approach with:
 * - eth-sdk for contract definitions
 * - allow() for permission definitions
 * - processPermissions() to generate permission calls
 * - planApplyRole() to apply to the Roles contract
 *
 * Prerequisites:
 * 1. Run: yarn eth-sdk (to generate contract types)
 * 2. Deploy Roles proxy: yarn deploy:zodiac-roles-proxy
 * 3. Enable Roles module in Safe
 * 4. Set environment variables
 */

// ============================================
// Configuration
// ============================================

const CONFIG = {
    rolesModAddress: "0xa98bed23d1C9416D674F656b5e178594a10Fb557",
    operatorAddress: process.env.SAFE_OPERATOR_ADDRESS!,
    chainId: 8453, // Base mainnet

    // Define role keys
    roles: {
        DEBT_OPERATOR: ethers.keccak256(ethers.toUtf8Bytes("DEBT_OPERATOR")),
    },
};

// ============================================
// Step 1: Define Permissions using SDK
// ============================================

async function definePermissionsWithSDK() {
    console.log("\n📝 Step 1: Defining Permissions with SDK\n");

    // Define permissions using the allow() helper
    // This creates type-safe permission definitions
    const permissions = [
        // ========================================
        // USDC Token Permissions
        // ========================================

        // Allow USDC transfers
        // allow.base.usdc.transfer(),

        // Allow USDC approvals (for protocols)
        allow.base.usdc.approve(),

        // ========================================
        // SafeDebtManager Permissions
        // ========================================

        // Allow debt swap execution
        // Note: The SDK will automatically handle the function signature
        // allow.base.safeDebtManager.executeDebtSwap(),

        // Allow position exits
        // allow.base.safeDebtManager.exit(),

        // ========================================
        // Advanced: With Parameter Conditions
        // ========================================

        // Example: Only allow USDC approvals to specific protocols
        // allow.base.usdc.approve({
        //     // Add conditions on the spender parameter
        //     // This is more advanced - see SDK docs
        // }),
    ];

    console.log(`✅ Defined ${permissions.length} permissions`);

    // Process permissions into target calls
    const { targets } = processPermissions(permissions);

    console.log(`✅ Processed into ${targets.length} target configurations`);

    return targets;
}

// ============================================
// Step 2: Apply Permissions to Roles Contract
// ============================================

async function applyPermissionsToRole(targets: any[]) {
    console.log("\n⚙️  Step 2: Applying Permissions to Role\n");

    // Use Safe owner key if provided, otherwise fall back to default signer
    const signer = process.env.TESTING_SAFE_OWNER_KEY
        ? new ethers.Wallet(process.env.TESTING_SAFE_OWNER_KEY, ethers.provider)
        : (await ethers.getSigners())[0];

    // Check if signer is the owner of the Roles Modifier
    const rolesContract = new ethers.Contract(CONFIG.rolesModAddress, rolesAbi, signer);

    const owner = await rolesContract.owner();
    console.log("Roles Modifier Owner:", owner);
    console.log("Current Signer:", signer.address);

    if (owner.toLowerCase() !== signer.address.toLowerCase()) {
        console.log("\n⚠️  WARNING: Current signer is not the owner of the Roles Modifier!");
        console.log("These calls must be executed by the Safe that owns the Roles Modifier.");
        console.log("\nℹ️  You have two options:");
        console.log("1. Execute these calls through the Safe UI using the Transaction Builder");
        console.log("2. Use the Safe SDK to propose and execute these transactions\n");
    }

    // Generate the transaction calls needed to apply these permissions
    // planApplyRole creates a RoleFragment with the key and targets
    const calls = await planApplyRole(
        {
            key: CONFIG.roles.DEBT_OPERATOR,
            targets,
        },
        {
            chainId: CONFIG.chainId,
            address: CONFIG.rolesModAddress,
        },
    );

    console.log(`Generated ${calls.length} transaction calls`);

    // If not owner, just show the calls without executing
    if (owner.toLowerCase() !== signer.address.toLowerCase()) {
        console.log("\n📋 Transaction calls to execute through Safe:\n");
        for (let i = 0; i < calls.length; i++) {
            const call = calls[i];
            console.log(`Call ${i + 1}/${calls.length}:`);
            console.log("- To:", call.to);
            console.log("- Value:", "0");
            console.log("- Data:", call.data);
            console.log();
        }
        console.log("⚠️  Skipping execution - use Safe to execute these calls\n");
        return;
    }

    // Execute each call to set up the permissions
    for (let i = 0; i < calls.length; i++) {
        const call = calls[i];

        console.log(`\n📤 Executing call ${i + 1}/${calls.length}`);
        console.log("- To:", call.to);
        console.log("- Value:", "0");
        console.log("- Data:", call.data.substring(0, 66) + "...");

        const tx = await signer.sendTransaction({
            to: call.to as string,
            value: 0,
            data: call.data as string,
        });

        console.log("- TX Hash:", tx.hash);
        await tx.wait();
        console.log("✅ Confirmed");
    }

    console.log("\n✅ Step 2 Complete: Permissions applied to role\n");
}

// ============================================
// Step 3: Assign Role to Operator
// ============================================

async function assignRoleToOperator() {
    console.log("\n👤 Step 3: Assigning Role to Operator\n");

    // Use Safe owner key if provided, otherwise fall back to default signer
    const signer = process.env.TESTING_SAFE_OWNER_KEY
        ? new ethers.Wallet(process.env.TESTING_SAFE_OWNER_KEY, ethers.provider)
        : (await ethers.getSigners())[0];

    const rolesContract = new ethers.Contract(CONFIG.rolesModAddress, rolesAbi, signer);

    const owner = await rolesContract.owner();

    // Assign DEBT_OPERATOR role to the operator address
    console.log("Assigning DEBT_OPERATOR role to:", CONFIG.operatorAddress);

    const assignTx = await rolesContract.assignRoles(
        CONFIG.operatorAddress,
        [CONFIG.roles.DEBT_OPERATOR],
        [true], // true = assign role
    );

    console.log("TX Hash:", assignTx.hash);
    await assignTx.wait();
    console.log("✅ Role assigned");

    // Set as default role
    console.log("\nSetting default role...");

    const defaultTx = await rolesContract.setDefaultRole(CONFIG.operatorAddress, CONFIG.roles.DEBT_OPERATOR);

    console.log("TX Hash:", defaultTx.hash);
    await defaultTx.wait();
    console.log("✅ Default role set");

    console.log("\n✅ Step 3 Complete: Role assigned to operator\n");
}

// ============================================
// Step 4: Verify Configuration
// ============================================

async function verifyConfiguration() {
    console.log("\n🔍 Step 4: Verifying Configuration\n");

    // Use Safe owner key if provided, otherwise fall back to default signer
    const signer = process.env.TESTING_SAFE_OWNER_KEY
        ? new ethers.Wallet(process.env.TESTING_SAFE_OWNER_KEY, ethers.provider)
        : (await ethers.getSigners())[0];

    const rolesContract = new ethers.Contract(CONFIG.rolesModAddress, rolesAbi, signer);

    // Check configuration
    const [defaultRole, owner, avatar] = await Promise.all([
        rolesContract.defaultRoles(CONFIG.operatorAddress),
        rolesContract.owner(),
        rolesContract.avatar(),
    ]);

    console.log("Roles Contract Info:");
    console.log("- Address:", CONFIG.rolesModAddress);
    console.log("- Owner:", owner);
    console.log("- Avatar (Safe):", avatar);

    console.log("\nOperator Configuration:");
    console.log("- Operator Address:", CONFIG.operatorAddress);
    console.log("- Default Role:", defaultRole);
    console.log("- Expected Role:", CONFIG.roles.DEBT_OPERATOR);
    console.log("- Match:", defaultRole === CONFIG.roles.DEBT_OPERATOR ? "✅" : "❌");

    console.log("\n✅ Step 4 Complete: Configuration verified\n");

    return defaultRole === CONFIG.roles.DEBT_OPERATOR;
}

// ============================================
// Main Function
// ============================================

async function main() {
    console.log("\n" + "=".repeat(70));
    console.log("  Zodiac Roles Configuration - Official SDK Pattern");
    console.log("=".repeat(70));

    // Validate environment
    if (!CONFIG.rolesModAddress) {
        throw new Error("❌ ROLES_PROXY_ADDRESS not set in .env");
    }
    if (!CONFIG.operatorAddress) {
        throw new Error("❌ SAFE_OPERATOR_ADDRESS not set in .env");
    }

    console.log("\nConfiguration:");
    console.log("- Chain:", "Base Mainnet (8453)");
    console.log("- Roles Modifier:", CONFIG.rolesModAddress);
    console.log("- Operator:", CONFIG.operatorAddress);
    console.log("\nNote: Contract addresses are defined in eth-sdk/config.ts");

    try {
        // Execute workflow
        const targets = await definePermissionsWithSDK();
        await applyPermissionsToRole(targets);
        await assignRoleToOperator();
        const verified = await verifyConfiguration();

        if (verified) {
            console.log("🎉 All steps completed successfully!\n");
            console.log("✅ Your operator can now execute permitted functions through the Roles Modifier.");
            console.log("\n💡 To see usage examples, run:");
            console.log("   yarn operator:execute");
        } else {
            console.warn("⚠️  Configuration may not be correct. Please review.");
        }
    } catch (error: any) {
        console.error("\n❌ Configuration failed:");
        console.error(error.message || error);
        throw error;
    }
}

// ============================================
// Execute
// ============================================

if (require.main === module) {
    main()
        .then(() => process.exit(0))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}

export { definePermissionsWithSDK, applyPermissionsToRole, assignRoleToOperator, verifyConfiguration };
