# CLAUDE.md

## Project Overview

RateHopper Contracts is a DeFi smart contract system enabling automated debt position switching between lending protocols to optimize borrowing rates. Uses flash loans for atomic operations on Base network.

## Tech Stack

- **Solidity**: 0.8.28 (primary), 0.7.6 (Uniswap compatibility)
- **Framework**: Hardhat with TypeScript
- **Testing**: Mocha/Chai, Base mainnet forking
- **Package Manager**: Yarn 4.12.0 (via corepack)

## Architecture

### Core Contracts

- **SafeDebtManager.sol**: Main entry point for debt swaps via Gnosis Safe
- **SafeYieldManager.sol**: Single Safe-module entry point for yield (LP) protocols; delegatecalls stateless yield handlers, shared state in ERC-7201 namespace (`YieldStorage`)
- **LeveragedPosition.sol**: Creates leveraged positions across protocols
- **ProtocolRegistry.sol**: Central registry for token mappings, operator, and protocol configs
- **Types.sol**: Shared type definitions (`DebtProtocol` enum, `YIELD_PROTOCOL_*` uint8 id constants)
- **RatehopperUniV3Positions.sol**: Legacy standalone yield module, deployed and serving existing positions; superseded by SafeYieldManager for new positions (coexistence — do not modify)

### Protocol Handlers (`contracts/debt/handlers/`)

- **AaveV3DebtHandler.sol**, **CompoundDebtHandler.sol**, **MorphoDebtHandler.sol**, **MoonwellDebtHandler.sol**, **FluidSafeDebtHandler.sol** extend **BaseDebtHandler.sol**
- Each implements: `getDebtAmount`, `switchIn`, `switchFrom`, `switchTo`, `repay`

### Yield Handlers (`contracts/yield/handlers/`)

- **BaseYieldHandler.sol** owns the shared LP flow, protocol diffs in virtual hooks; **V3StyleYieldHandler.sol** implements the hooks against canonical Uniswap V3 interfaces (protocol id as constructor arg); **UniV3YieldHandler.sol** extends V3StyleYieldHandler, **AerodromeYieldHandler.sol** extends BaseYieldHandler directly
- **UniV4YieldHandler.sol** implements `IYieldHandler` directly (V4 singleton/actions model doesn't fit the V3-shaped hooks): PoolKey pool params (`keccak256(poolParam)` == V4 PoolId), Permit2 two-step approvals, UniversalRouter swaps, native ETH pools supported; V4 math imported from exact-pinned npm packages (`@uniswap/v4-core@1.0.2`, `@uniswap/v4-periphery@1.0.3` — keep exact versions, no `^`); V4 interfaces remain hand-written minimal versions vendored under `contracts/interfaces/uniswapV4/` (do not replace with official interfaces — their `Currency`/`PositionInfo` types would leak into handler code)
- Stateless delegatecall targets: MUST NOT declare storage variables; mutable state only via `YieldStorage._yieldStorage()`
- Pool selection params are ABI-encoded bytes (`uint24` feeTier / `int24` tickSpacing / full V4 `PoolKey` tuple)

### Access Control

- **DEFAULT_ADMIN_ROLE**: Routine operations (whitelist, token mappings)
- **CRITICAL_ROLE**: Critical operations requiring TimelockController (2-day delay)
- **safeOperator**: Address authorized to execute operations on Safes

## Code Conventions

- When contract code is changed, always check and update test and ignition codes too
- Don't add unnecesarry comment in test codes.
- Custom errors instead of require strings: `error ZeroAddress();`
- OpenZeppelin's `SafeERC20` for all token transfers, `forceApprove` for approvals
- Events for all state changes
- Input validation at function entry

### Naming

- Handlers: `<Protocol>DebtHandler.sol` (debt) / `<Protocol>YieldHandler.sol` (yield)
- Interfaces: `I<ContractName>.sol`
- Tests: `test/<area>/<feature>.ts` — areas: `debt/`, `registry/`, `yield/`, `legacy/` (deployed standalone modules), `helpers/` (fixtures/utils, no tests)

## Key Files

- `contractAddresses.ts`: Token and protocol addresses
- `test/helpers/constants.ts`, `test/helpers/utils.ts`, `test/helpers/deployUtils.ts`: Test helpers

## Security Requirements

1. Use `nonReentrant` on all state-changing functions
2. Follow CEI pattern (Checks-Effects-Interactions)
3. Validate flash loan callbacks via `CallbackValidation.verifyCallback()`
4. Never use `tx.origin` - always `msg.sender`
5. No hardcoded addresses - use registry
6. Include slippage protection in swaps
7. Verify debt amounts from protocol directly (not cached)

## External Dependencies

- **Uniswap V3**: Flash loans
- **Paraswap V6**: Token swaps
- **Gnosis Safe**: Module integration via `execTransactionFromModule`

## Bug Fixing

- When fixing a bug, always check that the fix doesn't introduce regressions — especially verify loading states, null/undefined propagation, and UI state consistency before considering the task complete.

## Response Guidelines

- When the user asks a question or requests an explanation, respond with information only — do NOT create new files, utilities, hooks, or implementations unless explicitly asked to write code.

## Solidity / Smart Contracts

- When making struct or storage optimizations in Solidity, make minimal targeted changes. Do not refactor adjacent code or optimize beyond what was explicitly requested. If unsure of scope, ask first.

## Workflow

- Before editing code, check if the function/feature already exists in the codebase. Use Grep/Read to verify before creating or modifying anything.

## Code Review

- When reviewing PRs or branches, always confirm the correct branch/remote first. Do not attempt to review uncommitted local changes unless explicitly asked.
