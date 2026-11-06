# Monitoring: admin and role changes

`docs/SECURITY_MODEL.md` says "alert on it" for every switch flip and every
handler retune. This document is the alert policy behind that sentence. The
alerts themselves are configured in Tenderly (below); the tables here are the
source of truth for which rules must exist, and a change that adds an event to
a watched contract updates both in the same pull request.

## What is watched

Four contracts hold privileged state. Their addresses come from
`deployments/base.json`.

| Contract             | Why it matters                                                                 |
| -------------------- | ------------------------------------------------------------------------------ |
| `SafeYieldManager`   | which handler code runs, what it charges, who can stop it, which pools it accepts |
| `TimelockController` | every `CRITICAL_ROLE` change is scheduled here 48 h before it executes          |
| `ProtocolRegistry`   | the operator address every module trusts, the swap router, the whitelist       |
| `SafeDebtManager`    | debt handler registration, fees, emergency sweeps                              |

Position activity is normal operation and is never an alert. The list is
explicit so that the choice is reviewed, not accidental:

| Contract             | Not alerted                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SafeYieldManager`   | `PositionOpened`, `PositionClosed`, `PositionWithdrawn`, `PositionSwitched`, `FeesCollected`, `RestakeSkipped`, `StakedRewardCollected`, `SwapSkippedBelowFloor`, `SwitchResidueSettled` |
| `TimelockController` | `CallSalt` (accompanies every `CallScheduled`)                                                                                                               |
| `SafeDebtManager`    | `DebtSwapped`, `DebtPositionExited`                                                                                                                          |

Every other event the four ABIs declare is in the catalogue below. When a
contract gains an event, it goes in one of the two lists.

## Severity and response

| Severity   | Meaning                                                                                                   | Response                                                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `critical` | privileged code, money or key changed: handler registered, fee or treasury changed, role granted, pause, sweep, timelock execution | page the on-call now. Match the transaction against an announced change (below). No match: open the incident runbook, playbook A, within 15 minutes |
| `high`     | a bounded parameter, switch or allow-list changed, a critical operation was queued, a fee transfer failed   | review the same business day. A `CallScheduled` opens the 48 h window to cancel an unwanted critical change                                   |
| `info`     | liquidity floors, whitelist entries                                                                        | log only                                                                                                                                      |

### Event catalogue

`SafeYieldManager`

| Event                                  | Severity | Meaning                                                   |
| -------------------------------------- | -------- | --------------------------------------------------------- |
| `YieldHandlerUpdated`                  | critical | handler code registered or rolled for a protocol id (timelock) |
| `TwapConfigUpdated`                    | critical | the price reference for a token changed (timelock)        |
| `TreasuryUpdated`                      | critical | fees now go to another address (timelock)                 |
| `PerformanceFeeBpsUpdated`, `FeeCollectBpsUpdated` | critical | a fee changed (timelock)                        |
| `PauserUpdated`                        | critical | the pauser key changed                                    |
| `TokenRescued`, `NftRescued`           | critical | assets were swept out of the module                       |
| `Paused`                               | critical | opens and switches are stopped (exit-only mode)           |
| `RoleGranted`, `RoleRevoked`, `RoleAdminChanged` | critical | a privileged role changed                        |
| `Unpaused`                             | high     | opens and switches resumed                                |
| `HandlerConfigured`                    | high     | a handler's bounded parameters were retuned               |
| `ProtocolStatusChanged`                | high     | a protocol's open or close switch flipped                 |
| `MaxSlippageBpsUpdated`                | high     | the LP slippage ceiling changed                           |
| `PoolParamAllowedUpdated`              | high     | a pool was allow-listed or de-listed                      |
| `FeeTransferFailed`, `CollectFeeTransferFailed` | high | a fee could not reach the treasury and was waived     |
| `MinPoolLiquidityUpdated`, `MinPositionLiquidityUpdated` | info | a liquidity floor changed                      |

`TimelockController`

| Event            | Severity | Meaning                                                       |
| ---------------- | -------- | ------------------------------------------------------------- |
| `CallExecuted`   | critical | a critical operation executed                                 |
| `MinDelayChange` | critical | the timelock delay changed                                    |
| `RoleGranted`, `RoleRevoked`, `RoleAdminChanged` | critical | proposer or executor set changed             |
| `CallScheduled`  | high     | a critical operation is queued; it executes after the delay   |
| `Cancelled`      | high     | a queued operation was cancelled                              |

`ProtocolRegistry`

| Event                       | Severity | Meaning                                  |
| --------------------------- | -------- | ---------------------------------------- |
| `OperatorUpdated`           | critical | the operator address changed (timelock)  |
| `ParaswapV6Updated`         | critical | the swap router changed (timelock)       |
| `RoleGranted`, `RoleRevoked`, `RoleAdminChanged` | critical | a privileged role changed |
| `FluidVaultResolverUpdated` | high     | the Fluid resolver changed               |
| `TokenWhitelisted`, `TokenRemovedFromWhitelist` | info | the whitelist changed         |

`SafeDebtManager`

| Event                                          | Severity | Meaning                                   |
| ---------------------------------------------- | -------- | ----------------------------------------- |
| `ProtocolHandlerUpdated`                       | critical | debt handler code registered              |
| `ProtocolFeeSet`, `FeeBeneficiarySet`          | critical | the debt-swap fee or its recipient changed |
| `EmergencyWithdrawn`, `EmergencyETHWithdrawn`  | critical | assets were swept out of the debt manager |
| `OwnershipTransferred`                         | critical | the owner changed                         |
| `Paused`                                       | critical | debt swaps are stopped                    |
| `ProtocolStatusChanged`, `Unpaused`            | high     | a protocol switch flipped, swaps resumed  |

## Announced changes

Every intended privileged change is announced in the operations channel
before it is sent: the ticket, the signer (pauser multisig, admin, or the
timelock operation id printed by `scripts/timelockSetYieldHandler.ts` and the
other timelock scripts), and the expected event. An alert with no matching
announcement is an incident by definition, however benign it looks.

Timelock changes are two alerts 48 h apart: `CallScheduled` (high) is the
moment to cancel a queued change nobody announced; `CallExecuted` (critical)
confirms it ran.

## Setting up the alerts in Tenderly

1. Add the four contracts to the Tenderly project on Base, at the addresses in
   `deployments/base.json`. They are verified on Basescan (`yarn verify`), so
   Tenderly decodes their events; if a fresh deployment is not verified yet,
   verify first rather than uploading an ABI by hand.
2. Create one "Event Emitted" alert per row of the catalogue, named
   `<severity>-<Contract>.<Event>` so the destination and the policy row are
   recognisable from the alert title. Group destinations by severity:
   `critical` to the on-call channel that pages (PagerDuty or the on-call
   Telegram group), `high` to the operations channel, `info` to a log-only
   destination (email digest or a muted channel).
3. For the timelock, `CallScheduled` is the alert that needs a human within
   48 hours; make sure it reaches the people who can cancel.
4. Prove delivery before relying on it, and again after every change to the
   rules: send an `info` change that is a no-op (for example
   `setMinPositionLiquidity` to its current value emits
   `MinPositionLiquidityUpdated`) and confirm the alert arrives on the log-only
   destination. A silent monitor and a quiet contract look identical from the
   outside; this is the only way to tell them apart. Repeat quarterly.
5. After a redeploy (new manager, new handler build), add the new addresses
   and retire the old ones in the same change that journals the deployment.

Plan limits: Tenderly caps the number of alerts per plan. The catalogue needs
about forty rules; check the plan before setup rather than silently dropping
the `info` rows.

## Not covered here

These are health checks, not change alerts, and belong in a separate job:

- the savings oracle answering (`ChainlinkSsrRateProvider.rate` reverting
  means opens and closes are failing closed; `withdraw` still works):
  `ACTION=status npx hardhat run scripts/savingsBySafe.ts --network base` reports it;
- PSM3's USDC pocket against the open book;
- the operator's gas balance;
- a repeated `FeeTransferFailed` from the same treasury address, which means
  fees are being waived on every exit until the treasury is fixed.
