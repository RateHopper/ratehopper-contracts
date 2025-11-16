import { ethers } from "hardhat";
import { allow } from "zodiac-roles-sdk/kit";
import { processPermissions, applyTargets } from "zodiac-roles-sdk";
import dotenv from "dotenv";
dotenv.config();

/**
 * Configure Roles Modifier using the Official SDK Pattern
 *
 * This example uses the recommended SDK approach with:
 * - eth-sdk for contract definitions
 * - allow() for permission definitions
 * - processPermissions() to generate permission calls
 * - applyTargets() to apply to the Roles contract
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
    rolesModAddress: "",
    operatorAddress: process.env.SAFE_OPERATOR_ADDRESS!,
    chainId: 8453, // Base mainnet

    // Define role keys
    roles: {
        DEBT_OPERATOR: ethers.keccak256(ethers.toUtf8Bytes("DEBT_OPERATOR")),
        TRADER: ethers.keccak256(ethers.toUtf8Bytes("TRADER")),
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
        allow.base.usdc.transfer(),

        // Allow USDC approvals (for protocols)
        allow.base.usdc.approve(),

        // ========================================
        // SafeDebtManager Permissions
        // ========================================

        // Allow debt swap execution
        // Note: The SDK will automatically handle the function signature
        allow.base.safeDebtManager.executeDebtSwap(),

        // Allow position exits
        allow.base.safeDebtManager.exit(),

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

    const [signer] = await ethers.getSigners();

    // Generate the transaction calls needed to apply these permissions
    const calls = applyTargets(CONFIG.roles.DEBT_OPERATOR, targets, {
        chainId: CONFIG.chainId,
        address: CONFIG.rolesModAddress,
        mode: "replace", // Options: 'replace' | 'extend'
    });

    console.log(`Generated ${calls.length} transaction calls`);

    // Execute each call to set up the permissions
    for (let i = 0; i < calls.length; i++) {
        const call = calls[i];

        console.log(`\n📤 Executing call ${i + 1}/${calls.length}`);
        console.log("- To:", call.to);
        console.log("- Value:", call.value?.toString() || "0");
        console.log("- Data:", call.data.substring(0, 66) + "...");

        const tx = await signer.sendTransaction({
            to: call.to,
            value: call.value || 0,
            data: call.data,
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

    const [signer] = await ethers.getSigners();

    const rolesContract = new ethers.Contract(
        CONFIG.rolesModAddress,
        [
            "function assignRoles(address module, bytes32[] roleKeys, bool[] memberOf) external",
            "function setDefaultRole(address module, bytes32 defaultRole) external",
        ],
        signer,
    );

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

    const [signer] = await ethers.getSigners();

    const rolesContract = new ethers.Contract(
        CONFIG.rolesModAddress,
        [
            "function defaultRoles(address) view returns (bytes32)",
            "function owner() view returns (address)",
            "function avatar() view returns (address)",
        ],
        signer,
    );

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
// Step 5: Usage Example
// ============================================

async function showUsageExample() {
    console.log("\n📚 Step 5: How to Use the Configured Roles\n");

    console.log("Your operator can now execute transactions through the Roles Modifier:\n");

    console.log("```typescript");
    console.log("// Connect to Roles contract as operator");
    console.log("const roles = new ethers.Contract(");
    console.log(`  "${CONFIG.rolesModAddress}",`);
    console.log("  ROLES_ABI,");
    console.log("  operatorSigner");
    console.log(");");
    console.log("");
    console.log("// Prepare SafeDebtManager call");
    console.log("const safeDebtManager = new ethers.Contract(");
    console.log('  "0xYourSafeDebtManagerAddress", // From eth-sdk config');
    console.log("  SAFE_DEBT_MANAGER_ABI");
    console.log(");");
    console.log("");
    console.log("const callData = safeDebtManager.interface.encodeFunctionData(");
    console.log('  "executeDebtSwap",');
    console.log("  [flashloanPool, fromProtocol, toProtocol, ...]");
    console.log(");");
    console.log("");
    console.log("// Execute through Roles (uses default role automatically)");
    console.log("const tx = await roles.execTransactionFromModule(");
    console.log('  "0xYourSafeDebtManagerAddress", // From eth-sdk config');
    console.log("  0, // value");
    console.log("  callData,");
    console.log("  0 // Operation.Call");
    console.log(");");
    console.log("");
    console.log("await tx.wait();");
    console.log("console.log('✅ Debt swap executed!');");
    console.log("```");
    console.log("");
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
            await showUsageExample();
            console.log("🎉 All steps completed successfully!\n");
            console.log("✅ Your operator can now execute permitted functions through the Roles Modifier.");
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
