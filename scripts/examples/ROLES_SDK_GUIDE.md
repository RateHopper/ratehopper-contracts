# Zodiac Roles SDK - Quick Reference Guide

This guide shows how to configure permissions using the Zodiac Roles SDK.

## Prerequisites

1. **Deploy Roles Proxy**:
   ```bash
   yarn deploy:zodiac-roles-proxy
   ```

2. **Enable Module in Safe**:
   - Go to Safe UI → Settings → Modules
   - Add the deployed Roles proxy address

3. **Set Environment Variables** in `.env`:
   ```bash
   ROLES_PROXY_ADDRESS=0xYourRolesProxyAddress
   SAFE_WALLET_ADDRESS=0xYourSafeAddress
   SAFE_DEBT_MANAGER_ADDRESS=0xYourSafeDebtManagerAddress
   OPERATOR_ADDRESS=0xYourOperatorAddress
   ```

## Quick Start

### Configure Permissions

Run the example configuration script:

```bash
yarn configure:roles
```

This will:
1. ✅ Define permissions for SafeDebtManager functions
2. ✅ Assign roles to your operator address
3. ✅ Set default role for the operator
4. ✅ Verify the configuration

## Understanding the SDK

### Key Concepts

1. **Roles**: Identities that can execute specific functions
   ```typescript
   const ROLE_ID = ethers.keccak256(ethers.toUtf8Bytes("MY_ROLE"));
   ```

2. **Permissions**: What each role can do
   - **Target Scoping**: Which contracts can be called
   - **Function Scoping**: Which functions can be called
   - **Parameter Scoping**: What parameters are allowed

3. **Members**: Who has which roles
   ```typescript
   await roles.assignRoles(address, [roleIds], [true]);
   ```

### Permission Levels

```
┌─────────────────────────────────────────┐
│  Level 1: Target Scoping                │
│  → Allow calling specific contract      │
│                                          │
│  Level 2: Function Scoping              │
│  → Allow calling specific function      │
│                                          │
│  Level 3: Parameter Scoping             │
│  → Allow only certain parameter values  │
└─────────────────────────────────────────┘
```

## Code Examples

### Example 1: Define Simple Permission

Allow a role to call any function on a contract:

```typescript
import { ethers } from "hardhat";

const ROLE_ID = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR"));
const roles = new ethers.Contract(rolesAddress, ROLES_ABI, signer);

// Step 1: Scope the target contract
await roles.scopeTarget(ROLE_ID, targetContractAddress);

// Step 2: Allow specific function
const functionSig = ethers.id("executeDebtSwap(...)").substring(0, 10);
await roles.scopeAllowFunction(
    ROLE_ID,
    targetContractAddress,
    functionSig,
    0 // ExecutionOptions.None
);
```

### Example 2: Assign Role to Address

```typescript
const roles = new ethers.Contract(rolesAddress, ROLES_ABI, signer);

// Assign role to module
await roles.assignRoles(
    moduleAddress,
    [ROLE_ID],
    [true] // true = assign, false = revoke
);

// Set default role (optional)
await roles.setDefaultRole(moduleAddress, ROLE_ID);
```

### Example 3: Execute with Role

Once configured, the operator can execute:

```typescript
const roles = new ethers.Contract(rolesAddress, ROLES_ABI, operatorSigner);

// Prepare call data
const callData = targetContract.interface.encodeFunctionData("functionName", [
    param1,
    param2,
]);

// Execute through Roles Modifier
await roles.execTransactionFromModule(
    targetContractAddress,
    0, // value in ETH
    callData,
    0 // Operation.Call
);
```

### Example 4: Advanced - Parameter Conditions

Allow function only with specific parameter values:

```typescript
// Only allow transfers to whitelisted addresses
const functionSig = ethers.id("transfer(address,uint256)").substring(0, 10);

await roles.scopeFunction(
    ROLE_ID,
    tokenAddress,
    functionSig,
    [true, false], // isScoped: [param0=true, param1=false]
    [1, 0], // paramType: [Static, None]
    [0, 0], // paramComp: [EqualTo, Pass]
    [ethers.AbiCoder.defaultAbiCoder().encode(["address"], [whitelistedAddress]), "0x"],
    0 // ExecutionOptions
);
```

## Complete Workflow

### 1. Deploy Roles Proxy

```bash
# Set your Safe address
export SAFE_WALLET_ADDRESS=0xYourSafeAddress

# Deploy proxy
yarn deploy:zodiac-roles-proxy

# Note the deployed proxy address
export ROLES_PROXY_ADDRESS=0xDeployedProxyAddress
```

### 2. Enable Module in Safe

Via Safe UI:
1. Go to `https://app.safe.global/home?safe=base:{SAFE_ADDRESS}`
2. Settings → Modules → Add Module
3. Enter `ROLES_PROXY_ADDRESS`

Or via transaction builder:
```solidity
enableModule(0xRolesProxyAddress)
```

### 3. Configure Permissions

```bash
# Update .env with all addresses
export SAFE_DEBT_MANAGER_ADDRESS=0xYourSafeDebtManager
export OPERATOR_ADDRESS=0xYourOperator

# Run configuration
yarn configure:roles
```

### 4. Verify Setup

```typescript
const roles = new ethers.Contract(rolesAddress, ROLES_ABI, provider);

// Check default role
const defaultRole = await roles.defaultRoles(operatorAddress);
console.log("Default role:", defaultRole);

// Check owner
const owner = await roles.owner();
console.log("Owner:", owner);
```

### 5. Use from Operator

```typescript
// Operator can now call allowed functions
const roles = new ethers.Contract(rolesAddress, ROLES_ABI, operatorSigner);

const callData = safeDebtManager.interface.encodeFunctionData(
    "executeDebtSwap",
    [/* params */]
);

await roles.execTransactionFromModule(
    safeDebtManagerAddress,
    0,
    callData,
    0
);
```

## Common Operations

### Add New Permission

```typescript
// 1. Scope new function
const newFunctionSig = ethers.id("newFunction(...)").substring(0, 10);
await roles.scopeAllowFunction(ROLE_ID, contractAddress, newFunctionSig, 0);
```

### Revoke Permission

```typescript
// Remove function permission
await roles.scopeRevokeFunction(ROLE_ID, contractAddress, functionSig);
```

### Add New Role Member

```typescript
// Assign existing role to new address
await roles.assignRoles(newMemberAddress, [ROLE_ID], [true]);
```

### Remove Role Member

```typescript
// Revoke role from address
await roles.assignRoles(memberAddress, [ROLE_ID], [false]);
```

## Execution Options

When scoping functions, you can specify execution options:

```typescript
enum ExecutionOptions {
    None = 0,           // Default - both send and delegatecall disabled
    Send = 1,           // Allow sending ETH
    DelegateCall = 2,   // Allow delegatecall (dangerous!)
    Both = 3            // Allow both
}
```

Example:
```typescript
// Allow function to send ETH
await roles.scopeAllowFunction(
    ROLE_ID,
    contractAddress,
    functionSig,
    ExecutionOptions.Send
);
```

## Troubleshooting

### "Module not enabled"
- Ensure Roles proxy is enabled in Safe → Settings → Modules

### "No membership"
- Check role is assigned: `roles.defaultRoles(address)`
- Verify role permissions are set up

### "Function not allowed"
- Verify function signature matches exactly
- Check target is scoped: `roles.scopeTarget()`

### "Parameter not allowed"
- Check parameter scoping conditions
- Verify parameter values match conditions

## Resources

- [Official Docs](https://docs.roles.gnosisguild.org/)
- [SDK on NPM](https://www.npmjs.com/package/zodiac-roles-sdk)
- [GitHub](https://github.com/gnosisguild/zodiac-modifier-roles)
- [Zodiac Wiki](https://www.zodiac.wiki/documentation/roles-modifier)

## Security Best Practices

1. ✅ Start with minimal permissions
2. ✅ Use parameter scoping for sensitive functions
3. ✅ Regularly audit role assignments
4. ✅ Test permissions on testnet first
5. ✅ Never use DelegateCall unless absolutely necessary
6. ✅ Keep role membership updated
7. ✅ Document all role configurations

## Next Steps

1. Review the example scripts in `scripts/examples/`
2. Customize for your specific use case
3. Test on Base Sepolia testnet
4. Deploy and configure on mainnet
5. Monitor role usage and adjust permissions as needed
