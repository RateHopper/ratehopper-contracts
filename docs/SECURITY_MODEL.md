# Security model: custody, fees, and emergency powers

RateHopper's managers are Safe **modules**, not custodians. Every position and
every token belongs to the user's Safe; the module is an executor the Safe has
chosen to authorize. Most of what follows is a consequence of that one fact.

This document records the accepted properties of that design (audit items H-01,
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

## H-01 — Swap floors come from a reference TWAP, never from the caller

`SwapLeg` used to carry an `expectedOut` that the handler checked
`amountOutMin` against. That is not a floor: the same caller supplies both, and
`{amountOutMin: 1, expectedOut: 1}` satisfies it — which is exactly what
`scripts/collectLpBySafe.ts` was doing, because the fee amounts a collect swaps
are not known until it executes.

The handlers now derive the router minimum themselves:

```
minOut = max(caller's amountOutMin, twapQuote(amountIn) * (10_000 - slippageBps) / 10_000)
```

A caller may tighten the bound and can no longer loosen it, and a swap whose
size is only known at execution time simply passes 0. The check sits in
`_swapViaSafe` / `_swapV4ViaSafe`, the single funnel each handler routes every
call through, so it holds structurally rather than by convention.

### The reference is a pool, chosen for history rather than venue

`TwapConfig` maps a token to a Uniswap V3 pool, a window, and a required
`observationCardinality`. It is deliberately NOT the pool a swap executes in:
one reference prices a token everywhere, so an Aerodrome or Uniswap V4 swap is
floored by the same Uniswap V3 observation history. Native ETH has its own
`address(0)` configuration key, whose pool is required to trade WETH/USDC;
quote orientation substitutes WETH before tick math sees the pair.

`TwapOracle` fails closed on every degradation and never falls back to spot — a
fallback IS the attack, since anyone able to degrade the oracle would choose the
degraded path. Three things are checked:

1. **`observationCardinality >= minCardinality`.**
2. **The window is backed by history** — the pool's own `OLD` revert propagates.
3. **The newest observation is recent** (within `window / 4`).

Check 3 is the one that is easy to omit and cannot be replaced by "did
`observe()` revert". A pool with cardinality 1 that has been idle longer than
the window answers happily, because every point in the window resolves after
its single stored observation — so the returned "average" is exactly the live
tick. Measured on Base at block 50197687, four pools behave this way: the
Aerodrome WETH/USDC tickSpacing-200 pool and three Uniswap V3 AERO pools, one
of which holds no liquidity at all.

What check 3 defends is **staleness, not manipulation**. Moving a pool's tick
writes an observation carrying the pre-move tick, so an attacker's own trade
contributes nothing to the average in that block. An abandoned reference is the
real hazard: stuck below the true price, it lets a swap clear a floor beneath
what the input is worth.

### Why `setTwapConfig` is timelock-critical

Repointing a reference changes the price boundary for every managed Safe, so
`setTwapConfig` requires both `msg.sender == timelock` and
`CRITICAL_ROLE`. A `DEFAULT_ADMIN_ROLE` holder cannot make the change directly.
The delay gives operators and Safe owners time to inspect a proposed reference,
while `MIN_TWAP_WINDOW` (1800s), `MIN_TWAP_CARDINALITY` (60), immutable-pair
validation, and a live oracle read prevent the timelock from installing a weak
or unusable configuration. An active key can never be cleared to zero; a new
validated pool replaces it atomically. New pool parameters cannot be
allow-listed, and a protocol's open side cannot be re-enabled, unless every
non-USDC currency decoded by its registered handler has a live reference.
Native ETH checks the `address(0)` key. The close-side emergency switch remains
oracle-independent so it can re-enable `withdrawLp`; close/collect swap paths
still fail closed inside the handlers. If an active reference fails before a
replacement is executed, `withdrawLp` remains available. `twapMinimumOut`
exposes the exact contract-derived floor for operations and deployment
verification.

### `withdrawLp`: the exit that reads no price

Flooring `closeLp` on an oracle would otherwise mean a broken reference strands
a position. `withdrawLp` takes a position out in kind — liquidity and fees as
the pool's own two tokens, no router, no price read — and is gated only by
`protocolEnabledForClose`. It charges no performance fee, for the same reason
`switchLp` charges none: nothing is realized in USDC, so there is no profit to
measure. That does hand users a fee-free exit, which changes nothing
economically given I-01 above.

## M-02 — Switch residue is valued and carried, not forgotten

A concentrated-liquidity mint consumes its two sides only in the ratio the
range demands, so it stops at whichever side runs out. An in-kind `switchLp`
therefore always hands some of the withdrawal back to the Safe. Measured on a
Base fork, that residue is **4.8%–5.3% of the position's basis** (9.55% of the
token0 side across protocols, 2.75% when the range is carried over) — money,
not dust.

Left unaccounted, it is a fee leak with a repeatable exploit: switch, take
profit out as residue, switch again, and close a position that looks
break-even. So the residue is treated as a withdrawal:

```
U        = TWAP value of the residue, in USDC 6dp
newBasis = max(basis - U, 0)
newCarry = carry + max(U - basis, 0)
close    : profit = max(currentValue + carryForExit - basisForExit, 0)
```

Basis is repaid first; only what exceeds it is profit, and that is carried onto
the replacement position in `carryProfitUsd6Of`. Partial closes prorate carry by
`exitBps` exactly as they prorate basis. The invariant the fork tests assert is
conservation — `newBasis + U == previousBasis` whenever the residue is smaller
than the basis.

The valuation uses the H-01 reference TWAP, never spot: spot would let anyone
able to nudge a pool under-report the residue and shrink the fee the eventual
close charges. A switch that redeploys everything reads no price at all, and a
switch that cannot price its residue reverts rather than guessing.

`withdrawLp` releases any carry without charging it, and says so in
`PositionWithdrawn.releasedCarryUsd6`. That is the same fee-free-exit property
as I-01, made visible rather than silent.

## M-01 — No router call is left without a floor

M-01 named the collect fee swap, which shipped `amountOutMin: 1` because the
amount collected is unknowable before the collect runs. H-01's derived floor
removes the whole category: `_swapViaSafe` and `_swapV4ViaSafe` are the only
two places in the handlers that reach a router, both compute the minimum from
the amount actually being swapped, and a caller passing 1 — or 0 — simply gets
the floor.

## I-03 — The pauser can disable exits, but cannot trap funds

The pauser is a single address, set by `DEFAULT_ADMIN_ROLE` via `setPauser`. It
holds `pause`/`unpause` and the two per-protocol switches.

Pausing is deliberately **exit-only**, not a freeze. `closeLp`, `withdrawLp` and
`collectLp` carry no `whenNotPaused` modifier and do not consult the current
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
