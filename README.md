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

- **Uniswap V3 LP Lifecycle**: `RatehopperUniV3Positions` is a Gnosis Safe module that opens, harvests fees from, and closes WETH/USDC LP positions atomically. Charges a configurable performance fee on profit at close, plus a separate fee on accrued LP fees. Critical setters are timelock-gated.

- **Unified Yield Module (SafeYieldManager)**: `SafeYieldManager` is the single Safe module for all yield (LP) protocols — the yield-side counterpart of `SafeDebtManager`. Users enable this ONE contract as a module; per-protocol mechanics live in stateless handlers (`UniV3YieldHandler`, `AerodromeYieldHandler`) invoked via delegatecall. Protocols are identified by plain `uint8` ids (the `YIELD_PROTOCOL_*` constants in `Types.sol` document the canonical assignment), so adding a protocol (e.g. Uniswap V4) is a handler deployment + timelocked `setYieldHandler` on the already-deployed manager — no redeploy, and not a new module every user must enable. The standalone `RatehopperUniV3Positions` module above is **legacy**: it keeps serving positions opened through it (coexistence, no state migration), while new positions — Uniswap V3 and Aerodrome Slipstream (CL) WETH/USDC, run **unstaked** — open through `SafeYieldManager`.

## Architecture

The system consists of several key components:

1. **Governance & Access Control**:
    - `TimelockController`: OpenZeppelin's timelock implementation with 2-day delay by default for critical operations
    - `ProtocolRegistry.sol`: Central registry with hybrid access control:
        - `DEFAULT_ADMIN_ROLE`: For routine operations (whitelist, token mappings) - immediate execution
        - `CRITICAL_ROLE`: For critical operations (setParaswapV6, setOperator) - requires timelock

2. **SafeDebtManager.sol**: The main contract that orchestrates the debt switching process using flash loans.

3. **Debt Handlers** (`contracts/debt/handlers/`): Individual handlers for each supported lending protocol, all implementing `IDebtHandler` and extending `BaseDebtHandler.sol`:
    - `AaveV3DebtHandler.sol`: Handles interactions with Aave V3 protocol
    - `CompoundDebtHandler.sol`: Handles interactions with Compound protocol
    - `MorphoDebtHandler.sol`: Handles interactions with Morpho protocol
    - `MoonwellDebtHandler.sol`: Handles interactions with Moonwell protocol
    - `FluidSafeDebtHandler.sol`: Handles interactions with Fluid protocol through Safe

4. **Safe Modules**: Modules for Gnosis Safe integration:
    - `SafeDebtManager.sol`: Enables debt swaps through Gnosis Safe
    - Both operator-initiated and Safe owner-initiated transactions supported

5. **LeveragedPosition.sol**: Facilitates creation of leveraged positions across protocols.

6. **RatehopperUniV3Positions.sol**: Standalone Gnosis Safe module for Uniswap V3 WETH/USDC LP lifecycle. Three external entry points:
    - `openLp()` — splits the Safe's USDC, swaps half to WETH via the pinned SwapRouter02, mints a Uniswap V3 LP NFT on the Safe.
    - `closeLp()` — partial or full unwind (`exitBps`): harvests accrued fees, `decreaseLiquidity`, collects principal, optionally `burn`s, swaps the WETH leg back to USDC.
    - `collectLp()` — mid-position fee harvest with no decrease/burn.

    Caller passes per-call `swapAmountOutMin` and `deadline` (audit fixes C-01 / H-02). The constructor rejects any non-WETH/USDC token pair (M-08). Performance fee is charged on net profit (`currentValueUsd6 - basisUsd6`); fee-collect is charged on accrued fees only. All fee setters are gated by `CRITICAL_ROLE` on a TimelockController (H-04); `rescueToken` and similar emergency ops are gated by `DEFAULT_ADMIN_ROLE`.

7. **SafeYieldManager.sol + Yield Handlers** (`contracts/yield/`): Adapter-pattern successor to (6). `SafeYieldManager` is the single Safe module users enable; it owns basis bookkeeping (`residualBasisUsd6Of`, keyed by `(uint8 protocolId, tokenId)`), the performance fee, pause / per-protocol disable switches, and the timelocked setter surface. Protocol ids are plain `uint8` (not a Solidity enum) end-to-end, so a NEW protocol registers on the deployed manager via `setYieldHandler(id, handler)` — followed by the pauser enabling open/close and the admin allow-listing pool params — with no redeploy; the `YIELD_PROTOCOL_*` constants in `Types.sol` just document the canonical id assignment (append-only). Protocol mechanics live in stateless handlers executed via delegatecall:
    - `BaseYieldHandler.sol` — the shared `openLp`/`closeLp`/`collectLp` flow for V3-style CL protocols; protocol diffs are isolated in five virtual hooks (pool resolution, `slot0` read, swap calldata, mint calldata, `positions` decoding).
    - `UniV3YieldHandler.sol` / `AerodromeYieldHandler.sol` — concrete adapters holding protocol immutables.
    - Shared mutable state lives in an ERC-7201 namespace (`YieldStorage`, `ratehopper.storage.yield`), so handler delegatecode can never collide with the manager's inherited storage. Handlers MUST NOT declare storage variables.
    - Pool selection params are ABI-encoded bytes (`abi.encode(uint24 feeTier)` for Uniswap V3, `abi.encode(int24 tickSpacing)` for Aerodrome), allow-listed by `keccak256(poolParam)` — richer identifiers (e.g. a Uniswap V4 `PoolKey`) fit without interface changes. A protocol whose mechanics don't fit `BaseYieldHandler` implements `IYieldHandler` directly.

8. **Morpho Libraries**: Supporting libraries for the Morpho protocol:
    - `MathLib.sol`: Provides fixed-point arithmetic operations for the Morpho protocol
    - `SharesMathLib.sol`: Handles share-to-asset conversion with virtual shares to protect against share price manipulations

## Integration Guide

### Protocol-Specific Requirements

**Aave V3:**

- Approve aToken when switching from Aave
- Approve debt delegation when switching to Aave
- Extra data: `"0x"`

**Compound V3:**

- Call `allow()` to authorize the SafeDebtManager contract
- Extra data: `"0x"`

**Morpho:**

- Call `setAuthorization(safeDebtManager, true)`
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

### SafeDebtManager Contract

- `executeDebtSwap`: Main entry point for initiating a debt position transfer
- `uniswapV3FlashCallback`: Handles the flash loan callback from Uniswap V3
- `setProtocolFee`: Sets the protocol fee percentage (basis points)
- `setFeeBeneficiary`: Sets the address that receives protocol fees
- `getHandler`: Retrieves the handler address for a specific protocol
- `emergencyWithdraw`: Allows the owner to withdraw tokens in case of emergency

### Debt Handlers

Each debt handler implements the following key functions:

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
    DebtProtocol _fromProtocol,   // Source protocol enum (AAVE_V3, COMPOUND, MORPHO, FLUID, MOONWELL)
    DebtProtocol _toProtocol,     // Destination protocol enum
    address _fromDebtAsset,       // Debt asset address on source protocol
    address _toDebtAsset,         // Debt asset address on destination protocol
    uint256 _amount,              // Amount to swap (use type(uint256).max for full debt)
    CollateralAsset[] calldata _collateralAssets,  // Array of collateral assets
    address _onBehalfOf,          // Safe address the swap is executed for
    bytes[2] calldata _extraData, // [fromExtraData, toExtraData] for the two protocols
    ParaswapParams calldata _paraswapParams  // Paraswap parameters for token swaps
)
```

### Collateral Asset Structure

```solidity
struct CollateralAsset {
    address asset; // Collateral asset address
    uint256 amount; // Collateral amount
}
```

### Paraswap Parameters

```solidity
struct ParaswapParams {
    uint256 srcAmount; // Source amount with slippage adjustment (for token swaps)
    bytes swapData; // Encoded swap data from Paraswap API
}
```

## Environment Variables

Create a `.env` file with the following required variables (use `.env.sample` as a template):

```env
# Core deploy
ADMIN_ADDRESS=0x...           # Initial admin and timelock proposer/executor (used by all deploy modules)
SAFE_OPERATOR_ADDRESS=0x...   # Operator address for Safe interactions
PAUSER_ADDRESS=0x...          # Address that can pause contracts
DEPLOYER_PRIVATE_KEY=...      # Private key for deployment
EXPLORER_KEY=...              # Block explorer API key for verification
BASE_FORK_BLOCK_NUMBER=49470000 # Optional deterministic fork block for CI

# Yield deploy config (deploy:2_yield_manager)
# Resolution order: SYM_* module override → shared unprefixed name → legacy
# RHP_* fallback (addresses only) → default. Empty values (X=) count as
# unset and fall through.
TREASURY=0x...                # Fee treasury for all yield modules. REQUIRED.
REGISTRY=0x...                # Optional. Falls back to PROTOCOL_REGISTRY_ADDRESS in contractAddresses.ts
INITIAL_ADMIN=0x...           # Optional. DEFAULT_ADMIN_ROLE holder. Falls back to ADMIN_ADDRESS
RHP_TIMELOCK=0x...            # Optional. Reuse an existing TimelockController (shared by all three modules)
PERFORMANCE_FEE_BPS=1000      # Optional. Performance fee on profit at closeLp (bps). Default 1000 (10%)
FEE_COLLECT_BPS=250           # Optional. Fee on accrued LP fees (bps). Default 250 (2.5%)
MAX_FEE_BPS=2000              # Optional. Hard upper bound on BOTH fees (bps). Default 2000 (20%)
MIN_POSITION_LIQUIDITY=10000  # Optional. Floor on NPM mint liquidity. Default 10000
MIN_POOL_LIQUIDITY=0          # Optional. Floor on pool.liquidity() for spot-price reads. Default 0 (disabled)

# Optional — TimelockController sub-module (shared by all deploys)
TIMELOCK_ADMIN=0x...          # Proposer + executor on the new timelock. Falls back to ADMIN_ADDRESS
TIMELOCK_DELAY=172800         # Min delay before queued ops execute (seconds). Default 172800 (2 days)

# Optional — per-module overrides: the same suffix with the module prefix wins
# over the shared name, e.g. SYM_TREASURY / RHP_MAX_FEE_BPS.
# SafeYieldManager-specific:
SYM_PAUSER=0x...              # Pauser (pause / per-protocol disable). Falls back to PAUSER_ADDRESS, then ADMIN_ADDRESS
SYM_UNIV3_MIN_POSITION_LIQUIDITY=10000       # Per-protocol floors; fall back to MIN_POSITION_LIQUIDITY /
SYM_AERODROME_MIN_POSITION_LIQUIDITY=10000   # MIN_POOL_LIQUIDITY, then the defaults
SYM_UNIV3_MIN_POOL_LIQUIDITY=0     # Set independently after measuring the target Uni V3 pool
SYM_AERODROME_MIN_POOL_LIQUIDITY=0 # Set independently after measuring the target Slipstream pool
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
- **Supports per-future wipes** with `hardhat ignition wipe <deploymentId> <futureId>`

The core contracts are defined in a single module at `ignition/modules/1_DeployCore.ts`. Every step is chained sequentially via `after` dependencies to avoid nonce race conditions.

### Export ABIs

ABI files for the six core integration contracts are exported to `abis/` from Hardhat artifacts:

```bash
yarn abis
```

This compiles the contracts and writes:

- `abis/LeveragedPosition.json`
- `abis/RatehopperUniV3Positions.json`
- `abis/SafeDebtManager.json`
- `abis/SafeExecTransactionWrapper.json`
- `abis/SafeYieldManager.json`

The deploy scripts below run the ABI exporter automatically after a successful deployment.

### Deploy Registry Only

Deploy only `ProtocolRegistry`:

```bash
yarn deploy:0_registry
```

This deploys and configures `ProtocolRegistry`, syncs the registry address into `contractAddresses.ts`, and refreshes the ABI files in `abis/`.

### Deploy All Contracts

Deploy the core debt-management contracts:

```bash
yarn deploy:1_core
```

This deploys `ignition/modules/1_DeployCore.ts` to Base with verification enabled, reusing the configured registry from `deploy:0_registry`, syncs the registry address into `contractAddresses.ts`, and refreshes the ABI files in `abis/`.

This deploys all contracts sequentially in a single transaction chain:

1. **Configured ProtocolRegistry** from `DeployRegistryOnly`
2. **Handlers**: AaveV3 → Compound → Morpho → FluidSafe → Moonwell
3. **SafeDebtManager** → `transferOwnership` to `ADMIN_ADDRESS`
4. **LeveragedPosition** → `transferOwnership` to `ADMIN_ADDRESS`
5. **SafeExecTransactionWrapper**

### Deploy SafeYieldManager (Unified Yield Stack)

Deploys the adapter-pattern yield stack: `UniV3YieldHandler` + `AerodromeYieldHandler` + `SafeYieldManager`.

```bash
yarn deploy:2_yield_manager
```

This deploys `ignition/modules/2_DeployYieldManager.ts` to Base with verification enabled and refreshes the ABI files in `abis/`.

The module by default deploys:

1. **TimelockController** (shared `TimelockControllerModule`; skipped when `SYM_TIMELOCK` / `RHP_TIMELOCK` is set)
2. **UniV3YieldHandler** and **AerodromeYieldHandler** (stateless delegatecall targets pinned to the canonical Base NPM / factory / router / WETH / USDC addresses)
3. **SafeYieldManager** with both handlers registered, protocols enabled, and default pool-param allow-lists seeded (Uniswap V3 fee tiers `{100, 500, 3000}`, Aerodrome tick spacings `{100, 200}`)

Coexistence note: the standalone `RatehopperUniV3Positions` deployment keeps serving positions opened through it. `SafeYieldManager` rejects those tokenIds (`UnknownPosition`) and vice versa — there is no basis migration; legacy positions drain naturally via the legacy module.

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

Ignition state is intentionally gitignored. Every deploy command also syncs a
stable, reviewable public manifest to `deployments/base.json`; commit that file
after a production deployment so downstream consumers do not depend on a local
Ignition directory. It can also be refreshed manually with:

```bash
yarn deployments:sync
```

### Wiping Deployments

Use `wipe:all` when you want to clear all local Ignition state for Base and redeploy everything from scratch:

```bash
yarn wipe:all
```

This removes `ignition/deployments/chain-8453`. It does not delete on-chain contracts; it only resets this repo's local Ignition deployment journal and generated deployment artifacts for Base.

Shortcut scripts are available for common futures:

```bash
yarn wipe:leveraged-position
yarn wipe:safe-debt-manager
yarn wipe:safe-wrapper
yarn wipe:yield-manager
```

In short: use `wipe:all` for a clean redeploy of the whole Base deployment, and use `wipe` or a `wipe:*` shortcut only when you intentionally want to rerun one named future.

### Contract Verification

The `--verify` flag on `yarn deploy:1_core` may fail due to a known `hardhat-verify` v2.x bug with Etherscan's V2 API (the plugin's GET requests strip the `chainid` parameter). Use the standalone verification script instead:

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

Critical `ProtocolRegistry` setters (`setParaswapV6`, `setOperator`) carry `CRITICAL_ROLE` and revert unless `msg.sender` is the timelock, so they must be scheduled and executed through the `TimelockController` (2-day delay by default). Each script is a two-step flow: schedule, wait for the delay, then re-run with `EXECUTE=true` reusing the same `OPERATION_ID` printed during scheduling.

#### Finding the TimelockController address

`SafeDebtManager` does not store the timelock itself — it only keeps an immutable `registry` reference, and the `TimelockController` address lives on the `ProtocolRegistry` (`timelock()` getter). So given a deployed `SafeDebtManager`, resolve the timelock by hopping through the registry.

**On-chain (authoritative — this is the address the contracts actually enforce):**

```bash
# 1. Read the registry from the deployed SafeDebtManager
REGISTRY=$(cast call <SAFE_DEBT_MANAGER_ADDRESS> "registry()(address)" --rpc-url <BASE_RPC_URL>)

# 2. Read the timelock from that registry
cast call $REGISTRY "timelock()(address)" --rpc-url <BASE_RPC_URL>
```

`SafeDebtManager.registry()` and `ProtocolRegistry.timelock()` are both public getters, so any RPC reader (cast, ethers, a block explorer's "Read Contract" tab) works.

**Off-chain (from this repo's Ignition deployment):** the address is recorded under the `TimelockControllerModule#TimelockController` key — the timelock is a shared sub-module, so it keeps that stable ID regardless of which top-level module deployed it.

```bash
cat ignition/deployments/chain-8453/deployed_addresses.json
# → look for "TimelockControllerModule#TimelockController"
```

Use the resulting address as `TIMELOCK_ADDRESS` in the commands below.

**Updating the Paraswap address:**

```bash
# Schedule operation (requires proposer role)
TIMELOCK_ADDRESS=0x... PROTOCOL_REGISTRY_ADDRESS=0x... NEW_PARASWAP_ADDRESS=0x... \
yarn hardhat run scripts/timelockUpdateParaswap.ts --network base

# Wait for the timelock delay, then execute
EXECUTE=true OPERATION_ID="..." TIMELOCK_ADDRESS=0x... PROTOCOL_REGISTRY_ADDRESS=0x... NEW_PARASWAP_ADDRESS=0x... \
yarn hardhat run scripts/timelockUpdateParaswap.ts --network base
```

**Updating the operator address:**

```bash
# Schedule operation (requires proposer role)
TIMELOCK_ADDRESS=0x... PROTOCOL_REGISTRY_ADDRESS=0x... NEW_OPERATOR_ADDRESS=0x... \
yarn hardhat run scripts/timelockUpdateOperator.ts --network base

# Wait for the timelock delay, then execute (reuse the OPERATION_ID printed during scheduling)
EXECUTE=true OPERATION_ID="..." TIMELOCK_ADDRESS=0x... PROTOCOL_REGISTRY_ADDRESS=0x... NEW_OPERATOR_ADDRESS=0x... \
yarn hardhat run scripts/timelockUpdateOperator.ts --network base
```

## Security Features

The contracts include several security features:

### Access Control & Governance

- **Timelock Controller**: 2-day delay by default for critical operations (Paraswap and operator updates)
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
