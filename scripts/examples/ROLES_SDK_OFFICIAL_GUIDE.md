# Zodiac Roles SDK - Official Pattern Guide

This guide shows the **recommended approach** using the official Zodiac Roles SDK with `allow()` and `processPermissions()`.

## Overview

The official SDK pattern uses:
1. **eth-sdk**: Define contract addresses and generate types
2. **allow()**: Type-safe permission definitions
3. **processPermissions()**: Convert permissions to target calls
4. **applyTargets()**: Apply to the Roles contract

This is **cleaner, type-safe, and recommended** compared to manual contract calls.

## Setup

### Step 1: Generate Contract Types

```bash
# Generate type-safe contract interfaces
yarn eth-sdk
```

This reads `eth-sdk/config.ts` and generates TypeScript types for your contracts.

### Step 2: Update Contract Addresses

Edit `eth-sdk/config.ts` with your deployed contract addresses:

```typescript
import { defineConfig } from "@gnosis-guild/eth-sdk";

export default defineConfig({
    contracts: {
        base: {
            usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            safeDebtManager: "0xYourSafeDebtManagerAddress",
            leveragedPosition: "0xYourLeveragedPositionAddress",
        },
    },
    outputPath: "./eth-sdk",
});
```

### Step 3: Set Environment Variables

```bash
ROLES_PROXY_ADDRESS=0xYourRolesProxyAddress
SAFE_DEBT_MANAGER_ADDRESS=0xYourSafeDebtManagerAddress
OPERATOR_ADDRESS=0xYourOperatorAddress
```

## Quick Start

### Full Configuration

```bash
# 1. Generate contract types
yarn eth-sdk

# 2. Configure permissions
yarn configure:roles
```

That's it! The script will:
- ✅ Define permissions using `allow()`
- ✅ Process into target calls
- ✅ Apply to Roles contract
- ✅ Assign roles to operator
- ✅ Verify configuration

## Code Walkthrough

### 1. Define Permissions

```typescript
import { allow } from "zodiac-roles-sdk/kit";

// Type-safe permission definitions
const permissions = [
    // Allow USDC transfers
    allow.base.usdc.transfer(),

    // Allow USDC approvals
    allow.base.usdc.approve(),

    // Allow SafeDebtManager operations
    allow.base.safeDebtManager.executeDebtSwap(),
    allow.base.safeDebtManager.exit(),
];
```

**Benefits**:
- ✅ Type-safe (autocomplete works!)
- ✅ No manual function signatures
- ✅ Clean and readable
- ✅ Validates contract addresses

### 2. Process Permissions

```typescript
import { processPermissions } from "zodiac-roles-sdk";

// Convert permissions to target configuration
const { targets } = processPermissions(permissions);
```

This generates the low-level target calls needed for the Roles contract.

### 3. Apply to Role

```typescript
import { applyTargets } from "zodiac-roles-sdk";

const ROLE_KEY = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR"));

// Generate transaction calls
const calls = applyTargets(ROLE_KEY, targets, {
    chainId: 8453, // Base mainnet
    address: rolesModAddress,
    mode: "replace", // or "extend"
});

// Execute the calls
for (const call of calls) {
    const tx = await signer.sendTransaction({
        to: call.to,
        value: call.value || 0,
        data: call.data,
    });
    await tx.wait();
}
```

**Mode Options**:
- `"replace"`: Remove existing permissions and apply new ones
- `"extend"`: Add to existing permissions

### 4. Assign Role to Address

```typescript
const rolesContract = new ethers.Contract(rolesModAddress, ROLES_ABI, signer);

// Assign role
await rolesContract.assignRoles(
    operatorAddress,
    [ROLE_KEY],
    [true]
);

// Set default role
await rolesContract.setDefaultRole(operatorAddress, ROLE_KEY);
```

## Advanced: Parameter Conditions

You can add conditions on function parameters:

```typescript
import { allow } from "zodiac-roles-sdk/kit";
import { c } from "zodiac-roles-sdk";

// Only allow transfers to specific address
const permissions = [
    allow.base.usdc.transfer(
        c.avatar, // recipient must be the Safe
        undefined // amount can be anything
    ),

    // Only allow approvals for specific protocols
    allow.base.usdc.approve(
        "0xProtocolAddress", // spender must be this address
        c.lte(ethers.parseUnits("1000", 6)) // amount <= 1000 USDC
    ),
];
```

**Common Conditions**:
```typescript
c.avatar         // Must equal Safe address
c.eq(value)      // Must equal value
c.lte(value)     // Must be less than or equal
c.gte(value)     // Must be greater than or equal
c.oneOf([a, b])  // Must be one of these values
```

## Complete Workflow Example

```typescript
import { ethers } from "hardhat";
import { allow } from "zodiac-roles-sdk/kit";
import { processPermissions, applyTargets } from "zodiac-roles-sdk";

async function configureRoles() {
    const [signer] = await ethers.getSigners();

    // 1. Define permissions
    const permissions = [
        allow.base.safeDebtManager.executeDebtSwap(),
        allow.base.safeDebtManager.exit(),
    ];

    // 2. Process permissions
    const { targets } = processPermissions(permissions);

    // 3. Apply to role
    const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR"));
    const calls = applyTargets(OPERATOR_ROLE, targets, {
        chainId: 8453,
        address: rolesModAddress,
        mode: "replace",
    });

    // 4. Execute calls
    for (const call of calls) {
        const tx = await signer.sendTransaction(call);
        await tx.wait();
    }

    // 5. Assign role
    const roles = new ethers.Contract(rolesModAddress, ROLES_ABI, signer);
    await roles.assignRoles(operatorAddress, [OPERATOR_ROLE], [true]);
    await roles.setDefaultRole(operatorAddress, OPERATOR_ROLE);

    console.log("✅ Configuration complete!");
}
```

## Comparison: SDK vs Manual

| Aspect | SDK Approach | Manual Approach |
|--------|--------------|-----------------|
| Type Safety | ✅ Full autocomplete | ❌ Manual signatures |
| Readability | ✅ Clean & declarative | ❌ Verbose |
| Maintenance | ✅ Easy to update | ❌ Error-prone |
| Validation | ✅ Compile-time | ❌ Runtime errors |
| Best For | Production | Understanding internals |

**Recommendation**: Use SDK approach for production!

## Directory Structure

```
├── eth-sdk/
│   ├── config.ts              # Contract definitions
│   └── sdk.ts                 # Generated types (auto)
├── scripts/
│   └── examples/
│       ├── rolesSDKProperExample.ts    # SDK approach ✅
│       └── rolesSDKExample.ts          # Manual approach
```

## Troubleshooting

### "Module not found: zodiac-roles-sdk/kit"

The SDK package is already installed. Make sure you're importing correctly:

```typescript
import { allow } from "zodiac-roles-sdk/kit";
```

### "Contract not found in allow.base"

Run `yarn eth-sdk` first to generate the types:

```bash
yarn eth-sdk
```

### "Cannot read property of undefined"

Check that contract addresses in `eth-sdk/config.ts` are set correctly.

### Type errors with allow()

Ensure your eth-sdk types are up to date:

```bash
yarn eth-sdk --clean
yarn eth-sdk
```

## Best Practices

1. ✅ **Always use eth-sdk** for type generation
2. ✅ **Use `allow()`** instead of manual function signatures
3. ✅ **Add parameter conditions** for sensitive functions
4. ✅ **Test on testnet first** before mainnet
5. ✅ **Use "replace" mode** for full permission resets
6. ✅ **Use "extend" mode** to add new permissions
7. ✅ **Version control** your eth-sdk/config.ts

## Common Patterns

### Pattern 1: Token Allowances

```typescript
// Allow approvals only for specific protocols
const permissions = [
    allow.base.usdc.approve(AAVE_POOL_ADDRESS),
    allow.base.usdc.approve(MORPHO_ADDRESS),
];
```

### Pattern 2: Multi-Contract Operations

```typescript
// Allow operations across multiple contracts
const permissions = [
    allow.base.usdc.approve(),
    allow.base.safeDebtManager.executeDebtSwap(),
    allow.base.leveragedPosition.createLeveragedPosition(),
];
```

### Pattern 3: Conditional Permissions

```typescript
import { c } from "zodiac-roles-sdk";

// Only allow small transfers
const permissions = [
    allow.base.usdc.transfer(
        undefined, // any recipient
        c.lte(ethers.parseUnits("1000", 6)) // max 1000 USDC
    ),
];
```

## Resources

- [Official SDK Docs](https://docs.roles.gnosisguild.org/sdk/getting-started)
- [SDK on GitHub](https://github.com/gnosisguild/zodiac-modifier-roles)
- [eth-sdk](https://github.com/dethcrypto/eth-sdk)
- [Example Repo](https://github.com/gnosisguild/permissions-starter-kit)

## Next Steps

1. ✅ Run `yarn eth-sdk` to generate types
2. ✅ Update `eth-sdk/config.ts` with your contracts
3. ✅ Run `yarn configure:roles` to set up permissions
4. ✅ Test with your operator address
5. ✅ Monitor and adjust permissions as needed

---

**Remember**: The SDK approach is cleaner, safer, and recommended for production use! 🚀
