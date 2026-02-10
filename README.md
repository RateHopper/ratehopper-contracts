# RateHopper Contracts

RateHopper Contracts is a smart contract system that enables users to automatically switch their borrowing positions between different DeFi lending protocols to take advantage of the best borrowing rates. This helps users optimize their borrowing costs by seamlessly moving their debt between protocols when better rates are available.

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

1. **Governance & Access Control**:

    - `TimelockController`: OpenZeppelin's timelock implementation with 2-day delay for critical operations
    - `ProtocolRegistry.sol`: Central registry with hybrid access control:
        - `DEFAULT_ADMIN_ROLE`: For routine operations (whitelist, token mappings) - immediate execution
        - `CRITICAL_ROLE`: For critical operations (setParaswapV6, setOperator) - requires timelock

2. **DebtSwap.sol**: The main contract that orchestrates the debt switching process using flash loans.

3. **Protocol Handlers**: Individual handlers for each supported lending protocol:

    - In `contracts/protocols/` directory:

        - `AaveV3Handler.sol`: Handles interactions with Aave V3 protocol
        - `CompoundHandler.sol`: Handles interactions with Compound protocol
        - `MorphoHandler.sol`: Handles interactions with Morpho protocol

    - In `contracts/protocolsSafe/` directory:
        - `MoonwellHandler.sol`: Handles interactions with Moonwell protocol
        - `FluidSafeHandler.sol`: Handles interactions with Fluid protocol through Safe

4. **Safe Modules**: Modules for Gnosis Safe integration:

    - `SafeDebtManager.sol`: Enables debt swaps through Gnosis Safe
    - Both operator-initiated and Safe owner-initiated transactions supported

5. **LeveragedPosition.sol**: Facilitates creation of leveraged positions across protocols.

6. **Morpho Libraries**: Supporting libraries for the Morpho protocol:

    - `MathLib.sol`: Provides fixed-point arithmetic operations for the Morpho protocol
    - `SharesMathLib.sol`: Handles share-to-asset conversion with virtual shares to protect against share price manipulations

## Integration Guide

### Protocol-Specific Requirements

**Aave V3:**

- Approve aToken when switching from Aave
- Approve debt delegation when switching to Aave
- Extra data: `"0x"`

**Compound V3:**

- Call `allow()` to authorize DebtSwap contract
- Extra data: `"0x"`

**Morpho:**

- Call `setAuthorization(debtSwapContract, true)`
- Extra data: Encode `(MarketParams, borrowShares)` - **REQUIRED**

**Moonwell:**

- No pre-approval required
- Extra data: `"0x"`

**Fluid:**

- No pre-approval required
- Extra data: Encode `(vaultAddress, nftId, isFullRepay)` - **REQUIRED**

### Key Implementation Notes

1. **Flash Loans**: Uses Uniswap V3 flash loans for atomic debt transfers
2. **Protocol Fee**: Configurable fee (max 1%) taken from destination debt
3. **Slippage**: Include `srcAmount` with slippage adjustment in `ParaswapParams` for token swaps
4. **Collateral**: Automatically moved from source to destination protocol
5. **Amount**: Use `MaxUint256` for full debt repayment, or specify exact amount

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


## Environment Variables

Create a `.env` file with the following required variables (use `.env.sample` as a template):

```env
ADMIN_ADDRESS=0x...           # Initial admin and timelock proposer/executor
SAFE_OPERATOR_ADDRESS=0x...   # Operator address for Safe interactions
PAUSER_ADDRESS=0x...          # Address that can pause contracts
DEPLOYER_PRIVATE_KEY=...      # Private key for deployment
EXPLORER_KEY=...              # Block explorer API key for verification
```
## Setup and Development

1. Install dependencies:

```bash
yarn install
```

2. Compile contracts:

```bash
yarn compile
```

3. Run tests:

```bash
yarn test
```

The project uses:

- Solidity version 0.8.28
- Hardhat for development and testing
- Hardhat Ignition for deployments
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

The contracts use [Hardhat Ignition](https://hardhat.org/ignition) for declarative deployments. Make sure you complete the sections Environment Variables and Setup and Development and make sure all tests pass before deploying.

### How Hardhat Ignition Works

Hardhat Ignition is a declarative deployment framework. Instead of writing imperative scripts that send transactions one by one, you define a **module** that describes _what_ to deploy and the dependencies between steps. Ignition then:

- **Resolves the dependency graph** and executes steps in the correct order
- **Tracks state** in `ignition/deployments/chain-<chainId>/` so deployments can be resumed if interrupted
- **Records constructor args** in `journal.jsonl` for reproducibility and verification
- **Supports `--verify`** to automatically submit contracts to Etherscan after deployment
- **Supports `--reset`** to wipe previous state and redeploy from scratch

All contracts are defined in a single module at `ignition/modules/DeployAll.ts`. Every step is chained sequentially via `after` dependencies to avoid nonce race conditions.

### Deploy All Contracts

Deploy everything in one command:

```bash
yarn deploy
# or equivalently:
npx hardhat ignition deploy ignition/modules/DeployAll.ts --network base --verify --reset
```

This deploys all contracts sequentially in a single transaction chain:

1. **TimelockController** (2-day delay)
2. **ProtocolRegistry** (with timelock, operator, paraswap configured)
3. **Handlers**: AaveV3 → Compound → Morpho → FluidSafe → Moonwell
4. **Registry config**: token mappings, Fluid resolver, whitelist
5. **Admin transfer**: grant `ADMIN_ADDRESS` admin role, revoke deployer
6. **SafeDebtManager** → `transferOwnership` to `ADMIN_ADDRESS`
7. **LeveragedPosition** → `transferOwnership` to `ADMIN_ADDRESS`
8. **SafeExecTransactionWrapper**

### Deployment Output

After deployment, Ignition saves state to:

```
ignition/deployments/<deployment-id>/
├── deployed_addresses.json    # All contract addresses
├── journal.jsonl              # Full deployment log (includes constructor args)
└── artifacts/                 # Contract ABIs and build info
```

Inspect deployed addresses:

```bash
cat ignition/deployments/chain-8453/deployed_addresses.json
```

### Contract Verification

The `--verify` flag on `yarn deploy` may fail due to a known `hardhat-verify` v2.x bug with Etherscan's V2 API (the plugin's GET requests strip the `chainid` parameter). Use the standalone verification script instead:

```bash
yarn verify
# or equivalently:
npx hardhat run scripts/verifyAll.ts --network base
```

This script:

1. **Reads** deployed addresses from `ignition/deployments/chain-<chainId>/deployed_addresses.json`
2. **Reads** constructor args from `journal.jsonl` (no hardcoding needed)
3. **Checks** each contract via the Etherscan V2 API (skips already-verified)
4. **Submits** unverified contracts via `hardhat verify`
5. **Polls** the V2 API with retries (5 attempts, 10s apart) to confirm verification despite the plugin bug

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

### Access Control & Governance

- **Timelock Controller**: 2-day delay for critical operations (Paraswap and operator updates)
- **Hybrid Access Control**:
    - `DEFAULT_ADMIN_ROLE`: For routine operations (immediate execution)
    - `CRITICAL_ROLE`: For critical operations (requires timelock)
- **Operator Authorization**: Centralized operator management through ProtocolRegistry
    - Both `SafeDebtManager` and `LeveragedPosition` read operator from registry
    - Supports both operator-initiated and Safe owner-initiated transactions

### Smart Contract Security

- **Reentrancy Protection**: All state-changing functions protected via OpenZeppelin's `ReentrancyGuard`
- **Ownership Pattern**: Uses OpenZeppelin's `Ownable` for administrative functions
- **Safe ERC20 Operations**: Uses OpenZeppelin's `SafeERC20` for secure token transfers
- **Flash Loan Validation**: Validates Uniswap V3 pool callbacks via `CallbackValidation`

### Safe Integration Security

- **Authorization Check**: Only authorized callers (operator or Safe itself) can execute operations
- **Safe Multi-sig Support**: Safe owners must use multi-sig process to manage positions
- **No Individual Owner Calls**: Individual Safe owners cannot call directly (prevents malicious contract exploits)

### Additional Protections

- **Emergency Withdrawal**: Owner can withdraw stuck tokens in emergency situations
- **Protocol Fee Limits**: Maximum fee capped at 1% (100 basis points)
- **Pausable Contracts**: Designated pauser can pause operations in emergency situations
- **Input Validation**: Comprehensive checks on all function parameters
- **Whitelist System**: Only whitelisted tokens can be used in the protocol

## License

Business Source License 1.1 (BUSL-1.1)

Licensed under the Business Source License 1.1. After December 8, 2028 (4 years from initial release), the license converts to GPL-2.0-or-later.

See [LICENSE](./LICENSE) for details.
