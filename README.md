# RateHopper Contracts

RateHopper Contracts is a smart contract system that enables users to automatically switch their borrowing positions between different DeFi lending protocols to take advantage of the best borrowing rates. This helps users optimize their borrowing costs by seamlessly moving their debt between protocols when better rates are available.

## Deployed Contract

**Base Network**: [0xbe986c4e4c716f37c424e9ff8c7e544ba9ce119e](https://basescan.org/address/0xbe986c4e4c716f37c424e9ff8c7e544ba9ce119e)

## Key Features

- **Multi-Protocol Support**: Currently supports borrowing from:

    - Aave V3
    - Compound
    - Morpho
    - Moonwell
    - Fluid

- **Flash Loan Integration**: Uses Uniswap V3 flash loans to facilitate debt position transfers without requiring users to have the full repayment amount upfront.

- **Collateral Management**: Handles multiple collateral assets across different protocols during debt transfers.

- **Paraswap Integration**: Uses Paraswap for efficient token swaps when debt assets differ between protocols.

- **Protocol Fee**: Configurable protocol fee system with a designated fee beneficiary.

- **Safe Module Integration**: Supports Gnosis Safe integration through dedicated Safe modules.

- **Leveraged Positions**: Enables creation of leveraged positions across supported protocols.

## Architecture

The system consists of several key components:

1. **DebtSwap.sol**: The main contract that orchestrates the debt switching process using flash loans.

2. **Protocol Handlers**: Individual handlers for each supported lending protocol:

    - In `contracts/protocols/` directory:
        - `AaveV3Handler.sol`: Handles interactions with Aave V3 protocol
        - `CompoundHandler.sol`: Handles interactions with Compound protocol
        - `MorphoHandler.sol`: Handles interactions with Morpho protocol

    - In `contracts/protocolsSafe/` directory:
        - `MoonwellHandler.sol`: Handles interactions with Moonwell protocol
        - `FluidSafeHandler.sol`: Handles interactions with Fluid protocol through Safe

3. **Safe Modules**: Modules for Gnosis Safe integration:

    - `SafeModuleDebtSwap.sol`: Enables debt swaps through Gnosis Safe

4. **LeveragedPosition.sol**: Facilitates creation of leveraged positions across protocols.

5. **ProtocolRegistry.sol**: Stores mappings between tokens and their corresponding protocol-specific contracts, allowing protocol handlers to access these mappings even when called via delegatecall.

6. **Morpho Libraries**: Supporting libraries for the Morpho protocol:

    - `MathLib.sol`: Provides fixed-point arithmetic operations for the Morpho protocol
    - `SharesMathLib.sol`: Handles share-to-asset conversion with virtual shares to protect against share price manipulations

## Sample Usage

Below are examples of how to integrate with the RateHopper contracts for different protocols.

### Common Integration Pattern

```javascript
// 1. Initialize protocol helpers
const aaveV3Helper = new AaveV3Helper(signer);
const compoundHelper = new CompoundHelper(signer);
const morphoHelper = new MorphoHelper(signer);
const moonwellHelper = new MoonwellHelper(signer);

// 2. Set up a borrowing position in the source protocol
// Example: Supply collateral and borrow from Aave V3
await aaveV3Helper.supply(collateralTokenAddress);
await aaveV3Helper.borrow(debtTokenAddress);

// 3. Execute the debt swap
await debtSwapContract.executeDebtSwap(
    flashloanPool, // Uniswap V3 pool address for flash loan
    fromProtocol, // Source protocol enum
    toProtocol, // Destination protocol enum
    fromDebtAsset, // Debt asset address on source protocol
    toDebtAsset, // Debt asset address on destination protocol
    amount, // Amount to swap (MaxUint256 for full debt)
    collateralAssets, // Array of collateral assets
    fromExtraData, // Protocol-specific data for source
    toExtraData, // Protocol-specific data for destination
    paraswapParams // Parameters for token swaps if needed
);
```

### Protocol-Specific Integration Notes

#### Aave V3

```javascript
// 1.1 Get and approve aToken for the collateral When switching from Aave
const aTokenAddress = await aaveV3Helper.getATokenAddress(collateralTokenAddress);
await approve(aTokenAddress, debtSwapContractAddress, signer);

// 1.2 Approve delegation for variable debt tokens when switching to Aave
await aaveV3Helper.approveDelegation(debtTokenAddress, debtSwapContractAddress);

// 2. No extra data needed for Aave V3
const aaveExtraData = "0x";
```

#### Compound V3

```javascript
// When using Compound V3
// 1. Allow the DebtSwap contract to manage positions
await compoundHelper.allow(tokenAddress, debtSwapContractAddress);

// 2. No extra data needed for Compound
const compoundExtraData = "0x";
```

#### Morpho

```javascript
// When using Morpho
// 1. Set authorization for the DebtSwap contract
const morphoContract = new ethers.Contract(MORPHO_ADDRESS, morphoAbi, signer);
await morphoContract.setAuthorization(debtSwapContractAddress, true);

// 2. Get borrow shares for the market
const borrowShares = await morphoHelper.getBorrowShares(marketId);

// 3. Encode market parameters and borrow shares as extra data (REQUIRED)
const morphoExtraData = morphoHelper.encodeExtraData(marketId, borrowShares);
// This encodes: abi.encode(MarketParams, uint256)
// The MarketParams structure contains loan token, collateral token, oracle, etc.
// The borrowShares is required for repaying debt when Morpho is the source protocol
// Note: The contract now uses SharesMathLib for accurate conversion between shares and assets
```

#### Moonwell

```javascript
// When using Moonwell, No pre-approval is required
// 1. No extra data needed for Moonwell
const moonwellExtraData = "0x";
```

#### Fluid

```javascript
// When using Fluid, No pre-approval is require
// 1. Get the vault address for the token
const vaultAddress = fluidVaultMap.get(tokenAddress);

// 2. Get NFT ID for the position
const nftId = await fluidHelper.getNftId(vaultAddress, userAddress);

// 3. Encode market parameters and borrow shares as extra data (REQUIRED)
const fluidExtraData = fluidHelper.encodeExtraData(vaultAddress, nftId);
```

### Multiple Collaterals Example

```javascript
// When using multiple collateral assets
const collateralArray = [
    { asset: collateralToken1Address, amount: collateralAmount1 },
    { asset: collateralToken2Address, amount: collateralAmount2 },
];

// Pass the collateral array to executeDebtSwap
await debtSwapContract.executeDebtSwap(
    // ... other parameters
    collateralArray,
    // ... remaining parameters
);
```

### Cross-Protocol Debt Swap Example

```javascript
// Example: Switch debt from Aave V3 to Compound
// 1. Set up position in Aave
await aaveV3Helper.supply(collateralTokenAddress);
await aaveV3Helper.borrow(debtTokenAddress);

// 2. Prepare for the swap
// Approve aToken transfer
const aTokenAddress = await aaveV3Helper.getATokenAddress(collateralTokenAddress);
await approve(aTokenAddress, debtSwapContractAddress, signer);

// Allow Compound management
await compoundHelper.allow(toDebtTokenAddress, debtSwapContractAddress);

// Prepare extra data
const fromExtraData = "0x"; // No extra data for Aave
const toExtraData = "0x"; // No extra data for Compound

// 3. Execute the swap
await debtSwapContract.executeDebtSwap(
    flashloanPool,
    Protocols.AAVE_V3,
    Protocols.COMPOUND,
    fromDebtTokenAddress,
    toDebtTokenAddress,
    MaxUint256, // Swap full debt
    [{ asset: collateralTokenAddress, amount: collateralAmount }],
    fromExtraData,
    toExtraData,
    paraswapParams
);
```

### Important Implementation Notes

1. **Flash Loan Process**: The contract uses Uniswap V3 flash loans to temporarily borrow the debt asset, repay the source protocol, and then borrow from the destination protocol.

2. **Protocol Fee**: The contract charges an optional protocol fee (configurable by the owner) which is taken from the destination debt amount.

3. **Slippage Protection**: When swapping between different assets, you must include a `srcAmount` field in the `ParaswapParams` struct with appropriate slippage adjustment to ensure the transaction doesn't fail due to price movements. See the 'Understanding Amount Parameters' section below for details.

4. **Collateral Handling**: The contract will automatically withdraw collateral from the source protocol and supply it to the destination protocol during the debt swap.

5. **Error Handling**: The contract includes checks to ensure that operations like repaying debt and borrowing succeed, reverting the transaction if any step fails.

### Understanding Amount Parameters

```javascript
await debtSwapContract.executeDebtSwap(
    // ... other parameters
    amount, // Amount to swap from source protocol
    // ... remaining parameters
);
```

#### Amount Parameter

The `amount` parameter specifies how much debt to repay in the source protocol:

- If set to a specific value (e.g., `ethers.parseUnits("100", 6)`), the contract will repay exactly that amount of debt
- If set to `MaxUint256` (or `ethers.constants.MaxUint256`), the contract will repay the entire debt position

```javascript
// Example: Repay specific amount
const amountToRepay = ethers.parseUnits("100", 6); // Repay 100 USDC

// Example: Repay entire debt
const amountToRepay = ethers.constants.MaxUint256;
```

#### Paraswap Parameters

The `paraswapParams` object is used when swapping between different assets and contains:

- `srcAmount`: The amount to swap with slippage adjustment (set to 0 if not swapping assets)
- `swapData`: The encoded swap data from the Paraswap API

```javascript
// Example: Creating Paraswap Parameters for token swap
const debtAmount = ethers.parseUnits("100", 6); // 100 USDC
const slippage = 0.01; // 1% slippage tolerance

// Calculate amount with slippage adjustment
const slippageAdjustedAmount = debtAmount * (1 + slippage);

// Get the swap data from Paraswap API
const [srcAmount, paraswapData] = await getParaswapData(
    fromTokenAddress,
    toTokenAddress,
    debtSwapContractAddress,
    debtAmount,
    slippageAdjustedAmount
);

// Create the paraswap parameters object
const paraswapParams = {
    srcAmount: srcAmount,
    swapData: paraswapData
};
```

#### Sample Usage with Paraswap

```javascript
// Get the expected swap amount from Paraswap
const [srcAmount, paraswapData] = await getParaswapData(
    fromTokenAddress,
    toTokenAddress,
    debtSwapContractAddress,
    debtAmount,
    slippageAdjustedAmount
);

// Execute the debt swap with slippage protection
await debtSwapContract.executeDebtSwap(
    flashloanPool,
    fromProtocol,
    toProtocol,
    fromDebtAsset,
    toDebtAsset,
    amount,
    collateralAssets,
    fromExtraData,
    toExtraData,
    {
        srcAmount,
        swapData
    }
);
```

## Key Functions

### DebtSwap Contract

- `executeDebtSwap`: Main entry point for initiating a debt position transfer
- `uniswapV3FlashCallback`: Handles the flash loan callback from Uniswap V3
- `setProtocolFee`: Sets the protocol fee percentage (basis points)
- `setFeeBeneficiary`: Sets the address that receives protocol fees
- `getHandler`: Retrieves the handler address for a specific protocol
- `emergencyWithdraw`: Allows the owner to withdraw tokens in case of emergency

### Protocol Handlers

Each protocol handler implements the following key functions:

- `getDebtAmount`: Retrieves current debt amount for a user
- `switchIn`: Handles debt switching within the same protocol
- `switchFrom`: Handles debt repayment on the original protocol
- `switchTo`: Handles borrowing on the new protocol
- `repay`: Handles repayment of remaining balances

## Integration Guide

### Debt Swap Parameters

To execute a debt swap, you'll need to provide the following parameters:

```solidity
function executeDebtSwap(
    address _flashloanPool,       // Uniswap V3 pool address for flash loan
    Protocol _fromProtocol,       // Source protocol enum (COMPOUND, AAVE_V3, MORPHO, FLUID, MOONWELL)
    Protocol _toProtocol,         // Destination protocol enum
    address _fromDebtAsset,       // Debt asset address on source protocol
    address _toDebtAsset,         // Debt asset address on destination protocol
    uint256 _amount,              // Amount to swap (use type(uint256).max for full debt)
    CollateralAsset[] calldata _collateralAssets,  // Array of collateral assets
    bytes calldata _fromExtraData,  // Extra data for source protocol
    bytes calldata _toExtraData,    // Extra data for destination protocol
    ParaswapParams calldata _paraswapParams  // Paraswap parameters for token swaps
)
```

### Collateral Asset Structure

```solidity
struct CollateralAsset {
    address asset;   // Collateral asset address
    uint256 amount;  // Collateral amount
}
```

### Paraswap Parameters

```solidity
struct ParaswapParams {
    uint256 srcAmount;    // Source amount with slippage adjustment (for token swaps)
    bytes swapData;      // Encoded swap data from Paraswap API
}
```

## Setup and Development

1. Install dependencies:

```bash
yarn install
```

2. Compile contracts:

```bash
yarn run compile
```

3. Run tests:

```bash
yarn test
```

The project uses:

- Solidity version 0.8.28
- Hardhat for development and testing
- OpenZeppelin contracts for standard implementations
- Uniswap V3 for flash loans
- Paraswap for token swaps

## Testing

Comprehensive tests are available in the `/test` directory covering:

- Individual protocol handlers
- Cross-protocol debt switching flows
- Multiple collateral asset scenarios
- Safe module integration
- Leveraged position creation

Run tests with:

```bash
yarn test
```

## Deployment

Make sure you complete the sections Environment Variables and Setup and Development and make sure all tests pass before deploying.

### Hardhat Ignition

We use [Hardhat Ignition](https://hardhat.org/ignition) as our deployment framework. All deployment logic lives in a single Ignition module at `ignition/modules/DeployAll.ts`.

**Why Ignition over `hardhat run` scripts:**

- **Automatic verification** — pass `--verify` to verify all contracts on the block explorer during deployment
- **State tracking** — deployment state is persisted in `ignition/deployments/`. If a deployment fails midway, re-running the same command resumes from where it left off
- **Resumability** — Ignition analyzes the dependency graph and can resume from any point if a deployment is interrupted
- **Declarative** — contracts and their configuration calls are defined as a dependency graph, not imperative sequential code
- **Reset support** — pass `--reset` to clear previous state and redeploy from scratch

### Contract Dependency Graph

The module deploys 9 contracts and runs 8 post-deployment configuration transactions. The dependency order is:

```
ProtocolRegistry (constructor: WETH_ADDRESS)
├── batchSetTokenMContracts  (16 Moonwell token → mToken mappings)
├── batchSetTokenCContracts  (5 Compound token → cToken mappings)
├── setFluidVaultResolver    (Fluid vault resolver address)
└── addToWhitelistBatch      (20 whitelisted tokens)
    └── AaveV3Handler     (pool, dataProvider, uniswapFactory, registry)
        └── CompoundHandler   (registry, uniswapFactory)
            └── MorphoHandler     (morpho, uniswapFactory, registry)
                └── FluidSafeHandler  (uniswapFactory, registry)
                    └── MoonwellHandler   (comptroller, uniswapFactory, registry)
                        └── DebtSwap              (uniswapFactory, protocols[], handlers[])
                            ├── setParaswapAddresses
                            └── SafeModuleDebtSwap    (uniswapFactory, protocols[], handlers[], pauser)
                                ├── setParaswapAddresses
                                ├── setoperator
                                └── LeveragedPosition     (uniswapFactory, protocols[], handlers[])
                                    └── setParaswapAddresses
```

**Key points:**
- All deployments are chained sequentially to avoid nonce race conditions
- All 5 handlers depend on the registry being fully configured (token mappings + whitelist set)
- DebtSwap, SafeModuleDebtSwap, and LeveragedPosition each receive all 5 handler addresses
- Post-deploy config calls (`setParaswapAddresses`, `setoperator`) are tracked by Ignition and won't re-run on resume

### Deploy All Contracts

Deploy everything in one command:

```bash
yarn hardhat ignition deploy ignition/modules/DeployAll.ts --network base --verify --reset
```

**Useful flags:**

- `--verify` — automatically verify all contracts on Basescan after deployment
- `--reset` — clear previous deployment state and redeploy from scratch
- `--deployment-id <name>` — use a custom deployment ID (default: `chain-<chainId>`)

### Verify Contracts

The `--verify` flag may fail due to a known `hardhat-verify` v2.x bug with Etherscan's V2 API. Use the standalone verification script instead:

```bash
yarn hardhat run scripts/verifyAll.ts --network base
```

This script reads deployed addresses from `ignition/deployments/chain-<chainId>/deployed_addresses.json`, checks each contract's verification status via the Etherscan V2 API, and submits any unverified contracts. It handles the V2 API correctly and won't fail on already-verified contracts.

### Deployment Output

After a successful deployment, Ignition saves the deployed addresses and artifacts to:

```
ignition/deployments/<deployment-id>/
├── deployed_addresses.json    # All contract addresses
├── journal.jsonl              # Full deployment log
└── artifacts/                 # Contract ABIs and build info
```

You can inspect deployed addresses with:

```bash
cat ignition/deployments/chain-8453/deployed_addresses.json
```

### Timelock Operations

For critical operations (updating Paraswap address):

```bash
# Schedule operation (requires proposer role)
TIMELOCK_ADDRESS=0x... PROTOCOL_REGISTRY_ADDRESS=0x... NEW_PARASWAP_ADDRESS=0x... \
yarn hardhat run scripts/timelock-update-paraswap.ts --network base

# Wait 2 days, then execute
EXECUTE=true TIMELOCK_ADDRESS=0x... PROTOCOL_REGISTRY_ADDRESS=0x... NEW_PARASWAP_ADDRESS=0x... \
yarn hardhat run scripts/timelock-update-paraswap.ts --network base
```

> **Note**: Updating the operator address (`setOperator`) also requires the timelock. Create a similar script based on `timelock-update-paraswap.ts` if needed.


## Security Features

The contracts include several security features:

- Non-reentrant function protection
- Access control via Ownable pattern
- Safe ERC20 operations using GPv2SafeERC20
- Flash loan validation
- Emergency withdrawal functionality
- Protocol fee limits (max 1%)

## License

MIT
