# Adding a yield handler

`SafeYieldManager` is the one Safe module users enable. Every protocol behind it
is a **stateless handler** the manager reaches by `delegatecall`, registered
under a `uint8` protocol id. This is the checklist for adding one, whether it is
a new LP venue or a new savings source. The yield stack's invariants are in
`SECURITY_MODEL.md`; read H-01 (floors) and I-03 (exits) before starting.

## Two shapes

| Shape | Base | Hooks you implement | Examples |
|---|---|---|---|
| Concentrated-liquidity LP (NFT on the Safe, two pool tokens, swap legs) | `BaseYieldHandler` (`V3StyleYieldHandler` when the venue speaks Uniswap V3's interfaces) | pool resolution, pair decoding, `slot0`, swap and mint calldata, `positions` decoding | `UniV3YieldHandler`, `AerodromeYieldHandler` |
| LP whose mechanics do not fit the V3-shaped hooks | `IYieldHandler` + `YieldStorage` directly | the whole `IYieldHandler` surface | `UniV4YieldHandler` |
| Savings source (USDC in, a share token out, no pool, no NFT) | `BaseSavingsHandler` | `_shareToken`, `_poolParamMatches`, `_depositUsdc`, `_redeemShares`, `_liquidityAvailable` | `SkySavingsYieldHandler` (protocol 3) |

A savings source needs a price source as well: an `ISavingsRateProvider` build
(`ChainlinkSsrRateProvider` for sUSDS) that the handler pins as an immutable.

## Rules every handler must keep

- **Stateless.** No storage variables. Shared manager state is read through
  `YieldStorage._yieldStorage()` and never written by a handler; a handler that
  needs its own records opens an ERC-7201 namespace keyed by protocol id, as
  `SavingsStorage` does.
- **Delegatecall only.** Every external entry point carries `onlyDelegatecall`
  (`address(this) != __self`), so a direct call runs against nothing.
- **The Safe moves the tokens, never the manager.** Every venue interaction goes
  through `ISafe.execTransactionFromModuleReturnData` with `Operation.Call`, an
  immutable target and a selector the handler chose. No `transfer` or `approve`
  call sites outside `abi.encodeCall`; every allowance granted is reset before
  returning. Inside a delegatecall `address(this)` is the manager, so a direct
  token call would move the manager's tokens.
- **Floors are never the caller's word.** LP handlers floor every swap on the
  manager's reference TWAP (`TwapOracle`); a savings handler floors deposits and
  redemptions on its pinned rate provider and measures Safe balance deltas,
  trusting nothing the venue claims. `slippageBps` is bounded (manager
  `maxSlippageBps` for LP legs; the savings tolerance ceiling for sources).
- **`poolTokens` tells the manager what to whitelist.** It is called by
  staticcall, must be `view` or `pure`, and every non-USDC token it returns needs
  a live TWAP reference before a pool param can be allow-listed. A source with
  no pool reports `(USDC, USDC)` and documents its own floor in
  `SECURITY_MODEL.md` (see "Protocol 3 prices from Chainlink, not a pool").
- **`withdraw` must work when nothing else does.** No price read, no swap; an LP
  handler still calls the position manager to pull liquidity out in kind, a
  savings source does not even touch its venue. A broken oracle must never
  strand a Safe.
- **`configure` is optional.** Tunables live in the handler's namespace and are
  set by the admin through `SafeYieldManager.configureHandler`; bound them with
  constants and emit an event. A handler with nothing to tune reverts
  `ConfigureNotSupported`.
- Custom errors, events on every state change, step codes in a range of their
  own so a `ModuleCallFailed(step)` points at one Safe call.

## Steps

### 1. Reserve the id and pin the addresses

- `contracts/common/Types.sol`: add `YIELD_PROTOCOL_<NAME> = <next id>` (append
  only; ids are plain `uint8` end to end).
- `contractAddresses.ts`: add the venue addresses, the `YieldProtocol` entry and
  an `encode<Name>PoolParam` helper. The pool param is ABI-encoded bytes that
  pins the venue and the pair (or the share token); the manager allow-lists
  `keccak256(poolParam)` and callers pass the same bytes.

### 2. Implement

- Pick the base from the table and implement its hooks. Validate every wiring
  argument in the constructor (zero addresses, venue immutables agreeing with the
  pinned ones, bounds on tunables) so a misdeployed build cannot be registered.
- Give the handler's Safe calls their own step-code range (V3-style and
  Aerodrome handlers use 21-37, Uniswap V4 up to 74, Sky savings 80-85, the
  mock source 90-95; take the next free range from 100).
- A savings source's rate provider must answer at construction
  (`_rateProvider.rate(share)` is called), so a dead feed fails the deploy, not
  the first user.

### 3. Mocks and tests

- Mocks in `contracts/mocks/` mirror the venue's real ABI (return shapes, the
  arguments it validates, its revert strings) so unit tests prove the calldata.
- `test/yield/safeYieldManager<Name>.ts`: the full flow through the manager
  (open, close partial and full, collect or its refusal, withdraw, switch,
  guards, fee math). When a base is shared, parametrize the suite over a second
  mock source so the base is proven generic (`SOURCES` in
  `test/helpers/savingsHarness.ts`).
- Rules test (`test/yield/savingsSourceRules.ts` for sources; add the equivalent
  for a new base): scans the source for transfer or approve call sites outside
  `abi.encodeCall`, `_yieldStorage()` writes, and `onlyDelegatecall` on every
  entry point, then runs the zero-residue check with the Safe already holding
  the tokens involved.
- Invariant walk over several Safes with a seeded random step mix.
- Base-fork suite against the REAL venue (`test/yield/safeYieldManager<Name>Fork.ts`):
  `hardhat_reset` to `BASE_FORK_BLOCK_NUMBER ?? <recent block>` in `before`,
  `clearSnapshots()` around the reset (network-helpers keeps a module-global
  fixture registry), a fresh manager with the handler seeded in the constructor,
  `deployRealSafe` + `enableModuleOnSafe`, `dealToken` for USDC. Prove the
  venue's own events and quotes, the floor reaching the venue's `minAmountOut`,
  the fail-closed paths and the in-kind exit.
- Coverage gate: add the production files to `GATED` in
  `scripts/checkCoverage.js` and the suites to `coverage:gated` in
  `package.json`; the threshold is 95 % branches and new files are expected at
  100 %. Run `yarn coverage:gated` then `yarn coverage:check` alone (coverage
  rewrites `artifacts/`, a parallel hardhat run zeroes it).

### 4. Deploy

**New manager** (the shared API changed, or a fresh stack): add the handler to
`ignition/modules/2_DeployYieldManager.ts` (its `m.contract`, the protocol id,
handler, pool params and floors in the manager constructor arrays, env or module
parameters for its tunables, a TWAP seed for every non-USDC side of its pool
params). Dry-run against a local forked node (`npx hardhat node`, then
`--network localhost --deployment-id <tmp>`); the in-process `--network hardhat`
simulation cannot be used. Always pass `--deployment-id`.

**Existing manager** (one deployed from this API generation: the manager
delegatecalls handlers by selector, so a handler built from this branch cannot
run on a manager that still speaks `openLp`/`closeLp`; the script below refuses
such a manager):

1. Deploy the handler (and its rate provider) with its own Ignition module or
   `hardhat run`, verify on Basescan.
2. `scripts/timelockSetYieldHandler.ts`: schedule
   `setYieldHandler(protocol, handler)` through the TimelockController, wait
   `getMinDelay()` (48 h on Base), execute. `setYieldHandler` checks
   `PROTOCOL()` and code, then turns opens for the id off: a first registration
   starts with both switches off, a replacement build keeps closes on.
3. If a pool param needs a non-USDC reference, `setTwapConfig` goes through the
   same timelock first.
4. Pauser: `setProtocolEnabledForClose(protocol, true)` (first registration),
   then `setProtocolEnabledForOpen(protocol, true)` after looking at the build.
   Nothing of the new build runs before this step, `configureHandler` included.
5. Admin: `scripts/setPoolParamAllowed.ts` for each pool param (`PROTOCOL_NAME =
   "sky"` for the savings source); for a source,
   `scripts/configureSavingsHandler.ts` if the constructor defaults need
   retuning.
6. Rolling a build under an id already in use is the same `setYieldHandler`,
   the pauser re-enabling opens, then `switchPosition(id, id)` per position (in
   kind, no price read for a savings source).

### 5. ABIs, addresses, downstream

- `scripts/exportAbis.js`: add the handler (and provider) so `abis/` carries the
  events and slot views the backend decodes.
- `deployments/base.json` is written by `scripts/syncDeploymentAddresses.js`
  from the Ignition journal (`IGNITION_DEPLOYMENT_ID`).
- Downstream, in order: operator-key-signing policy (manager address and
  selectors), monorepo backend (ABI copies, encoders, handler build registry,
  `check:contract-authority`), frontend.

### 6. Documents

- `SECURITY_MODEL.md`: a subsection for any new price source, trust assumption
  or exception to the TWAP rule.
- `README.md` section 7 and `CLAUDE.md` "Yield Handlers": one bullet each.

## Checklist

- [ ] id in `Types.sol`, addresses and encoder in `contractAddresses.ts`
- [ ] handler (and provider) with constructor validation, step codes, events
- [ ] mocks faithful to the venue ABI
- [ ] unit, rules, invariant and real-venue fork suites green
- [ ] `GATED` + `coverage:gated` updated, gate run alone
- [ ] Ignition module or registration run book executed
- [ ] `exportAbis.js`, `deployments/base.json`, downstream repos
- [ ] `SECURITY_MODEL.md`, README, CLAUDE.md
