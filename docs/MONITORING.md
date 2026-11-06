# Monitoring: admin and role changes

`docs/SECURITY_MODEL.md` says "alert on it" for every switch flip and every
handler retune. This document is the alert policy behind that sentence, and
`scripts/watchAdminEvents.ts` is a reference implementation of it: the event
catalogue in that script is the single source of truth, and
`test/scripts/watchAdminEvents.ts` fails whenever a watched contract gains an
event the catalogue does not classify.

## What is watched

Four contracts hold privileged state. Their addresses come from
`deployments/base.json`.

| Contract             | Why it matters                                                                 |
| -------------------- | ------------------------------------------------------------------------------ |
| `SafeYieldManager`   | which handler code runs, what it charges, who can stop it, which pools it accepts |
| `TimelockController` | every `CRITICAL_ROLE` change is scheduled here 48 h before it executes          |
| `ProtocolRegistry`   | the operator address every module trusts, the swap router, the whitelist       |
| `SafeDebtManager`    | debt handler registration, fees, emergency sweeps                              |

Position activity (`PositionOpened`, `PositionClosed`, `PositionSwitched`,
`FeesCollected`, `DebtSwapped`, ...) is normal operation and is never an
alert. It is listed explicitly in the script's `ACTIVITY_EVENTS` so that the
choice is reviewed, not accidental.

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

## Running the watcher

The watcher needs an RPC URL and nothing else: no keys, no write access.

```bash
# one pass, for cron (every 5 minutes is plenty: the timelock delay is 48 h)
ONCE=true ALERT_WEBHOOK_URL=https://hooks.example/... yarn watch:admin

# or a long-running loop
POLL_INTERVAL_MS=60000 ALERT_WEBHOOK_URL=https://hooks.example/... yarn watch:admin
```

- It remembers the last block it saw in `STATE_FILE` (default
  `.watch-admin-events.json`, gitignored) and resumes from there, so a missed
  cron tick is not a missed alert. The first run starts at the head unless
  `START_BLOCK` says otherwise.
- `ALERT_WEBHOOK_URL` receives `{ "text": "<one line per alert>" }`, which
  Slack incoming webhooks accept directly; Telegram and PagerDuty need a small
  relay. Without it the alerts go to stdout only.
- `MIN_SEVERITY=high` drops the info lines from the channel.
- `MANIFEST` points it at another deployment manifest (an Ignition
  `deployed_addresses.json` works too).

Every alert line names the severity, contract, event, decoded arguments,
block and transaction link, for example:

```
[CRITICAL] SafeYieldManager.PauserUpdated — the pauser key changed | previousPauser=0x... newPauser=0x... | block 1234 https://basescan.org/tx/0x...
```

## Not covered here

These are health checks, not change alerts, and belong in a separate job:

- the savings oracle answering (`ChainlinkSsrRateProvider.rate` reverting
  means opens and closes are failing closed; `withdraw` still works):
  `ACTION=status npx hardhat run scripts/savingsBySafe.ts --network base` reports it;
- PSM3's USDC pocket against the open book;
- the operator's gas balance;
- a repeated `FeeTransferFailed` from the same treasury address, which means
  fees are being waived on every exit until the treasury is fixed.
