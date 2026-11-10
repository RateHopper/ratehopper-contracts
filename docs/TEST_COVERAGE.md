# Savings security regression coverage

This follow-up starts from `4f142557ed0d4b11ec7cd69f39a3dbfa4f5655d5`.
The baseline gate covered 888 of 894 branch outcomes across 13 contracts.
It did not run the operations scripts or the five yield fork suites.

## Verification results

Verified locally in the isolated safeclaw container on November 10-11, 2026:

| Check | Result |
| --- | --- |
| Exact gated coverage suite | 480 passing |
| Gated branch coverage | 893/894, or 99.89%, up from 99.33%; all 13 contracts present |
| Operations-script suites | 108 passing |
| Five yield integration suites | 24 passing |
| Public RPC fallback | 108 script and 24 fork tests passed without an RPC secret; corrected V3/V4 suites rerun with an empty fork cache |
| Real Safe recovery suite, including submitted batch versus preview | 12 passing, included in the script total |
| Repository-wide TypeScript check | 23 pre-existing diagnostics remain; the unchanged baseline had 25. The two canary `Array.at` compatibility errors were fixed. No remaining diagnostics are in the edited files. |
| CI YAML and whitespace checks | Passed |

The one unhit gated branch is `SafeYieldManager.sol:644`. The default
`BaseYieldHandler` hooks listed below remain unexecuted. The unfiltered
repository report is 53.68% branch coverage because this scoped run does not
comprehensively cover the debt contracts. These are measured test results,
not evidence of a completed production migration or signing-gateway test.

## Previously uncovered contract paths

Line numbers below refer to the unchanged Solidity at that commit.

| Location | Outcome | Resolution |
| --- | --- | --- |
| `SafeYieldManager.sol:644` | `_requireProtocolTwapReferences` receives a missing handler | Unreachable through the current public API. `setProtocolEnabledForOpen` checks the same mapping first, without an intervening external call or write. The public rejection test also verifies the protocol remains disabled. The defensive check remains. |
| `UniV4YieldHandler.sol:327` | Native withdrawal amount is zero | New exit test proves wrapping is skipped, unrelated ETH/WETH remain untouched, and the position is released. |
| `UniV4YieldHandler.sol:713` | Non-USDC close delta is zero | New close test proves no router call or spending of pre-existing token balances. |
| `UniV4YieldHandler.sol:792` | Required TWAP reference is missing | Explicit storage fault injection proves close rolls back balances, NFT ownership and accounting; in-kind withdrawal remains available. Public setters already prohibit removing a live reference. |
| `legacy/RatehopperUniV3Positions.sol:937` | Safe transfer returns empty data | New performance-fee return-shape test accepts the non-returning success convention. |
| `legacy/RatehopperUniV3Positions.sol:938` | Safe transfer returns malformed short data | New 1-byte and 31-byte return-shape tests waive the fee and permit the exit. The Safe mock supplies the return data; these tests do not claim an actual fee transfer occurred. |
| `SafeYieldManager.sol:163` | `getMinDelay()` reverts during construction | New constructor test rejects an existing contract with a reverting fallback. |
| `BaseYieldHandler.sol:178,188` | Default restaking hooks | Unreachable in the supported adapters: V3's `_unstakeIfStaked` always returns zero, bypassing restaking; Aerodrome overrides both hooks. Existing unsupported-staking and live-gauge tests cover those supported behaviors. A future staking adapter must supply and test its hooks. |

No production Solidity, storage layout, ignition deployment or legacy contract
was modified. Coverage exclusions and the 95% threshold were not relaxed.

## Operations regressions

- `test/scripts/savingsRecovery.ts` executes the CLI and Safe SDK against a
  local Base fork with a public Hardhat test key. It covers revoked-manager
  withdrawal, stale-oracle direct redemption, approval cleanup, a rejected
  close after revocation, explicit onboarding and bundle preview, trusted
  handler migration, and direct exit with an unusable old handler.
- `test/scripts/checkDeployedBytecode.ts` rejects empty or ambiguous manifests,
  incomplete release configuration, wrong chains, dirty or wrong commits,
  changed feed/age bounds despite matching bytecode, disconnected wiring,
  changed effective savings limits, switches, pool permission and operator.
  Release mode forces compilation before comparing artifacts.
- `test/scripts/canarySavings.ts` covers lost open/close broadcast responses,
  a pending transaction timeout, a receipt read failure, global pause,
  invalid tolerance or deposit amount, and refusal to reopen an existing confirmed position.
  Unknown broadcasts require nonce/receipt reconciliation; a state read alone
  cannot prove that no transaction is pending.
- `test/scripts/checkCoverage.ts` covers every missing gated file, empty and
  malformed reports, truncated or invalid counters, duplicate paths, genuine
  branchless contracts and per-file threshold failure.

## CI execution

`yarn coverage:gated` runs the existing gated contract suites with the new
contract regressions. CI removes any old report first, then runs
`yarn coverage:check`, which requires all 13 expected entries.

`yarn test:scripts` discovers every TypeScript test in `test/scripts`.
`yarn test:yield-fork` discovers all five `safeYieldManager*Fork.ts` suites.
Both use one Hardhat process per file to isolate fork resets and fixtures.
The runner requires `BASE_RPC_URL` pointing to an archive RPC. CI uses the
repository secret when available and otherwise `https://mainnet.base.org`,
matching the existing Hardhat fallback. The public endpoint is rate-limited;
a dedicated archive RPC is preferred for reliability. RPC failures still fail
the tests rather than skip them. LP fork suites run at
block 49,470,000; savings integration and script suites run at 53,100,000.
They use local signers and must not receive production signing credentials.
The V3/V4 manipulation tests explicitly resume the restored block's clock after
snapshot rollback so slow RPC reads cannot turn the subsequent normal close
into an unintended stale-oracle test. Contract freshness limits are unchanged.

CI runs both commands as failing jobs, without `continue-on-error`. Repository
branch protection must require the new `Security tests (scripts)` and
`Security tests (yield-fork)` checks for them to block merging.

Passing these regressions does not establish that every possible execution
path is tested or close unrelated audit findings. In particular, this change
does not add an independent LP mint spot-price versus TWAP guard.
