# Zodiac Roles Modifier Deployment Guide

This guide explains how to deploy the Zodiac Roles Modifier using the canonical ModuleProxyFactory pattern.

## Overview

The deployment uses:

- **ModuleProxyFactory**: `0x000000000000aDdB49795b0f9bA5BC298cDda236` (Base Mainnet)
- **Roles Mastercopy**: `0x9646fDAD06d3e24444381f44362a3B0eB343D337` (Base Mainnet)

This creates a minimal proxy pointing to the official Roles implementation, saving gas and using battle-tested code.

## Prerequisites

1. **Set Environment Variables** in `.env`:

    ```bash
    SAFE_WALLET_ADDRESS=0xYourSafeAddressHere
    ADMIN_ADDRESS=0xYourAdminAddress  # Optional, defaults to deployer
    DEPLOYER_PRIVATE_KEY=your_private_key
    ```

2. **Fund Deployer Account**:
    - Ensure your deployer has enough ETH on Base for gas fees
    - Typical cost: ~0.001-0.002 ETH

## Deployment

### Option 1: Using Canonical Proxy (Recommended) ✅

Deploy a proxy using the official ModuleProxyFactory:

```bash
yarn deploy:zodiac-roles-proxy
```

**Benefits**:

- ✅ Uses canonical, audited Roles implementation
- ✅ Minimal gas cost (proxy deployment)
- ✅ Automatic updates when mastercopy is upgraded
- ✅ Standard Zodiac deployment pattern
- ✅ No need to verify contract (proxy pattern)

### Option 2: Direct Deployment

Deploy your own Roles implementation:

```bash
yarn deploy:zodiac-roles
```

**Use this when**:

- You need to customize the Roles contract
- You want full control over the implementation
- You need to verify the contract source code

## After Deployment

### 1. Enable Module in Safe

**Via Safe UI**:

1. Go to: `https://app.safe.global/home?safe=base:{YOUR_SAFE_ADDRESS}`
2. Navigate to: Settings → Modules → Add Module
3. Enter the deployed proxy address
4. Confirm the transaction

**Via Transaction Builder**:

1. Call `enableModule(proxyAddress)` on your Safe
2. Sign with required number of owners

### 2. Configure Roles & Permissions

**Option A: Use Zodiac App**:

```
https://zodiac.gnosisguild.org/
```

**Option B: Use Roles SDK**:

```typescript
import { KitContract, applyAnnotations } from "zodiac-roles-sdk";

// Connect to your deployed proxy
const roles = await KitContract.attach({
    address: "YOUR_PROXY_ADDRESS",
    provider: ethers.provider,
});

// Define permissions
const annotations = applyAnnotations(roles, (contracts) => {
    contracts.yourContract.allow.yourFunction();
});
```

**Option C: Direct Contract Calls**:

```typescript
// Assign role to address
await rolesProxy.assignRoles(moduleAddress, [roleKey], [true]);

// Set default role
await rolesProxy.setDefaultRole(moduleAddress, roleKey);
```

### 3. Verify Deployment

Check on BaseScan:

```
https://basescan.org/address/{PROXY_ADDRESS}
```

Verify initialization:

```bash
npx hardhat console --network base
```

```javascript
const proxy = await ethers.getContractAt("Roles", "PROXY_ADDRESS");
console.log("Owner:", await proxy.owner());
console.log("Avatar:", await proxy.avatar());
console.log("Target:", await proxy.target());
```

## Architecture

```
┌─────────────────┐
│  Your Safe      │
│  (Avatar)       │
└────────┬────────┘
         │ enables
         ▼
┌─────────────────┐
│  Roles Proxy    │ ◄── Your deployment
│  (Per Safe)     │
└────────┬────────┘
         │ delegates to
         ▼
┌─────────────────┐
│ Roles Mastercopy│ ◄── Canonical implementation
│   (Shared)      │     0x9646fDAD06d3e24444381f44362a3B0eB343D337
└─────────────────┘
```

## Comparison: Proxy vs Direct Deployment

| Feature        | Proxy Deployment     | Direct Deployment    |
| -------------- | -------------------- | -------------------- |
| Gas Cost       | ~$0.50-1             | ~$5-10               |
| Implementation | Canonical, audited   | Your own copy        |
| Upgradability  | Points to mastercopy | Immutable            |
| Verification   | Not needed (proxy)   | Required             |
| Best For       | Production use       | Custom modifications |

## Troubleshooting

### "Please set SAFE_WALLET_ADDRESS"

- Update `.env` with your Safe address
- Make sure the address is valid and on Base

### "Transaction reverted"

- Check deployer has enough ETH
- Verify SAFE_WALLET_ADDRESS is valid
- Ensure you're on Base mainnet (chain ID: 8453)

### "Module already enabled"

- The module is already added to your Safe
- Check Safe → Settings → Modules

## Resources

- [Zodiac Roles Docs](https://docs.roles.gnosisguild.org/)
- [Zodiac Wiki](https://www.zodiac.wiki/documentation/roles-modifier)
- [Roles SDK](https://www.npmjs.com/package/zodiac-roles-sdk)
- [Base Safe App](https://app.safe.global)

## Support

- GitHub Issues: https://github.com/gnosisguild/zodiac-modifier-roles/issues
- Gnosis Guild Discord: https://discord.gg/gnosisguild
