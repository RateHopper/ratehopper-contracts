import { ethers } from "hardhat";
import dotenv from "dotenv";
dotenv.config();

/**
 * Practical Example: Configure Roles for SafeDebtManager Operations
 *
 * This example shows how to set up permissions so that an operator address
 * can execute debt swaps through the Roles Modifier.
 *
 * Scenario:
 * - You have a Safe wallet with the Roles Modifier enabled
 * - You want to allow an operator to execute debt swaps
 * - The operator should only be able to call specific functions
 *
 * Prerequisites:
 * 1. Deploy Roles proxy: yarn deploy:zodiac-roles-proxy
 * 2. Enable the Roles module in your Safe
 * 3. Set environment variables
 */

// ============================================
// Configuration
// ============================================

const CONFIG = {
    // Addresses from your deployment
    rolesProxy: process.env.ROLES_PROXY_ADDRESS!,
    safeAddress: process.env.SAFE_WALLET_ADDRESS!,
    safeDebtManager: process.env.SAFE_DEBT_MANAGER_ADDRESS!,
    operatorAddress: process.env.OPERATOR_ADDRESS!,

    // Role definitions
    roles: {
        DEBT_OPERATOR: ethers.keccak256(ethers.toUtf8Bytes("DEBT_OPERATOR")),
        EXIT_OPERATOR: ethers.keccak256(ethers.toUtf8Bytes("EXIT_OPERATOR")),
    },
};

// ============================================
// Step 1: Define Permissions
// ============================================

async function definePermissions() {
    console.log("\n📝 Step 1: Defining Permissions\n");

    const [owner] = await ethers.getSigners();
    const roles = new ethers.Contract(
        CONFIG.rolesProxy,
        [
            "function scopeTarget(bytes32 role, address targetAddress) external",
            "function scopeAllowFunction(bytes32 role, address targetAddress, bytes4 functionSig, uint8 options) external",
            "function scopeFunction(bytes32 role, address targetAddress, bytes4 functionSig, bool[] isScoped, uint8[] paramType, uint8[] paramComp, bytes[] compValue, uint8 options) external",
        ],
        owner
    );

    // Define what functions the DEBT_OPERATOR role can call

    // 1. Allow calling SafeDebtManager contract
    console.log("Scoping target: SafeDebtManager");
    let tx = await roles.scopeTarget(CONFIG.roles.DEBT_OPERATOR, CONFIG.safeDebtManager);
    await tx.wait();
    console.log("✅ Target scoped");

    // 2. Allow executeDebtSwap function
    const executeDebtSwapSig = ethers.id("executeDebtSwap(address,uint8,uint8,address,address,uint256,(address,uint256)[],address,bytes[2],(uint256,bytes))").substring(0, 10);
    console.log("\nAllowing function: executeDebtSwap");
    console.log("Function signature:", executeDebtSwapSig);

    tx = await roles.scopeAllowFunction(
        CONFIG.roles.DEBT_OPERATOR,
        CONFIG.safeDebtManager,
        executeDebtSwapSig,
        0 // ExecutionOptions.None
    );
    await tx.wait();
    console.log("✅ Function allowed");

    // 3. Allow exit function for EXIT_OPERATOR role
    const exitSig = ethers.id("exit(uint8,address,uint256,(address,uint256)[],address,bytes,bool)").substring(0, 10);
    console.log("\nAllowing function: exit");
    console.log("Function signature:", exitSig);

    tx = await roles.scopeAllowFunction(
        CONFIG.roles.EXIT_OPERATOR,
        CONFIG.safeDebtManager,
        exitSig,
        0 // ExecutionOptions.None
    );
    await tx.wait();
    console.log("✅ Function allowed");

    console.log("\n✅ Step 1 Complete: Permissions defined\n");
}

// ============================================
// Step 2: Assign Roles to Addresses
// ============================================

async function assignRoles() {
    console.log("\n👤 Step 2: Assigning Roles to Addresses\n");

    const [owner] = await ethers.getSigners();
    const roles = new ethers.Contract(
        CONFIG.rolesProxy,
        [
            "function assignRoles(address module, bytes32[] roleKeys, bool[] memberOf) external",
            "function setDefaultRole(address module, bytes32 defaultRole) external",
        ],
        owner
    );

    // Assign both roles to the operator
    console.log("Assigning roles to:", CONFIG.operatorAddress);
    console.log("Roles:", ["DEBT_OPERATOR", "EXIT_OPERATOR"]);

    const tx = await roles.assignRoles(
        CONFIG.operatorAddress,
        [CONFIG.roles.DEBT_OPERATOR, CONFIG.roles.EXIT_OPERATOR],
        [true, true] // true = assign both roles
    );
    await tx.wait();
    console.log("✅ Roles assigned");

    // Set default role (used when calling execTransactionFromModule)
    console.log("\nSetting default role: DEBT_OPERATOR");
    const tx2 = await roles.setDefaultRole(
        CONFIG.operatorAddress,
        CONFIG.roles.DEBT_OPERATOR
    );
    await tx2.wait();
    console.log("✅ Default role set");

    console.log("\n✅ Step 2 Complete: Roles assigned\n");
}

// ============================================
// Step 3: Test the Configuration
// ============================================

async function testConfiguration() {
    console.log("\n🧪 Step 3: Testing Configuration\n");

    const [owner] = await ethers.getSigners();
    const roles = new ethers.Contract(
        CONFIG.rolesProxy,
        [
            "function defaultRoles(address) view returns (bytes32)",
            "function owner() view returns (address)",
            "function avatar() view returns (address)",
            "function target() view returns (address)",
        ],
        owner
    );

    // Read configuration
    const [defaultRole, rolesOwner, avatar, target] = await Promise.all([
        roles.defaultRoles(CONFIG.operatorAddress),
        roles.owner(),
        roles.avatar(),
        roles.target(),
    ]);

    console.log("Roles Contract Configuration:");
    console.log("- Owner:", rolesOwner);
    console.log("- Avatar (Safe):", avatar);
    console.log("- Target:", target);
    console.log("\nOperator Configuration:");
    console.log("- Operator Address:", CONFIG.operatorAddress);
    console.log("- Default Role:", defaultRole);
    console.log("- Expected Role:", CONFIG.roles.DEBT_OPERATOR);
    console.log("- Match:", defaultRole === CONFIG.roles.DEBT_OPERATOR ? "✅" : "❌");

    // Verify Safe configuration
    if (avatar !== CONFIG.safeAddress) {
        console.warn("\n⚠️  Warning: Avatar doesn't match SAFE_WALLET_ADDRESS");
    }

    console.log("\n✅ Step 3 Complete: Configuration verified\n");
}

// ============================================
// Step 4: Example Usage
// ============================================

async function showUsageExample() {
    console.log("\n📚 Step 4: Usage Example\n");

    console.log("Now your operator can execute transactions through the Roles Modifier:\n");

    console.log("// Example: Execute debt swap as operator");
    console.log("const roles = new ethers.Contract(rolesProxyAddress, ROLES_ABI, operatorSigner);");
    console.log("");
    console.log("// Prepare the call data for SafeDebtManager.executeDebtSwap");
    console.log("const safeDebtManager = new ethers.Contract(safeDebtManagerAddress, SAFE_DEBT_MANAGER_ABI);");
    console.log("const callData = safeDebtManager.interface.encodeFunctionData('executeDebtSwap', [");
    console.log("  flashloanPool,");
    console.log("  fromProtocol,");
    console.log("  toProtocol,");
    console.log("  fromDebtAsset,");
    console.log("  toDebtAsset,");
    console.log("  amount,");
    console.log("  collateralAssets,");
    console.log("  onBehalfOf,");
    console.log("  extraData,");
    console.log("  paraswapParams");
    console.log("]);");
    console.log("");
    console.log("// Execute through Roles with default role (DEBT_OPERATOR)");
    console.log("const tx = await roles.execTransactionFromModule(");
    console.log("  safeDebtManagerAddress,");
    console.log("  0, // value");
    console.log("  callData,");
    console.log("  0 // Operation.Call");
    console.log(");");
    console.log("await tx.wait();");
    console.log("");

    console.log("✅ Setup complete! Your operator can now execute permitted functions.\n");
}

// ============================================
// Main Execution
// ============================================

async function main() {
    console.log("\n" + "=".repeat(60));
    console.log("  Zodiac Roles Configuration for SafeDebtManager");
    console.log("=".repeat(60));

    // Validate environment
    if (!CONFIG.rolesProxy || CONFIG.rolesProxy === "undefined") {
        throw new Error("❌ ROLES_PROXY_ADDRESS not set");
    }
    if (!CONFIG.safeAddress || CONFIG.safeAddress === "YOUR_SAFE_ADDRESS_HERE") {
        throw new Error("❌ SAFE_WALLET_ADDRESS not set");
    }
    if (!CONFIG.safeDebtManager) {
        throw new Error("❌ SAFE_DEBT_MANAGER_ADDRESS not set");
    }
    if (!CONFIG.operatorAddress) {
        throw new Error("❌ OPERATOR_ADDRESS not set");
    }

    console.log("\nConfiguration:");
    console.log("- Roles Proxy:", CONFIG.rolesProxy);
    console.log("- Safe Address:", CONFIG.safeAddress);
    console.log("- SafeDebtManager:", CONFIG.safeDebtManager);
    console.log("- Operator:", CONFIG.operatorAddress);

    try {
        // Execute all steps
        await definePermissions();
        await assignRoles();
        await testConfiguration();
        await showUsageExample();

        console.log("🎉 All steps completed successfully!\n");
    } catch (error) {
        console.error("\n❌ Error during configuration:");
        console.error(error);
        throw error;
    }
}

// Run the script
if (require.main === module) {
    main()
        .then(() => process.exit(0))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}

export { definePermissions, assignRoles, testConfiguration };
