# Incident response runbook

The mechanics of every emergency power are in `docs/SECURITY_MODEL.md` (I-03
and "Protocol 3 prices from Chainlink"). This runbook turns them into
playbooks: who acts, with which call, in which order, and what users can do
in the meantime. Fill in the contacts table before the protocol-3 launch and
keep it current.

Two facts shape every playbook:

- **No role can trap a position.** Custody stays in the Safe. `withdraw`
  releases an LP position in kind and a savings position as sUSDS with no
  price read and no venue call, and a Safe can always act on its own NFT or
  sUSDS directly at the venue. The module can delay exits (the close switch);
  it cannot prevent them.
- **Pause is exit-only mode.** `pause()` stops opens and switches. Closes,
  withdrawals and collects keep running through the handler each position is
  pinned to. The per-protocol close switch is the only thing that stops exits
  through the module, and it exists for one case: a handler we no longer trust.

## Roles and powers

| Role                             | Holder                          | Powers                                                                                                                                                  | Delay |
| -------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| Pauser                           | multisig (must not be an EOA)   | `pause()`, `unpause()`, `setProtocolEnabledForOpen(id, bool)`, `setProtocolEnabledForClose(id, bool)`                                                   | none  |
| `DEFAULT_ADMIN_ROLE`             | admin multisig                  | `setPauser`, `configureHandler`, `setPoolParamAllowed`, `setMaxSlippageBps`, `setMinPoolLiquidity`, `setMinPositionLiquidity`, `rescueToken`, `rescueERC721`, role grants | none  |
| `CRITICAL_ROLE`                  | `TimelockController` only       | `setYieldHandler`, `setTwapConfig`, `setTreasury`, `setPerformanceFeeBps`, `setFeeCollectBps`, `allowHookedPoolParam`; on the registry `setOperator`, `setParaswapV6` | 48 h  |
| Registry operator                | backend signing key             | `open`, `close`, `withdraw`, `switchPosition`, `collect` on behalf of any Safe with the module enabled                                                     | none  |
| Safe owners                      | users                           | the same five calls for their own Safe; `disableModule`; direct action on their NFT or sUSDS                                                             | none  |

`DEFAULT_ADMIN_ROLE` cannot grant itself `CRITICAL_ROLE` (the timelock is its
own role admin), so nothing on the "none" rows can change handler code, the
price references, the fees or the operator.

## Severity

| Level | Definition                                                                                                     | Examples                                                                                                   |
| ----- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| SEV-1 | user funds at risk, or a privileged change nobody announced                                                   | a handler misbehaves on real positions; `RoleGranted` / `YieldHandlerUpdated` / `PauserUpdated` with no ticket; operator key leaked |
| SEV-2 | exits through the module degraded, funds safe                                                                  | oracle stale or disagreeing (closes revert), PSM3 pocket drained, treasury rejecting fees on every exit     |
| SEV-3 | entries degraded or observability lost                                                                         | opens reverting on a tolerance that drifted, watcher down, fee transfers failing occasionally              |

Decision owner per level: see Contacts. One person declares the level and
owns the timeline; everyone else executes.

## First fifteen minutes

1. Acknowledge the alert in the operations channel with the level you are
   declaring and your name.
2. Capture state before changing anything:
   ```bash
   ACTION=status npx hardhat run scripts/savingsBySafe.ts --network base   # per affected Safe
   ONCE=true yarn watch:admin                                             # replay what changed
   ```
   Save the output with the ticket. The watcher's state file and the
   transaction links are the timeline.
3. Decide the first lever by what is at risk, not by what is convenient:
   - handler code or an unannounced privileged change → playbook A or B now;
   - price or venue → playbook C or D (no lever needed: the contracts already
     fail closed and `withdraw` keeps working);
   - a key → playbook E, F or G.
4. Announce to users if their exits are affected (template below). A
   degraded entry needs no user notice.

## Playbooks

Each playbook ends with the exit users keep throughout, because that is what
support will be asked first.

### A. Unannounced privileged change

Trigger: a `critical` alert (see `docs/MONITORING.md`) with no matching
announcement, or a `CallScheduled` nobody filed.

1. Read the transaction. Identify the signer: admin multisig, pauser
   multisig, a timelock proposer, or the deployer EOA.
2. Queued and not yet executed (`CallScheduled`): a timelock canceller calls
   `cancel(id)` on the `TimelockController`. That closes it; file the
   post-incident review on how the proposal got in.
3. Already executed through `DEFAULT_ADMIN_ROLE` or the pauser: assume the
   key is compromised.
   - Pauser: `DEFAULT_ADMIN_ROLE` calls `setPauser(newPauser)` immediately
     (no delay), then the new pauser restores the switches
     (`setProtocolEnabledForClose(id, true)` first, `...ForOpen` second).
   - Admin: the pauser calls `pause()` to stop new entries; the admin
     multisig rotates its signers (`grantRole` to the new multisig,
     `renounceRole` from the old one). A hostile admin can de-list pools,
     retune bounded parameters, replace the pauser and sweep tokens the
     module itself holds (it never holds user funds); it cannot register
     code, move fees or change the operator.
4. Executed through the timelock: the proposer or executor set is
   compromised. Revoke the role on the timelock, then undo the change
   through a fresh 48 h proposal (e.g. `setYieldHandler` back to the
   reviewed build with `scripts/timelockSetYieldHandler.ts`). Meanwhile
   treat the deployed change as playbook B if it touched a handler.

Users keep: every exit. Nothing on the admin or pauser rows can stop
`withdraw`.

### B. Handler compromised or malfunctioning

Trigger: a close or open produces wrong amounts on a real position, a fork
replay of a user transaction shows a defect, or playbook A registered a
handler we did not review.

1. Pauser: `setProtocolEnabledForClose(id, false)` and
   `setProtocolEnabledForOpen(id, false)` for that protocol id, in that
   order (closes off first so no entry can be opened into a protocol it
   cannot leave). This is the one power that delays exits; say so in the
   user notice and give the direct exit.
2. Fix and review the handler. Every contract change gets a dedicated
   security review before deployment, however small (audit final note).
3. Register the fixed build through the timelock:
   ```bash
   TIMELOCK_ADDRESS=0x... PROTOCOL_ID=<id> HANDLER_ADDRESS=0x... MANAGER_ADDRESS=0x... \
   npx hardhat run scripts/timelockSetYieldHandler.ts --network base          # schedule
   # 48 h later, same OPERATION_ID
   EXECUTE=true OPERATION_ID=... TIMELOCK_ADDRESS=0x... PROTOCOL_ID=<id> HANDLER_ADDRESS=0x... MANAGER_ADDRESS=0x... \
   npx hardhat run scripts/timelockSetYieldHandler.ts --network base
   ```
   Registration turns opens for the id off by itself; the pauser re-enables
   them only after the canary (`yarn canary:savings` for protocol 3) passes
   against the new build.
4. Pauser: `setProtocolEnabledForClose(id, true)`. Existing positions still
   exit through the build they are pinned to; if the pinned build is the bad
   one, roll each position with `switchPosition(id, id)` (operator) onto the
   fixed build before re-enabling closes, or tell those users to use the
   direct exit.

Users keep: direct action on their own assets. An LP NFT is owned by the
Safe (decrease and collect at the position manager); sUSDS is in the Safe
(`ACTION=redeem-direct` in `scripts/savingsBySafe.ts` swaps it to USDC at
PSM3 without the module).

### C. Savings oracle outage

Trigger: `ChainlinkSsrRateProvider.rate` reverts (`StaleRate` after 36 h
without a round, `OracleDisagreement` beyond 50 bps against the SSR oracle,
`RateOutOfBounds`, or the SSR oracle itself reverting). Symptom: every
protocol-3 open and close reverts; `ACTION=status` prints the rate as
unavailable.

1. Nothing to flip. The contracts fail closed by design and the exposure is
   zero: sUSDS keeps accruing in the Safe.
2. Tell users exits are available in kind:
   `ACTION=withdraw` (releases the sUSDS record, no price read), then
   `ACTION=redeem-direct` if they want USDC now (PSM3 quote, or their own
   `MIN_USDC_OUT` when PSM3 cannot be quoted). Both work with the feed down
   (`test/scripts/savingsBySafe.ts` pins this).
3. A zero-share record left behind (shares moved out around the module) is
   cleared by a full `close` with any `minUsdcOut`; that path reads no price
   either.
4. If the feed is retired rather than paused, deploy a build with another
   `ChainlinkSsrRateProvider` and roll positions onto it (`switchPosition(3, 3)`
   needs neither oracle nor venue) through playbook B steps 3 and 4.

Users keep: `withdraw` and the direct PSM3 redemption.

### D. PSM3 drained or down

Trigger: `close` reverts inside PSM3's USDC transfer, or `ACTION=status`
shows the pocket near zero; `ExposureCapExceeded` on opens.

1. Nothing to flip. Opens are already capped by the live pocket; closes
   revert inside the venue and change nothing.
2. Tell users their sUSDS is intact and still earning; a close succeeds once
   Spark's ALM refills the pocket, and `withdraw` works now if they prefer to
   hold or move the sUSDS themselves.

Users keep: `withdraw`, and any other sUSDS venue.

### E. Pauser key lost or hostile

Trigger: the pauser multisig cannot sign, or playbook A found the pauser
acting without a ticket.

1. `DEFAULT_ADMIN_ROLE`: `setPauser(newMultisig)`. Immediate, no timelock.
2. New pauser: `setProtocolEnabledForClose(id, true)` for anything the old
   pauser turned off, then opens, then `unpause()` if it paused.

Users keep: every exit; a hostile pauser can only delay them through the
close switch, and only until step 1.

### F. Fees not reaching the treasury

Trigger: repeated `FeeTransferFailed` / `CollectFeeTransferFailed` alerts.
Exits are unaffected: the fee is waived, never allowed to block an exit.

1. Check the treasury address: a contract that rejects transfers, or an
   address USDC has blocklisted.
2. `setTreasury(newTreasury)` through the timelock (48 h). Until it executes
   every exit forfeits its fee; the waived amounts are in the events for
   the books.

Users keep: everything; this one is our loss, not theirs.

### G. Operator key compromised

Trigger: opens, closes or switches nobody at the backend sent, or a leaked
secret.

1. Pauser: `pause()`. Stops opens and switches from the stolen key. It cannot
   stop closes, withdrawals and collects: those return assets to the Safe
   they belong to, floored by the oracle or TWAP, so the damage a hostile
   operator can do is churn (fees and slippage), not theft.
2. Rotate the operator through the registry's timelock:
   `scripts/timelockUpdateOperator.ts` (schedule, 48 h, execute). The 48 h
   gap is the cost of making the operator a critical setting; the pause
   covers entries for that window and the floors cover exits.
3. Rotate the backend secret and the `TESTING_SAFE_OPERATOR_KEY` /
   `OPERATOR_PRIVATE_KEY` env on every host; revoke the old key's RPC access.
4. `unpause()` after the new operator executes and the canary passes.

Users keep: every exit, and `disableModule(manager)` on their Safe if they
want no operator at all.

## User notice template

> **[Product] — [SEV-n] — [short title]**
> Since [time UTC], [what is affected: opening / closing / nothing but
> entries]. Your funds are in your Safe and are not at risk.
> What you can do now: [withdraw in kind / redeem at PSM3 / nothing needed].
> Next update: [time]. Ticket: [link].

Repeat the "funds are in your Safe" line in every update. It is the one
property every playbook preserves, and the one users ask about.

## After the incident

Within three working days: timeline from the watcher log and transaction
links, root cause, what each role did, what the playbook got wrong, and the
list of changes with owners. Any contract change that came out of it goes
through a dedicated security review before deployment and through the launch
checklist (bytecode match, journal, canary) again.

## Drills

Twice a year, rehearse playbooks B and C on a Base fork:
`test/yield/safeYieldManagerSkySavingsFork.ts` and
`test/scripts/savingsBySafe.ts` already script the fail-closed and in-kind
paths, so the drill is the humans and the keys, not the code.

## Contacts and ownership

| Role / decision                     | Who (fill in)      | Reach                | Backup   |
| ----------------------------------- | ------------------ | -------------------- | -------- |
| Declares severity, owns the timeline | TODO               | TODO                 | TODO     |
| Pauser multisig signers              | TODO (n of m)      | TODO                 | TODO     |
| Admin multisig signers               | TODO (n of m)      | TODO                 | TODO     |
| Timelock proposer / executor / canceller | TODO           | TODO                 | TODO     |
| Backend / operator key owner         | TODO               | TODO                 | TODO     |
| User communications                  | TODO               | TODO                 | TODO     |
| Auditor contact (re-review)          | Shred Security     | shredsecurity.io     |          |
