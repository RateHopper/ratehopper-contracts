# Response to the Shred Security audit (draft report, 2026-09-04)

|                               |                                                                                                                                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Report                        | RateHopper Security Audit Report, Shred Security, draft dated 04 Sep 2026                                                                                                                           |
| Scope reviewed by the auditor | PR #16 (`SafeYieldManager` yield stack, yield handlers, `MorphoDebtHandler`, `SafeDebtManager`) at commit `1493cbc`                                                                                 |
| Remediation branch            | `fix/audit-shred-20260904`                                                                                                                                                                          |
| Remediation commits           | one commit per finding, in report order: M-1 `2c9702e`, M-2 `7605f27`, M-3 `c7f8141`, L-1 `84c3742`, L-2 `ebed99b` (documentation only), L-3 `9e1776f`, L-4 `eba512f`, L-5 `34d526a`, I-1 `e8cb511` |
| Line references below         | as of `e8cb511`                                                                                                                                                                                     |

## Summary

| ID  | Title                                                           | Severity      | Status                       |
| --- | --------------------------------------------------------------- | ------------- | ---------------------------- |
| M-1 | Pool-param delist bricks closeLp / collectLp swap legs          | Medium        | Fixed                        |
| M-2 | MorphoDebtHandler.switchFrom always repays full borrowShares    | Medium        | Fixed                        |
| M-3 | Gauge killed DoS on partial close of staked Aerodrome positions | Medium        | Fixed                        |
| L-1 | closeLp reverts on sub-floor TWAP dust; collectLp skips         | Low           | Fixed                        |
| L-2 | Partial close: liquidity exits while basisForExit == 0          | Low           | Acknowledged, no code change |
| L-3 | V4 native switch residue TWAP key (WETH vs address(0))          | Low           | Fixed                        |
| L-4 | SafeDebtManager flash principal conversion rounds down          | Low           | Fixed                        |
| L-5 | V3/Aerodrome \_chargeCollectFee mishandles empty returndata     | Low           | Fixed                        |
| I-1 | V4 allow-list does not enforce hooks == address(0) on-chain     | Informational | Fixed                        |

No storage layout changed (`YieldLayout` is untouched; only events were added). No external function selector changed. Two events (`RestakeSkipped`, `SwapSkippedBelowFloor`) and one handler error (`HookedPoolsNotSupported`) were added; `MorphoDebtHandler.getDebtAmount` is no longer `view`.

---

## M-1 — Pool-param delist bricks closeLp / collectLp swap legs

**Status: Fixed.**

**Change.** Allow-list membership is no longer required on exit swap legs. `_validateSwapLeg` in both handler hierarchies now checks slippage bounds, pair shape ({token, USDC}), pool existence / initialization and the per-protocol `minPoolLiquidity` floor, but not the allow-list. Opens re-apply the allow-list check explicitly in `_acquireSide`, before `_validateSwapLeg`, so `PoolParamNotAllowed` is still the first error for a bad open leg. `openLp` and `openLpInKind` still validate the LP pool param itself against the allow-list.

- `contracts/yield/handlers/BaseYieldHandler.sol` — `_acquireSide` (:543), `_validateSwapLeg` (:746)
- `contracts/yield/handlers/UniV4YieldHandler.sol` — `_acquireSide` (:472), `_validateSwapLeg` (:763)

**Why this is safe.** The price on every leg is protected by the reference-TWAP floor enforced structurally in `_swapViaSafe` / `_swapV4ViaSafe` (`amountOutMin = max(callerMin, TWAP × (1 − slippageBps))`, `slippageBps ≤ maxSlippageBps`). Whatever pool an exit leg names, the Safe receives at least that floor, which is the same ceiling an allow-listed pool already had under a sandwich. For V4, I-1 (below) means a relaxed exit leg can never reach a hook. A side effect worth noting: the Aerodrome staked-reward swap (`collectLp` with `swapRewardToUsdc`) also no longer needs an AERO/USDC pool allow-listed; it still needs the AERO TWAP reference.

**Tests.**

- `test/yield/safeYieldManager.ts` — "M-1: keeps the USDC exit working after the swap leg's pool param is de-listed" (collect + close succeed after de-listing; an open through the de-listed leg still reverts `PoolParamNotAllowed`); "swaps the claimed stakePool reward to USDC through a pool param that is not allow-listed (M-1)".
- `test/yield/safeYieldManagerUniV4.ts` — "M-1: keeps the V4 USDC exit working after the swap leg's pool key is de-listed".

**Docs.** `docs/SECURITY_MODEL.md` (H-01 section) and `README.md` now state that the allow-list gates opens only.

---

## M-2 — MorphoDebtHandler.switchFrom always repays full borrowShares

**Status: Fixed** (deviates from the recommended `toSharesDown(amount)` in favour of an exact full-close path; see below).

**Change.** `switchFrom` now decides per call:

- if `extraData.borrowShares > 0`, it calls `morpho.accrueInterest` and compares `amount` (what the flash loan delivered and the only thing the repayment can spend) against `borrowShares.toAssetsUp(totals)`;
- when `amount` covers every share it repays by shares (exact, dust-free full close, `repay(0, shares)`);
- otherwise it repays exactly `amount` assets (`repay(amount, 0)`), which is the partial-migration case the auditor described;
- `borrowShares == 0` in `extraData` now works as a plain repay-by-assets (previously Morpho rejected the `0 / 0` call).

The approval is exactly `amount` (previously `amount × 1.01`, which could never be spent anyway) and is reset to zero after the collateral withdrawal as before.

`getDebtAmount` (the quote `SafeDebtManager` uses for `type(uint256).max`) now calls `morpho.accrueInterest` before reading the market totals, the same shape as `MoonwellDebtHandler.getDebtAmount`, and is therefore no longer `view` (`IDebtHandler` already declares it non-view). Without this, a full-close flash sized from the stored totals would fall short by the interest since `lastUpdate` and no longer cover every share once `switchFrom` accrues. `withdraw` with `amount == type(uint256).max` accrues before `_calculateMaxWithdrawAmount` for the same reason. Off-chain readers must use `eth_call` / `staticCall`.

- `contracts/debt/handlers/MorphoDebtHandler.sol` — `getDebtAmount` (:33), `switchFrom` (:58), `withdraw` (:188)

**Why not `toSharesDown(amount)` for every call.** Repaying a full close by a share count derived from `amount` can leave one share of dust and then fail `withdrawCollateral(max)`; repaying by the caller's share count when `amount` covers it keeps the close exact.

**Tests** (`test/debt/debtSwapBySafe.ts`, Base fork, describe "In Morpho"):

- "from market 1 to market 2" — full close, source debt must be exactly 0 afterwards;
- "from market 1 to market 2 with a partial amount" — 50 % debt / 50 % collateral, source debt asserted within 1 % of half;
- "... with a partial amount repaid by assets (no shares in extraData)";
- "... in full after a day of unaccrued interest" — `evm_increaseTime(86400)` before the max close; passes only with the accrual-aware quote.

---

## M-3 — Gauge killed DoS on partial close of staked Aerodrome positions

**Status: Fixed.**

**Change.** `BaseYieldHandler` gained a virtual hook `_stakePoolAcceptsDeposits(stakePool)` (default `true`); `AerodromeYieldHandler` overrides it with `VOTER.isAlive(stakePool)` (`IVoter.isAlive` added; it is a public mapping on the Aerodrome Voter). In `closeLp`, a surviving partial position is restaked only if the pool still accepts deposits. Otherwise the restake is skipped, the stake pin is cleared, and `RestakeSkipped(onBehalfOf, protocol, tokenId, stakePool)` is emitted; the NFT stays on the Safe unstaked and earns trading fees from then on. Because `_stakePoolOf` already treats "owner ≠ pin" as unstaked, every later `collectLp` / `closeLp` / `withdrawLp` takes the normal path with no further special-casing. A restake that fails for any other reason still reverts the whole close, as before.

Opening with `stake = true` on a killed gauge now reverts `StakingNotSupported` instead of the gauge's bare `"GK"`. The gauge withdrawal inside the close still routes the accrued emissions through `_settleStakedReward`, so `feeCollectBps` cannot be dodged through this path.

- `contracts/yield/handlers/BaseYieldHandler.sol` — `_stakePoolAcceptsDeposits` (:182), `closeLp` restake block (:304)
- `contracts/yield/handlers/AerodromeYieldHandler.sol` — `_stake` (:41), `_stakePoolAcceptsDeposits` override
- `contracts/interfaces/aerodrome/IVoter.sol` — `isAlive`
- `contracts/yield/handlers/YieldStorage.sol` — `RestakeSkipped`

**Known limitation.** The module has no re-stake path (only `openLp` stakes). After `RestakeSkipped`, a Safe that re-stakes by hand must also unstake by hand before closing through the module again. This is documented on the event.

**Tests.**

- `test/yield/safeYieldManager.ts` — "M-3: skips the restake and clears the pin when the gauge was killed" (mock gauge armed to revert on deposit, proving deposit is never attempted; subsequent collect and full close succeed); "M-3: refuses to stake into a killed gauge at open".
- `test/yield/safeYieldManagerAerodromeFork.ts` — "M-3: skips the restake on a partial close once governance has killed the real gauge": kills the live Base gauge through the impersonated Voter emergency council, then partial-closes and full-closes through the module.

---

## L-1 — closeLp reverts on sub-floor TWAP dust; collectLp skips

**Status: Fixed** (as recommended).

**Change.** `closeLp` in both handlers now passes `leaveZeroFloorInKind = true` on its two swap legs, matching `collectLp`. A close delta whose TWAP floor rounds to zero stays on the Safe in kind instead of reverting `InvalidSwapAmountOutMin`. Open legs (`_acquireSide`) still pass `false` and remain fail-closed. `currentValueUsd6` measures realized USDC only, so the retained dust is simply not counted as realized value; `minUsdcOut` still applies.

Bound: the floor is zero only when the quoted output is below roughly one USDC unit, so the value left in kind is at most a couple of USDC units per leg per close regardless of token decimals or price.

The skipped swap is now reported by `SwapSkippedBelowFloor(onBehalfOf, token, amount)` (added after internal review) so reconciliation can see the retained token; this event also fires on the pre-existing harvest and reward paths.

- `contracts/yield/handlers/BaseYieldHandler.sol` — `closeLp` (:304), `_swapViaSafe` (:659)
- `contracts/yield/handlers/UniV4YieldHandler.sol` — `closeLp`, `_swapV4ViaSafe` (:636)

**Tests.** "L-1: leaves a close delta in kind when its floor rounds to zero instead of reverting" in both `safeYieldManager.ts` and `safeYieldManagerUniV4.ts` (one-unit residue, no router call, `SwapSkippedBelowFloor` emitted, `PositionClosed` emitted).

---

## L-2 — Partial close: liquidity exits while basisForExit == 0

**Status: Acknowledged, no code change.**

`basisForExit = floor(residualBasis × exitBps / 10 000)` is zero with `liquidityToRemove > 0` only when `residualBasis × exitBps < 10 000`, i.e. `residualBasis < 10 000 / exitBps ≤ 10 000` units, which is less than $0.01 of basis. The basis that can fail to be released this way is therefore bounded by one USDC unit per partial close and by $0.01 in total per position, so the performance-fee overcharge is `performanceFeeBps × $0.01` at most and rounds to zero or one unit.

The recommended revert (`basisForExit == 0 && liquidityToRemove > 0`) would block every partial close on a legitimately zero-basis position. That is a normal state after an in-kind switch whose residue repaid the whole basis (`_settleSwitchResidue` sets `newBasis = 0, carry > 0`; covered by the existing switch tests and the fuzz properties GL-01 / ADV-08 in the report's Appendix B), and charging the fee on 100 % of realized value there is correct, not an overcharge. Rounding `basisForExit` up instead was considered and rejected: it over-releases basis by up to one unit per partial close, the same magnitude in the other direction. The accepted property is recorded in `docs/SECURITY_MODEL.md` (section "Shred September 2026 L-2").

---

## L-3 — V4 native switch residue TWAP key (WETH vs address(0))

**Status: Fixed** (the "require both keys" option from the recommendation).

**Change.** `_requirePoolParamTwapReferences` requires the WETH reference in addition to the `address(0)` reference whenever a pool param's `token0` is the native sentinel. The check runs on every path that admits a pool param: constructor seeding, `setPoolParamAllowed(…, true)` and `setProtocolEnabledForOpen(…, true)`. Because an active reference can never be cleared (`setTwapConfig` rejects `pool == address(0)`), "allow-listed native pool implies both references answer" holds from the moment the param is admitted. The production Ignition module already seeds both keys.

- `contracts/yield/SafeYieldManager.sol` — `_requirePoolParamTwapReferences` (:606)
- `ignition/modules/2_DeployYieldManager.ts` — comment updated; seeds unchanged (WETH, NATIVE, AERO)

**Tests.** `test/yield/safeYieldManagerUniV4.ts` — "L-3: allow-lists a native pool only when both the native and the WETH reference answer" (constructor with native-only seeds reverts `TwapNotConfigured(WETH)`, with WETH-only seeds reverts `TwapNotConfigured(address(0))`, post-deploy `setPoolParamAllowed` on a native-only manager reverts `TwapNotConfigured(WETH)`). The V4 fork fixture was updated to seed both keys, as production does.

**Considered and deferred.** Canonicalizing the reference key itself (`address(0) → WETH` at lookup and store time, single key per asset) would remove the special case entirely, but it changes the documented configuration convention and the deploy seeds; it is left for a follow-up rather than widening this remediation.

---

## L-4 — SafeDebtManager flash principal conversion rounds down

**Status: Fixed** (as recommended).

**Change.** In `uniswapV3FlashCallback`, the principal conversion to the destination asset's decimals now rounds up (`Math.ceilDiv`) exactly like the flash-fee conversion, and both conversions share one branch and one divisor. This only affects the `paraswapParams.srcAmount == 0` auto-sizing path when `fromAsset` has more decimals than `toAsset`; the explicit-`srcAmount` path is untouched. Side effect: `protocolFeeAmount`, which is computed on the converted principal, can be one raw destination-token unit higher.

- `contracts/debt/SafeDebtManager.sol` — `uniswapV3FlashCallback` (conversion block ending :276)

**Tests.** `test/debt/safeDebtManagerRounding.ts` — mock-based: a flash pool placed at the CREATE2 address the production `CallbackValidation` derives, a 1:1 six-to-eighteen-decimal swap that consumes exactly the manager's approval, and two principals (with and without a sub-unit remainder) that must repay the exact flash debt on the 18 → 6 decimal, `srcAmount == 0` path. The Base-fork suites cannot cover this path because no supported pair trades 1:1 across different decimals.

---

## L-5 — V3/Aerodrome \_chargeCollectFee mishandles empty returndata

**Status: Fixed** (the `SafeERC20` option from the recommendation).

**Change.** The treasury skim in `BaseYieldHandler._chargeCollectFee` uses `SafeERC20.trySafeTransfer` instead of a typed `try IERC20.transfer(...) returns (bool)`. Empty returndata from a token with code counts as success; `false`, short returndata or a revert waives the fee and emits `CollectFeeTransferFailed`, exactly as before. Note on mechanism: with the typed call, a no-return token made the caller-side returndata decode fail, and that failure is not caught by `catch`, so the whole harvest reverted after the treasury had been paid; the outcome is the DoS the report describes.

- `contracts/yield/handlers/BaseYieldHandler.sol` — `_chargeCollectFee` (:640)

**Tests.** `test/yield/safeYieldManager.ts` — "L-5: skims the collect fee from a no-return token, and still waives it on a real failure", using a new `MockNoReturnERC20` (USDT-shaped `transfer` with no returndata) as the harvested token. The V3 position-manager mock now pays out through a raw call so a no-return token can flow through it.

---

## I-1 — V4 allow-list does not enforce hooks == address(0) on-chain

**Status: Fixed** (broader than recommended).

**Change.** `UniV4YieldHandler._decodePoolParam` reverts `HookedPoolsNotSupported` when `key.hooks != address(0)`. Every path that acts on a caller-supplied V4 pool param decodes through it: `poolTokens` (reached by the manager's allow-listing and token-whitelist gates), `_validatePoolReady` (opens and swap legs) and `_swapV4ViaSafe`. So a hooked key can neither be allow-listed nor used as a swap route, which is what makes the M-1 relaxation safe on V4. Exits of an existing position read its key from the PositionManager and never decode a param, so no existing position can be stranded.

- `contracts/yield/handlers/UniV4YieldHandler.sol` — `_decodePoolParam` (:732), contract NatSpec
- `README.md`, `contractAddresses.ts`, `ignition/modules/2_DeployYieldManager.ts` — the "hooked pools gated by the allow-list" wording was replaced

**Tests.** `test/yield/safeYieldManagerUniV4.ts` — "I-1: rejects hooked pool keys at allow-listing and on every swap leg" (`setPoolParamAllowed`, a `closeLp` leg and a `collectLp` leg all revert `HookedPoolsNotSupported`).

---

## Additional changes made during internal review

- `SwapSkippedBelowFloor` event (see L-1).
- `MorphoDebtHandler.getDebtAmount` accrual (see M-2).
- `MockVoter.isAlive` / `killGauge`, `MockNoReturnERC20`, and a raw-call payout in `MockNonfungiblePositionManager.collect` (test scaffolding only, never deployed).
- `abis/SafeYieldManager.json` regenerated (`RestakeSkipped`, `SwapSkippedBelowFloor`). Handler-local errors such as `HookedPoolsNotSupported` and `StakingNotSupported` bubble through the manager but are not part of the manager ABI; consumers need the handler ABIs to decode them.

## Verification

| Suite                                                                                                                                                             | Result                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `test/yield/safeYieldManager.ts` + `safeYieldManagerUniV4.ts` + `test/legacy/ratehopperUniV3PositionsMocks.ts`                                                    | 278 passing                                       |
| `test/debt/debtSwapBySafe.ts` — "In Morpho" (Base fork)                                                                                                           | 4 passing                                         |
| `safeYieldManagerAerodromeFork.ts`, `safeYieldManagerUniV4Fork.ts`, `safeYieldManagerSwitchFork.ts`, `safeYieldManagerUniV3Fork.ts` (Base fork, block 49 470 000) | 16 passing                                        |
| `test/debt/safeDebtManagerRounding.ts` (mocks)                                                                                                                    | 2 passing                                         |
| `yarn coverage:gated` + `yarn coverage:check` (CI gate, 95 % branch threshold)                                                                                    | 719 / 734 branches, 97.96 %, all gated files pass |
| `yarn lint:sol`, `yarn format:check`                                                                                                                              | clean                                             |

## Deployment notes

- **Yield stack.** `SafeYieldManager` pins the handler per position at open, so positions opened on the current deployment keep the pre-fix exit code until they are closed or switched; M-1 / M-3 / L-1 / I-1 apply to positions opened through the new manager and handlers. The current manager stays enabled for draining existing positions (the same coexistence model as the legacy module).
- **Debt side.** M-2 is a handler replacement (`setProtocolHandler`). L-4 lives in `SafeDebtManager`, which is constructor-deployed, so it requires a new manager and each Safe re-enabling the module; it can be bundled with the next `SafeDebtManager` release.
- **`minPoolLiquidity`** is zero (disabled) in the shipped Ignition parameters. The exit-leg checks described under M-1 include it only if a non-zero floor is configured.
