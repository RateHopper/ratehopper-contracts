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
- **LeveragedPosition.sol**: Creates leveraged positions across protocols
- **ProtocolRegistry.sol**: Central registry for token mappings, operator, and protocol configs
- **Types.sol**: Shared type definitions

### Protocol Handlers (`contracts/protocols/`, `contracts/protocolsSafe/`)

- **AaveV3Handler.sol**, **CompoundHandler.sol**, **MoonwellHandler.sol**, **FluidSafeHandler.sol**
- Each implements: `getDebtAmount`, `switchIn`, `switchFrom`, `switchTo`, `repay`

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

- Handlers: `<Protocol>Handler.sol`
- Interfaces: `I<ContractName>.sol`
- Tests: `test/<feature>.ts`

## Key Files

- `contractAddresses.ts`: Token and protocol addresses
- `test/constants.ts`, `test/utils.ts`, `test/deployUtils.ts`: Test helpers

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
