# Security model: custody, fees, and emergency powers

RateHopper's managers are Safe **modules**, not custodians. Every position and
every token belongs to the user's Safe; the module is an executor the Safe has
chosen to authorize. Most of what follows is a consequence of that one fact.

This document records three accepted properties of that design (audit items
I-01, I-02 and I-03) and the decisions behind them.

## I-01 — The performance fee is cooperative, by construction

`SafeYieldManager.closeLp` charges `performanceFeeBps` on realized profit only,
and collects it by asking the Safe to send USDC to the treasury:

```solidity
if (feeUsd6 > 0 && !_trySafeTransfer(params.onBehalfOf, address(USDC), $.treasury, uint256(feeUsd6))) {
    emit FeeTransferFailed(params.onBehalfOf, params.tokenId, feeUsd6);
    feeUsd6 = 0;
}
```

The fee is therefore avoidable in three distinct ways, none of which is a bug:

1. **Exit around the module.** The LP NFT is owned by the Safe. Safe owners can
   call the position manager directly — `decreaseLiquidity`, `collect`, `burn` —
   and realize the same profit without the module ever running.
2. **Disable the module.** A Safe owner can remove the module at any time.
3. **Hold no USDC.** The transfer is best-effort on purpose: a failed treasury
   transfer must never block an exit. If it fails, the fee is waived and
   `FeeTransferFailed` is emitted.

No contract change can close these while the Safe remains non-custodial, and
making the fee enforceable would mean taking custody — a far worse trade. Fee
revenue should be modelled as **cooperative**: it is collected from users who
route through the product, not extracted from users who hold positions.

Path 3 is the one worth monitoring. `FeeTransferFailed` is the signal; a Safe
that repeatedly emits it is realizing profit without paying, and that is a
product/onboarding question (keep a USDC balance) rather than a contract one.

## I-02 — Repayment residue is returned to the Safe (decided: refund)

A debt handler is allowed to decline part of a repayment, and each protocol
declines for its own reason:

| Handler  | Declines when                              | Reason                                |
| -------- | ------------------------------------------ | ------------------------------------- |
| Aave V3  | `amount <= 1`                              | Aave reverts with `InvalidBurnAmount` |
| Fluid    | `repayAmount > -10000` (partial repay)     | `Vault__InvalidOperateAmount`         |
| Moonwell | caps at `borrowBalanceCurrent`             | repaying above the debt underflows    |
| Morpho   | never                                      | —                                     |
| Compound | never (`supplyTo` absorbs the full amount) | —                                     |

The audit offered a choice: document a bounded maximum, or refund the residue.
**We refund.** Documenting a bound is the weaker option because there is no
single bound to document — Moonwell's residue is `amount - actualDebt`, which is
not bounded by a constant — and because residue left in the module is not inert:
the next operation reads `balanceOf(address(this))` and would sweep a previous
user's leftovers into _that_ user's position.

`SafeDebtManager._executeDebtSwap` and `LeveragedPosition._handleCreateCallback`
now transfer any post-repayment `toAsset` / `debtAsset` balance to
`decoded.onBehalfOf`, matching what `_handleCloseCallback` already did. The
resulting invariant is much easier to audit than a table of per-protocol dust
ceilings:

> After any debt operation, the module holds zero of every asset it touched.

`test/debt/debtSwapBySafe.ts` asserts this in `afterEach` for every case in the
suite, across all five protocols.

## I-03 — The pauser can disable exits, but cannot trap funds

The pauser is a single address, set by `DEFAULT_ADMIN_ROLE` via `setPauser`. It
holds `pause`/`unpause` and the two per-protocol switches.

Pausing is deliberately **exit-only**, not a freeze. `closeLp` and `collectLp`
carry no `whenNotPaused` modifier and do not consult the current
`yieldHandlers` registration — they run through the handler pinned at open
time, so a paused or re-registered protocol still lets positions out.

One switch is the exception:

```solidity
function setProtocolEnabledForClose(uint8 protocol, bool enabled) external onlyPauser
```

`closeLp`, `switchLp` and `collectLp` all check `protocolEnabledForClose`. A
pauser can therefore stop module-mediated exits for a protocol. This is
intentional and is reserved for one scenario: **a compromised or malfunctioning
handler**, where letting exits continue would route user funds through code we
no longer trust. Withholding it would mean having no answer at all to a bad
handler.

The power is bounded in the way that matters — it delays exits, it cannot
prevent them. Because the Safe owns the position NFT (the same property behind
I-01), users can always exit directly through the protocol's own position
manager while the switch is off. **No configuration of any role can trap a
position.**

### Operational requirements

- The pauser must be a multisig, not an EOA. It is a liveness risk, not a
  custody risk, but a lost or hostile pauser can still disrupt the product.
- When disabling closes for a protocol, disable opens for it too — otherwise new
  positions enter a protocol they cannot leave through the module.
- Every flip emits `ProtocolStatusChanged`; alert on it.

### Recovery

1. `DEFAULT_ADMIN_ROLE` calls `setPauser` to replace a lost or hostile pauser.
   This does not need the timelock, so recovery is immediate.
2. The new pauser calls `setProtocolEnabledForClose(protocol, true)`.
3. If a handler was genuinely compromised, register a fixed handler before
   re-enabling. Existing positions still exit through their pinned handler, so
   re-registration does not disturb them.
4. In the worst case, `rescueERC721` (`DEFAULT_ADMIN_ROLE`) returns a stranded
   NFT held by the module itself.

`CRITICAL_ROLE` is the timelock and is its own role admin
(`_setRoleAdmin(CRITICAL_ROLE, CRITICAL_ROLE)`), so `DEFAULT_ADMIN_ROLE` cannot
self-grant it and skip the 2-day delay on timelock-only setters.
