import { ethers } from "hardhat";
import dotenv from "dotenv";
import rolesAbi from "../../externalAbi/zodiac/role.json";
dotenv.config();

/**
 * Example: Operator Using Roles Modifier to Execute Permitted Functions
 *
 * This script demonstrates how an operator with assigned roles can execute
 * permitted functions through the Roles Modifier.
 *
 * In this example, the operator will:
 * - Call USDC approve() through the Roles Modifier
 * - The call will be validated against the configured permissions
 * - If permitted, it will be executed by the Safe
 *
 * Prerequisites:
 * 1. Roles Modifier is deployed and enabled on the Safe
 * 2. Permissions have been configured (via rolesSDKProperExample.ts)
 * 3. Operator has been assigned the DEBT_OPERATOR role
 * 4. SAFE_OPERATOR_KEY environment variable is set
 */

// ============================================
// Configuration
// ============================================

const CONFIG = {
    // Roles Modifier address
    rolesModAddress: "0xa98bed23d1C9416D674F656b5e178594a10Fb557",

    // USDC token address on Base
    usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",

    // Example spender address (you would use a real protocol address)
    // This could be Aave, Compound, or any DeFi protocol
    spenderAddress: "0x9E073c36F63BF1c611026fdA1fF6007A81932231", // Example: Morpho on Base

    // Approval amount (100 USDC with 6 decimals)
    approvalAmount: ethers.parseUnits("100", 6),

    // Chain ID
    chainId: 8453, // Base mainnet
};

// ============================================
// Main Function
// ============================================

async function main() {
    console.log("\n" + "=".repeat(70));
    console.log("  Operator Executing Through Roles Modifier");
    console.log("=".repeat(70));
    console.log();

    // Get operator signer from environment
    if (!process.env.TESTING_SAFE_OPERATOR_KEY) {
        throw new Error("❌ SAFE_OPERATOR_KEY not set in .env file");
    }

    const operatorSigner = new ethers.Wallet(process.env.TESTING_SAFE_OPERATOR_KEY, ethers.provider);

    console.log("Configuration:");
    console.log("- Operator Address:", operatorSigner.address);
    console.log("- Roles Modifier:", CONFIG.rolesModAddress);
    console.log("- USDC Address:", CONFIG.usdcAddress);
    console.log("- Spender:", CONFIG.spenderAddress);
    console.log("- Approval Amount:", ethers.formatUnits(CONFIG.approvalAmount, 6), "USDC");
    console.log();

    // ============================================
    // Step 1: Verify Operator Has Role
    // ============================================

    console.log("📋 Step 1: Verifying operator permissions...\n");

    const rolesContract = new ethers.Contract(CONFIG.rolesModAddress, rolesAbi, operatorSigner);

    const defaultRole = await rolesContract.defaultRoles(operatorSigner.address);
    const safeAddress = await rolesContract.avatar();

    console.log("Operator default role:", defaultRole);
    console.log("Safe (Avatar):", safeAddress);

    if (defaultRole === ethers.ZeroHash) {
        console.log("\n⚠️  WARNING: Operator does not have a default role assigned!");
        console.log("Please run the configuration script first: yarn configure:roles");
        return;
    }

    console.log("✅ Operator has role assigned\n");

    // ============================================
    // Step 2: Prepare USDC Approval Call
    // ============================================

    console.log("📝 Step 2: Preparing USDC approval transaction...\n");

    // Create USDC contract interface
    const usdcInterface = new ethers.Interface(["function approve(address spender, uint256 amount) returns (bool)"]);

    // Encode the approve function call
    const approveCallData = usdcInterface.encodeFunctionData("approve", [CONFIG.spenderAddress, CONFIG.approvalAmount]);

    console.log("Transaction details:");
    console.log("- Target (USDC):", CONFIG.usdcAddress);
    console.log("- Function: approve(address,uint256)");
    console.log("- Spender:", CONFIG.spenderAddress);
    console.log("- Amount:", ethers.formatUnits(CONFIG.approvalAmount, 6), "USDC");
    console.log("- Encoded data:", approveCallData);
    console.log();

    // ============================================
    // Step 3: Execute Through Roles Modifier
    // ============================================

    console.log("⚙️  Step 3: Executing through Roles Modifier...\n");

    try {
        // Call execTransactionFromModule on the Roles Modifier
        // The Roles Modifier will:
        // 1. Check if the operator has permission to call USDC.approve()
        // 2. If permitted, forward the call to the Safe
        // 3. The Safe will execute the actual USDC approval

        const tx = await rolesContract.execTransactionFromModule(
            CONFIG.usdcAddress, // to: USDC contract
            0, // value: 0 (no ETH sent)
            approveCallData, // data: encoded approve() call
            0, // operation: 0 = Call (not DelegateCall)
        );

        console.log("✅ Transaction submitted!");
        console.log("TX Hash:", tx.hash);
        console.log("⏳ Waiting for confirmation...\n");

        const receipt = await tx.wait();

        console.log("✅ Transaction confirmed!");
        console.log("Block:", receipt.blockNumber);
        console.log("Gas used:", receipt.gasUsed.toString());
        console.log();

        // ============================================
        // Step 4: Verify Approval
        // ============================================

        console.log("🔍 Step 4: Verifying approval...\n");

        const usdcContract = new ethers.Contract(
            CONFIG.usdcAddress,
            ["function allowance(address owner, address spender) view returns (uint256)"],
            ethers.provider,
        );

        const allowance = await usdcContract.allowance(safeAddress, CONFIG.spenderAddress);

        console.log("Current allowance:");
        console.log("- Owner (Safe):", safeAddress);
        console.log("- Spender:", CONFIG.spenderAddress);
        console.log("- Allowance:", ethers.formatUnits(allowance, 6), "USDC");
        console.log();

        if (allowance >= CONFIG.approvalAmount) {
            console.log("✅ Approval successful!");
        } else {
            console.log("⚠️  Allowance is less than expected");
        }

        console.log();
        console.log("🎉 Operation completed successfully!");
        console.log();
        console.log("📊 Summary:");
        console.log("- The operator successfully executed a USDC approval");
        console.log("- The call went through the Roles Modifier");
        console.log("- Permissions were validated automatically");
        console.log("- The Safe now has an allowance set for the spender");
    } catch (error: any) {
        console.error("\n❌ Transaction failed:");

        if (error.message.includes("NotAuthorized")) {
            console.error("The operator is not authorized to call this function.");
            console.error("Please ensure:");
            console.error("1. The operator has been assigned a role");
            console.error("2. The role has permission to call USDC.approve()");
            console.error("3. Run: yarn configure:roles to set up permissions");
        } else if (error.message.includes("execution reverted")) {
            console.error("Transaction was reverted. Possible reasons:");
            console.error("1. Operator doesn't have permission for this function");
            console.error("2. Function parameters don't match configured conditions");
            console.error("3. Roles Modifier is not enabled as a module on the Safe");
        } else {
            console.error(error.message);
        }

        throw error;
    }
}

// ============================================
// Alternative: Execute Multiple Calls in Batch
// ============================================

async function executeBatchExample() {
    console.log("\n" + "=".repeat(70));
    console.log("  Batch Execution Example");
    console.log("=".repeat(70));
    console.log();

    if (!process.env.TESTING_SAFE_OPERATOR_KEY) {
        throw new Error("❌ SAFE_OPERATOR_KEY not set in .env file");
    }

    const operatorSigner = new ethers.Wallet(process.env.TESTING_SAFE_OPERATOR_KEY, ethers.provider);

    const rolesContract = new ethers.Contract(CONFIG.rolesModAddress, rolesAbi, operatorSigner);

    const usdcInterface = new ethers.Interface(["function approve(address spender, uint256 amount) returns (bool)"]);

    // Example: Approve multiple spenders
    const spenders = [
        "0x274C3795dadfEbf562932992bF241ae087e0a98C", // Morpho
        "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", // Aave V3 Pool
    ];

    console.log("Executing multiple approvals...\n");

    for (let i = 0; i < spenders.length; i++) {
        const spender = spenders[i];
        const amount = ethers.parseUnits("100", 6);

        console.log(`Approval ${i + 1}/${spenders.length}:`);
        console.log("- Spender:", spender);
        console.log("- Amount:", ethers.formatUnits(amount, 6), "USDC");

        const callData = usdcInterface.encodeFunctionData("approve", [spender, amount]);

        const tx = await rolesContract.execTransactionFromModule(CONFIG.usdcAddress, 0, callData, 0);

        console.log("- TX Hash:", tx.hash);
        await tx.wait();
        console.log("✅ Confirmed\n");
    }

    console.log("🎉 All approvals completed!");
}

// ============================================
// Execute
// ============================================

if (require.main === module) {
    // To run the batch example instead, uncomment the line below
    // executeBatchExample()

    main()
        .then(() => process.exit(0))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}

export { main as executeRolesExample, executeBatchExample };
