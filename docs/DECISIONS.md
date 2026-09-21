# Design decisions

Every choice the spec left open, plus every deviation from it, with the reason. Ordered by build phase.

---

## 1. External dependencies (spec §3.2 — "VERIFY BEFORE USE")

All addresses were checked against the official sources **and** against Base Sepolia itself with `cast` on
2026-09-16.

| Contract | Address | How it was verified | Result |
|---|---|---|---|
| EAS | `0x4200000000000000000000000000000000000021` | `deployments/base-sepolia/EAS.json` inside `@ethereum-attestation-service/eas-contracts@1.9.0`; `cast call version()` | ✅ confirmed, on-chain version `1.2.0` |
| SchemaRegistry | `0x4200000000000000000000000000000000000020` | same package + `cast call version()` | ✅ confirmed, version `1.2.0` |
| Semaphore v4 | `0x8A1fd199516489B0Fb7153EB5f075cDAC83c693D` | `deployed-contracts.json` in `@semaphore-protocol/utils@4.14.3`; `cast call groupCounter()` returned 327 | ✅ confirmed (start block 30526193) |
| SemaphoreVerifier | `0x4DeC9E3784EcC1eE002001BfE91deEf4A48931f8` | same source, code present on chain | ✅ confirmed |
| PoseidonT3 | `0xB43122Ecb241DD50062641f089876679fd06599a` | same source | ✅ confirmed |
| EntryPoint v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | code present on chain | ✅ confirmed (unused — no smart-account path in the MVP) |
| USDC (Circle) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | `cast call symbol()/decimals()` → `USDC` / 6 | ✅ confirmed, but the default is `MockEURC` so the demo can mint freely |

**Local chains** (anvil, Foundry tests) have none of these, so `Deploy.s.sol` deploys its own EAS, SchemaRegistry
and Semaphore when the configured address has no code.

### EAS is deployed from its published artifacts, not recompiled

`EAS.sol` and `SchemaRegistry.sol` pin `pragma solidity 0.8.29`, while this project pins `0.8.24` (spec §13).
Rather than unpinning the compiler for the whole project, local deployments use `vm.deployCode` on the
artifacts shipped in the npm package. That is also closer to production: the bytecode is the one the EAS team
published. Our own resolvers compile against the 1.9.0 `SchemaResolver` base, whose `ISchemaResolver`
interface is unchanged since 1.0 and therefore compatible with the 1.2.0 predeploy on Base Sepolia.

### Foundry remapping quirk

`@zk-kit/lean-imt.sol/` is **not** listed in `foundry.toml`. Foundry strips the trailing slash from a remapping
target that ends in `.sol` (it treats it as a file), producing `node_modules/@zk-kit/lean-imt.solInternalLeanIMT.sol`
and breaking Semaphore's import. Foundry's auto-detected `@zk-kit/=node_modules/@zk-kit/` resolves it correctly.

---

## 2. Stack versions that deviate from the spec

The spec was written against an older snapshot of the ecosystem. Deviations, all deliberate:

| Spec | Used | Why |
|---|---|---|
| Node.js 20 | **Node 22+** (`engines`, CI) | Ponder 0.17 requires `node >= 22`; Vitest 5 requires `^22.12`. |
| OnchainKit | **wagmi `coinbaseWallet` connector** | OnchainKit 1.x requires React 19, which Next 14 (also pinned by the spec) cannot run. The connector still gives Coinbase Smart Wallet + passkeys, which is what §11 actually asks for. |
| — | TypeScript **5.9** | TypeScript 7 is the Go rewrite; Next 14's type-check path is not compatible yet. |
| — | Prisma **7.10** | Latest stable; `prisma@latest` currently points at an 8.0 release candidate. |
| `pnpm lint` (tool unspecified) | **Biome** | One fast binary for lint + format across every package, no ESLint plugin matrix. |
| — | pnpm **12** | Installed version. Dependency build scripts must be allow-listed in `pnpm-workspace.yaml` (`allowBuilds`); `keccak` is denied since its pure-JS fallback is fine. |

---

## 3. Access control

- **One address, one operational role.** `registerNgo` / `registerVerifier` / `registerBankPartner` /
  `addFieldAgent` all reject an address that already holds another role. This makes verifier independence a
  property of the registry rather than something each caller must re-check.
- **An NGO's payout Safe is a role too.** It is recorded in `isPayoutAddress` and may not become a verifier,
  field agent or bank partner, and `isIndependent` treats it as related to the NGO. The spec's formula
  (`verifier != ngo && fieldAgentNgo[verifier] != ngo`) misses the case where a verifier is the address that
  receives the money.
- **`grantRole` / `revokeRole` are restricted to `DEFAULT_ADMIN_ROLE`.** Operational roles must go through the
  registration functions, otherwise an admin could bypass the conflict checks and the field-agent binding.
  Self-service `renounceRole` stays available.
- **NGO profiles are immutable once registered.** There is no `setPayoutAddress`: a compromised admin key could
  otherwise redirect every future tranche release. An NGO that loses its Safe is deactivated and re-registered
  under a new address; open needs get cancelled and refunded.

## 4. Global pause semantics

`RoleRegistry` holds one global pause flag that every other contract consults, instead of each contract being
independently pausable. The rule: **you can always make the system safer, never move it forward.**

| Blocked while paused | Allowed while paused |
|---|---|
| createNeed, createProgram, addMembers | cancelNeed, removeMember (right to erasure) |
| donate, donateOnBehalf, closeFunding, releaseTranche | challenge, resolveDispute |
| openDelivery, confirmReceipt, finalize | revoking a `NeedVerified` attestation |
| new attestations (all five resolvers) | setNgoActive, removeFieldAgent |
| refunds | |

Refunds are blocked deliberately: a pause usually means "we suspect an accounting bug", and the refund path is
the one that moves the most money per call. The admin lifts the pause, or cancels the need and lets donors claim.

## 5. Needs lifecycle

- **Overfunding reverts** (`ExceedsTarget`) rather than being capped, as the spec suggests for clarity. Donors
  see an explicit failure instead of a silent partial donation.
- **`Funding → Pending` is an extra transition** not drawn in the spec's state machine. It is the honoured case
  of §5.2's revocation rule: if a verifier revokes while the need is in `Funding` with zero donations, the need
  loses that verification and goes back to `Pending`. The vault that was already deployed is reused when the
  need reaches its threshold again, so donors can never face two vaults for one need.
- **A rejection cancels the need permanently.** `approved == false` from an independent verifier moves the need
  to `Cancelled`; the NGO must create a new need (with a new dossier) to try again.
- **Program ownership is enforced at need creation** (`beneficiaryGroups.programNgo(programId) == msg.sender`),
  so a need can never point at another NGO's beneficiary group.

## 6. Vault accounting

- **Rounding dust goes to the last tranche** (spec §5.4). `tranche[last] = totalDonated - Σ(previous)`, so the
  tranche plan always covers exactly the donated amount — asserted by a fuzz test and an invariant.
- **Refund shares freeze at cancellation or expiry.** `refund = donatedBy × (totalDonated − totalReleased) /
  totalDonated` is evaluated against values that can no longer change once the need is `Cancelled` or `Expired`
  (donations require `Funding`, releases require `Funded`/`InDelivery`). v2 clears the donor's balance when the
  refund is paid instead of keeping a separate "claimed" flag. Floor division can strand at most one base unit per
  claimant in the vault; that dust keeps the invariant intact rather than being sweepable by whoever claims last.
- **Fiat donations mint no receipt NFT.** The spec allows "partner custody address or skipped". Minting to the
  bank partner would suggest the partner is the donor; the donor is represented by the salted `donorRefHash`,
  and only the partner that deposited a reference can trigger its refund.
- **Payment references are unique per provider, system-wide.** Every ledger calls
  `AidVaultFactory.consumePaymentRef(provider, ref)`, so one bank transfer or card payment cannot be replayed
  against a second need in either custody mode. v2 scoped the key to the provider after review finding F7 (§12).
- **Only standard ERC-20s are supported.** No fee-on-transfer or rebasing tokens (the deployer chooses the token).

## 7. Attestations and resolvers

- **One resolver serves all six schemas (v2).** v1 had one resolver per schema; they shared almost everything,
  and five contracts cost 21.8 KB of bytecode against 14.2 KB for the merged `ProofOfAidResolver`.
- **The resolver derives the UID of every schema it serves** from its own address:
  `keccak256(abi.encodePacked(schema, address(this), revocable))`, the same formula the SchemaRegistry uses, and
  dispatches on it. Without this, anyone could register another schema pointing at our resolver and produce
  attestations the indexer would not recognise while the core contracts still accepted them.
- **`recipient` is enforced**, never a person: the registry for `NeedVerified`, the DeliveryManager for
  `DeliveryEvidence`/`DeliveryVerified`, the need's ledger for `FundingRecorded`/`Settlement`/`ImpactReport`.
- **Expiring attestations are rejected** (`expirationTime != 0`). An "expired" verification that still counted
  toward a threshold would be misleading.
- **refUID builds the evidence chain**: `DeliveryVerified.refUID` must equal the delivery's evidence UID, and
  `ImpactReport.refUID` must equal the `DeliveryVerified` UID of the need's last finalized delivery (or be
  empty for a single-tranche need that had no deliveries). Enforced on-chain, not just by convention.
- **`DeliveryEvidence.regionCode` must match the need's region**, so evidence cannot be filed against a need in
  a different region.
- **`onDeliveryVerified` takes the verifier address** — a deviation from the spec's signature. The delivery
  stores it so independence can be re-checked when the delivery advances, and so the indexer can show who
  signed off without decoding the attestation.

## 8. Deliveries

- **`expectedRecipients` is bounded on both sides**: at least `MIN_EXPECTED_RECIPIENTS` (5, spec §8.2) so a
  confirmation count cannot identify individuals, and at most the program's enrolled member count so an NGO
  cannot inflate the denominator.
- **Confirmations are capped at `expectedRecipients`** and the threshold uses ceiling division, so "70% of 5"
  means 4 confirmations, not 3.5.
- **One challenge per verifier per delivery.** Otherwise a single verifier could keep re-challenging after every
  dispute resolution and stall the tranche forever.
- **A rejected delivery frees its tranche slot**, so the field agent can open a corrected delivery for the same
  tranche. A finalized one does not.
- **Deliveries are bound to the need's `InDelivery` state** at every step, so a cancelled need cannot keep
  accumulating confirmations or be finalized.
- **`cancelDelivery` (admin only) exists because of a liveness hole found in review.** A tranche's slot only
  frees when its delivery is rejected, and a rejection comes from a verifier attestation — which requires
  evidence to review. So a delivery whose field agent vanished before filing evidence would have blocked its
  tranche permanently (funds recoverable only by cancelling the whole need). The admin can now close a delivery
  that is still `Open`. It is deliberately *not* available to the NGO: an NGO could otherwise cancel deliveries
  whose confirmations were lagging and reopen them with a smaller `expectedRecipients` to game the threshold.

## 9. Off-chain stack

- **viem everywhere, no ethers-based EAS SDK.** The spec lists `@ethereum-attestation-service/eas-sdk`, which
  drags in ethers v6 alongside the viem the rest of the project uses. An EAS schema string is just a list of ABI
  parameters, so `@poa/shared` parses it and encodes/decodes attestation data with viem directly, and derives
  schema UIDs with the registry's own formula. A test asserts those derived UIDs equal the ones the on-chain
  SchemaRegistry actually assigned, so the reimplementation is checked against reality rather than trusted.
- **One Prisma schema in `@poa/shared`, exposed as `@poa/shared/db`.** Three services, one Postgres database,
  one generated client — so there is a single `prisma generate` step, and pnpm's isolated `node_modules` cannot
  end up with three schemas overwriting one generated client. The Prisma entry point is a separate export so the
  browser bundle never pulls it in.
- **Prisma 6.19, not 7.** Prisma 7 moves the datasource URL into `prisma.config.ts` and requires driver
  adapters; `prisma@latest` currently resolves to an 8.0 release candidate. The previous stable line keeps the
  setup boring, which is what a hackathon deadline wants.
- **Beneficiary confirmations are relayed by default.** Not just a convenience for people without gas: if a
  beneficiary submitted their own confirmation, their wallet address would sit on-chain next to it, and the
  zero-knowledge proof would protect nothing. The relayer learns the delivery and the timing, never an identity
  (see `docs/THREAT_MODEL.md` §3.5).
- **Region codes are ASCII in `bytes32`** (`bytes32("ES-CM")`), so the chain stores a coarse, human-readable
  subdivision rather than a hash nobody can reverse — and never coordinates.

## 10. Changes made after the adversarial review

An independent review of the contracts (no theft path found; every fund-safety path held) produced seven
exploits with passing proof-of-concept tests. All seven are fixed, and each PoC now fails to reproduce:

| Finding | Fix |
|---|---|
| **Any independent verifier could reject every retry of a tranche, forever.** Rejection is immediate and terminal and needed no admin, making it a *cheaper* veto than the challenge path — which was already rate-limited for exactly this reason. | `hasRejectedTranche[needId][trancheIndex][verifier]`: one rejection per verifier per tranche. Other verifiers can still reject, and the same verifier can still challenge. |
| **Removing a bank partner stranded its donors' refunds permanently** — the only unrecoverable fund-loss path in the system. | `claimRefundByRef` authorizes on ownership of the reference (`refPartner`), not on a live `BANK_PARTNER_ROLE`. The partner that deposited can always return the money. |
| **`renounceRole(NGO_ROLE)` was an irreversible self-brick** that froze every one of that NGO's vaults, with no admin recovery (re-registration reverts, `grantRole` is blocked). | `renounceRole` is blocked for operational roles, consistent with the existing `grantRole`/`revokeRole` hardening. Admins can still step down. |
| **`claimRefundByRef(ref, vault)` broke the §5.4 accounting identity** — `totalRefunded` grew while the self-transfer moved nothing. | Reject `to == address(this)`. |
| **Donations were accepted into a suspended NGO's vault**, which provably could not pay out. | `_checkDonation` requires an active NGO. |
| **An NGO's payout Safe could be another NGO or another NGO's payout**, letting two "independent" organizations share a treasury. | `registerNgo` runs the full conflict check on the payout address too (still allowing an NGO to pay out to itself). |
| **`setStatus` accepted the DeliveryManager**, which never calls it — dead authority that could have walked a `Funded` need to `Completed` without releasing tranche 0, locking the escrow with no refund path. | Only the need's own vault. A documented deviation from the spec's "vault / DeliveryManager only". |

Two further hardening changes came out of the same review: `ImpactReport.beneficiariesServed` must meet the same
k-anonymity floor deliveries do (publishing "2 served" for a known category and region identifies people), and
`minExpectedRecipients` now has an on-chain floor of 5 so no deployment can silently switch the protection off.

The review also showed that `THREAT_MODEL.md` claimed something untrue — that an observer cannot tell whether
the same person appears in two programmes. Semaphore's duplicate check is per group, so a globally-derived
identity would leak exactly that. The doc is corrected and the app derives a separate identity per programme.

## 11. Static analysis

`forge lint` runs on every build. These lints are excluded in `foundry.toml` after review:
`reentrancy-events`, `reentrancy-no-eth` (external calls only ever target trusted system contracts, and every
token-moving entry point is `nonReentrant`), `unsafe-oz-erc721-mint` (receipts use `_mint` deliberately so a
receiver hook cannot re-enter the donating vault), `unsafe-typecast` (every narrowing cast in the packed storage
layouts is bounds-checked at the entry point), `block-timestamp` (challenge windows and need deadlines are coarse
timers), `unused-return` (flagged on deliberate partial destructuring of our own views), `calls-loop` (the only
loop with an external call validates a proof batch bounded by `expectedRecipients`), plus three categories that
are false positives here (`missing-events-access-control`, `uninitialized-local`, `require-revert-in-loop`).

## 12. Contracts v2: closing the gaps with the proposal

The public proposal (proof-of-aid.lovable.app) describes a *NeedClaim* with terms v1 had no place for, a
non-custodial first model (its "Model A"), a five-stage donor view and several integrations. `docs/GAP_PLAN.md`
lists every gap; v2 is the single contract release that closes the on-chain ones.

### Need terms

- **Funding deadline, execution deadline, minimum funding.** `minFundingBps` is the share of the target that must
  be raised for the need to go ahead: 10000 means all or nothing, anything lower allows *partial execution*. There
  is no separate "partial execution" flag because it would be redundant with the threshold.
- **`expire(needId)` is permissionless**, because deadlines protect donors and must not depend on the NGO or the
  admin acting. Pending past a deadline expires. Funding past the funding deadline closes on what was raised when
  that meets the minimum (every tranche scales down by the same factor, since tranches are split by basis points
  of what was actually raised) and otherwise expires with refunds open. Funded or in delivery past the execution
  deadline expires and refunds the unreleased balance.
- **The NGO cannot close funding early below its own minimum**, otherwise closing early would sidestep the terms
  donors were shown.
- **Display-only commitments live in the event.** `category`, `metadataURI`, `expectedOutcomeHash` and
  `costDisclosureHash` are logged in `NeedCreated` but not stored: nothing on-chain reads them, and a log is as
  immutable as storage. This is most of why `createNeed` went from 349,710 to 177,585 gas.
- **Third-party costs are capped and disclosed.** `thirdPartyCostBps` (at most 20%) plus a disclosure hash that is
  required exactly when the cap is non-zero. The resolver enforces the cap *cumulatively*: fees attested on the
  way in (`FundingRecorded`) and on the way out (`Settlement`) together stay within the cap of what donors paid.

### Two custody modes

- **`OnChain` (Model B)** is v1's escrow: an `AidVault` holds stablecoin and releases it to the NGO's payout Safe.
- **`OffChain` (Model A)**: a regulated payment provider, named as the need's `custodian` at creation, holds the
  money. A `NonCustodialLedger` mirrors the vault's rules without holding a token: the custodian's
  `FundingRecorded` attestations count toward the target, and its `Settlement` attestation for a releasable
  tranche is what releases it. Deadlines, thresholds, the tranche split and the three-signal delivery gate are
  identical, because both ledgers extend `TrancheLedger` and `DeliveryManager` only talks to that interface.
- **What the chain cannot know in Model A** is whether the provider really holds or paid the money. That trust is
  explicit (a named, registered custodian, capped fees, per-tranche settlement reports with supplier and FX
  references) and is the trade-off the proposal itself makes for its first phase. See `THREAT_MODEL.md` §3.11.
- **`FundingRecorded` generalizes v1's `FiatDonation`.** For an on-chain need it must match a deposit the provider
  already made (the vault keeps one digest slot per deposit); for an off-chain need it *is* the funding record.

### Settlement

- **A `Settlement` attestation per tranche** records gross (the whole tranche), fee, net, a salted supplier
  reference and an FX reference: the proposal's "Settled" stage, and the reconciliation an auditor needs between
  "released to the NGO" and "reached a supplier". For on-chain custody the NGO files it after the release; for
  off-chain custody the custodian's report is the release.

### Gas and size

Ledgers are EIP-1167 clones with the need id appended to their code (`Clones.cloneWithImmutableArgs`). Every
system address is an immutable of the implementation, so a clone writes no storage at creation and has no
initializer to front-run; calls that reach the implementation directly are rejected. Needs, deliveries, tranche
state, running totals and receipts are packed; confirmations can be batched; the reentrancy guard is transient.
On the same end-to-end flows, v1 → v2: `createNeed` 349,710 → 177,585; `donate` 421,060 → 316,791;
`donateOnBehalf` 389,283 → 257,103; `openDelivery` 214,181 → 164,199; `finalize` 136,604 → 90,806;
`releaseTranche` 111,490 → 78,757. Total runtime bytecode went from 73.0 KB to 77.1 KB: merging the resolvers saved
7.6 KB, but v2 adds a second custody mode and the terms logic.

### Adversarial review of v2

An independent review wrote a passing Foundry PoC for each finding; none allowed theft or broke the accounting
identity. Every fix is locked in by `test/regression/V2ReviewFindings.t.sol`, which replays the original sequence.

| Finding | Fix |
|---|---|
| **F1** Any provider could release another provider's off-chain tranche after recording 1 unit of funding. | The NGO names the custodian at creation; only it records funding or settles. It can still settle after losing its role. |
| **F2** `expire` could beat a delivery that had passed every check but was not yet finalized, and one frivolous challenge near the deadline forced that because dismissal restarted the full window. | Dismissal resumes the time that was left. After the execution deadline, a releasable tranche or a delivery in its challenge window or under dispute holds expiry off for `EXPIRY_GRACE_PERIOD` (14 days). |
| **F3** A tranche nobody could release (absent custodian, suspended NGO) blocked expiry forever. | The hold ends with the grace period. |
| **F4** A need could be verified and funded after its execution deadline. | Funding is open only while both deadlines are ahead; a need still funding at the execution deadline expires instead of closing partially. |
| **F6** The cost cap applied to each fee on its own, so funding and settlement fees could stack past it. | Cumulative cap tracked per need in the resolver. |
| **F7** Payment references were global, so one provider could squat another's with a free off-chain record. | References are scoped per provider in the factory and in the resolver's index. |
| **F5** (design, accepted) An NGO can top up its own need to cross an all-or-nothing threshold. | Not fixable on-chain. It adds no exposure beyond the pre-financing trust every funded need already carries: an NGO that takes tranche 0 and does not deliver could do the same with a need it did not top up. |

## 13. Donor experience and integrations

- **Tracking references need no account.** A wallet donation is tracked by its receipt id, a card or bank donation
  by the salted payment reference hash the provider returns. Neither identifies the donor, so `/track/<ref>`,
  the embeddable widget and the RSS feeds are public.
- **Five stages, each backed by evidence**: Verified = the `NeedVerified` threshold; Funded = funding closed;
  Settled = the first `Settlement` attestation; Delivered = the first finalized delivery; Impact confirmed = a
  live `ImpactReport`. A stage that is partly there (a tranche released but its settlement not yet filed, a
  delivery collecting confirmations) is shown as pending with the reason, never rounded up or down.
- **Alerts without accounts.** The notifier stores an email address envelope-encrypted and destroys its data key
  on unsubscribe; the subscriber holds a token whose hash is all the service keeps. Webhooks and RSS need no
  personal data at all, so they are the default channels; email is delivered through any Resend-compatible HTTP
  API when one is configured, otherwise into an outbox visible to operators.
- **Integrators get HMAC-signed webhooks and CSV import**, the proposal's integration levels 2 and 3, reusing
  the signature scheme the bank webhook already uses.
- **Card and bank giving is a sandbox checkout**: the bank connector simulates the payment provider (fees included,
  capped by the need's disclosure) and runs the same deposit-and-attest pipeline as a real SEPA transfer. No card
  data is ever collected.
- **Sponsored gas is opt-in through `NEXT_PUBLIC_PAYMASTER_URL`.** Coinbase Smart Wallet already gives NGOs and
  verifiers passkey accounts; with a paymaster their transactions need no ETH. No forwarder contract is involved,
  so `msg.sender` role checks are unchanged.
- **Any wallet, not just the passkey one.** Installed wallets are discovered through EIP-6963, so MetaMask, Rabby
  and the rest appear under their own name and icon without this app naming or bundling any of them; the generic
  injected connector is only offered when nothing announced itself. Coinbase Smart Wallet stays first because it
  needs no extension and is the only one that can sponsor gas and bundle approve + donate into one signature.
  Wallets without EIP-5792 simply sign the two transactions in order, and a wallet on the wrong chain gets a
  "Switch to Base Sepolia" button that adds the network if the wallet does not know it.

## 14. Contracts v3: full blockchain mode with conversions

v2 could only take the vault's own stablecoin from a wallet, or fiat through a payment provider that converts
off-chain. v3 lets a donor give USDC, ETH, or card money bought through Coinbase Onramp, and converts it into the
vault token **on-chain, in the donation transaction**, so the conversion itself is as auditable as the donation.

### One token per vault

- **The vault still holds exactly one token (EURC).** Tranches, the minimum-funding threshold, pro-rata refunds and
  the cost cap are all defined in the need's currency; a vault holding a basket would need a price to answer
  "was the target reached?" at every moment. Conversion happens on the way in and nothing downstream changed.
- **Only what fits is converted.** The router says how much input is enough to fill the remaining target at the
  bound (`maxInputFor`); only that much is swapped. The rest goes back in the token it came in, and any surplus
  the swap produced above the target goes back in the vault token (to the calling wallet, or to a deposit
  address's refund route). A need never ends up over-funded, and a nearly full need never exposes a whole balance
  to a swap it does not need.

### The oracle bound (`ConversionRouter`)

- **Swaps run on Uniswap v3 (`SwapRouter02.exactInput`) over admin-set routes, but the minimum output is not
  chosen by the caller.** The router reads Chainlink (EUR/USD for the vault token, USDC/USD, ETH/USD) and requires
  at least `fair × (1 − maxSlippageBps)`, where each route carries its own bound, capped at 5% in code (1% for
  USDC and 1.5% for the two-hop ETH route as deployed). A manipulated pool can make the transaction revert, or
  fill it at the bottom of the bound, but never below it.
- **Output is measured at the recipient**, not trusted from the router's return value.
- **Stale or unsafe prices revert.** Each feed has its own heartbeat (EUR/USD 3 days, because it pauses over forex
  weekends; USDC/USD 25 hours; ETH/USD 1 hour). On mainnet the L2 sequencer uptime feed is checked, with a 1-hour
  grace period after a restart, as Chainlink recommends for L2s. WETH is priced through the ETH/USD feed.
- **Routes are fixed paths set by the admin** (USDC → EURC in the 0.05% pool on mainnet; ETH → WETH → USDC →
  EURC). Nobody can pass a path, and a route's middle tokens must be one of the hubs fixed at deployment (USDC,
  WETH), so not even the admin can route a donation through a token it controls.
- **Changing what money is waiting on takes two days.** Replacing a price feed or a route, loosening a bound, or
  changing or removing the sequencer check is scheduled by the first call and executed by an identical call
  after `CONFIG_DELAY` (2 days, within a 7-day window, cancellable). Donors with money on a deposit address see
  the `ConfigChangeScheduled` event and can take it back first. First-time configuration of a token nobody could
  convert yet, and tightening a route's bound, apply at once.

### Conversion cost counts against the cost cap

- **The conversion fee is `fair − received`**, attributed pro rata to the part actually donated, and the vault
  reports it to the resolver (`recordConversionFee`), which adds it to the need's funding fees under the same
  cumulative cap as provider and settlement fees (§12). A swap that beats the oracle costs nothing.
- **Consequence:** a need that disclosed no intermediary costs (`thirdPartyCostBps = 0`) accepts a converted
  donation only when it costs nothing, and a need near its cap can reject a large one. That is the intended
  reading of the NGO's disclosure, and the app offers EURC or bank giving in that case.

### Three ways in

- **Wallet, direct (`DonationForwarderFactory.donate`).** Any wallet gives USDC or ETH; the factory converts and
  calls `AidVault.donateVia`, crediting the caller with the donation and a soulbound receipt exactly like
  `donate`. With Coinbase Smart Wallet, approve and donate go out as one sponsored batch.
- **Card, through Coinbase Onramp.** Coinbase's terms require the buyer to own the destination wallet, so the
  on-ramp cannot deliver into a vault or to an address the platform controls. It delivers USDC to **the donor's own
  smart wallet** (passkey, created in the flow), and the donor then makes the one-tap donation above. The session
  token is requested server-side with a CDP key; the JWT is signed with `node:crypto` rather than the CDP SDK or
  OnchainKit (which requires React 19, §2). Coinbase Onramp does not deliver on test networks, so on Base Sepolia
  and anvil a mock on-ramp mints test USDC to the donor's wallet and everything after that is the real path.
- **Exchange withdrawal, through a deposit address (`DonationForwarder`).** An exchange can only send to an
  address, so the donor gets one that commits to an *intent*: the need, who gets the receipt (optional), where
  refunds go, a refund key, and a salt. The address is a CREATE2 clone whose immutable args are the intent, so it
  is known before it exists and cannot be deployed with different terms. Anyone can deploy it, but only the
  intent's own wallets or a keeper registered by the admin (the app's relayer) can sweep it: a permissionless
  sweep can be wrapped between two swaps in a single transaction, no mempool needed. What it donates is credited
  to the deposit address itself unless a receipt wallet was given, so the vault's by-reference refund ledger holds
  its claim under `bytes32(uint256(uint160(depositAddress)))`, a key the vault refuses to hand over if another
  depositor already owns it.
- **Refunds from a deposit address** go to the committed `refundTo`, or wherever the refund key signs for
  (EIP-712, per-clone domain, with a nonce so each signature works once). The key is generated in the donor's
  browser and downloaded; it never reaches a server. Money sitting unswept can always be taken back by the donor, and by anyone once the need stops accepting
  (it can only go to the committed refund address).

### Test networks

- **Base Sepolia has real Uniswap v3 and Chainlink USDC/USD and ETH/USD feeds, but no EUR/USD feed, and its
  public pools are thin and mispriced.** The deployment uses the real `SwapRouter02`, WETH and feeds; mocks only
  what is missing: EUR/USD (a fixed mock, hence a one-year heartbeat), MockUSDC (so the mock on-ramp can mint it),
  and a MockUSDC/MockEURC pool (0.01% tier) that `SeedLiquidity.s.sol` creates on Uniswap at the oracle price
  with deep full-range liquidity. The deploy refuses to put mocks anywhere but anvil and Base Sepolia. The mocks are freely mintable, so anyone can push that pool's price; donations then revert
  on the oracle bound until `pnpm deploy:sepolia liquidity` swaps it back. ETH donations are off there (no WETH
  liquidity against the mocks).
- **anvil** uses a mock swap router that fills at the mock oracle rates minus 0.05%.
- **The real thing is tested against Base mainnet** in `test/fork/BaseMainnetConversion.t.sol` (Circle USDC and
  EURC, Uniswap's pools, Chainlink's feeds and the sequencer feed): 500 USDC had a fair value of 435.75 EURC and
  donated 435.48 (0.28 conversion cost); 0.05 ETH, fair 106.09, donated 105.97. The whole Base Sepolia deploy and
  demo scenario were dry-run on a local fork of Base Sepolia before broadcasting: 2,000 USDC, fair 1,851.69 EURC,
  donated 1,851.50; a 2,467 USDC deposit address filled the rest of the need with 2,344 USDC and sent 122.97 USDC
  and 21.47 EURC of surplus back.

### Adversarial review of v3

An independent review wrote a passing PoC for each finding (a constant-product pool for the sandwiches, a Base
mainnet fork for the fee tier); none broke the vault identity or allowed reentrancy. Each fix is replayed by
`test/regression/V3ReviewFindings.t.sol`.

| Finding | Fix |
|---|---|
| **1** (High, admin key) Setting a fake EUR/USD feed and a route through the admin's own token took almost all of a 50,000 USDC deposit, with a recorded fee of 0. | Middle hops limited to hubs fixed at deployment; replacing feeds or routes, loosening bounds and touching the sequencer check wait `CONFIG_DELAY` (2 days). |
| **2** (Medium) `sweep` was permissionless, so one transaction could front-run, sweep someone else's deposit address and back-run, pushing every conversion to the bottom of the bound (220 USDC on 50,000). | Only `receiptTo`, `refundTo` or a keeper can sweep; per-route bounds let the stable pair run tighter. |
| **3** (Medium) A nearly full need converted a whole balance, and the fee on the donated sliver rounded to zero, so even a zero-cost need accepted a sandwiched conversion and the donor got EURC back 1% below fair. | Convert only `maxInputFor(remaining)`; return the rest unconverted; round the fee up. |
| **4** (Low/Medium) The default USDC route used the 0.01% EURC/USDC pool, which is empty on Base: conversions reverted, and a squatter could place liquidity just inside the bound. | Default fee tier 500; the fork test uses the liquid pool; the deploy refuses mocks on mainnet. |
| **5** (Low) Refund signatures had no nonce, so a retraction signature could be replayed on a later, real deposit. | Nonce in both typed structs, incremented on use. |
| **6** (Low) `donateVia` overwrote a reference key a payment provider already owned. | Refused with `DonorRefPartnerMismatch`, as `donateOnBehalf` does. |
| **7** (Info) `forwarderAddress` returned addresses for intents that could never be deployed. | It validates the intent first. |

Accepted, documented in `THREAT_MODEL.md` §3.14: oracle error adds to the bound (EURC is priced at EUR/USD, and
feeds move only past their deviation threshold); vault refunds are paid in EURC; anyone can create a deposit address
that credits a receipt to someone else's wallet (a public link between a wallet and a need, with no rights
attached).

## 15. Contracts v4: the vault pays the suppliers, and it holds dollars

Until v3 a released tranche went to the NGO's payout Safe, and what happened next was a `Settlement`
attestation the NGO itself wrote. A donor could prove the money left the vault and that someone said it reached
a supplier — not that it did. v4 moves that step on-chain: **an on-chain need carries a payment plan, and its
vault pays the plan directly**.

### The plan

- **A plan is one to five payees, each with a share of every tranche in basis points**, fixed when the need is
  created and verified with the rest of it (`NeedsRegistry.CreateNeedParams.payees`). Every tranche's shares
  must sum to exactly 10,000, and a payee that never receives anything is refused: a plan is complete by
  construction, and "who gets this money" is answerable before a single donation arrives.
- **Payees are registered suppliers** (`SUPPLIER_ROLE`, granted by the admin against a credential hash and a
  public profile URI), with one exception: **the zero address means the NGO itself**, resolved at payment time to
  its registered payout Safe. An NGO must therefore disclose what it keeps, and that share is capped at
  `MAX_NGO_SHARE_BPS` = 25% of the need (Σ trancheBps × share, so partial funding scales it but never changes
  the ratio). The cap is on the sentinel only — the protection against an NGO paying itself through a "supplier"
  is the role separation below, not arithmetic.
- **One address, one role, for the address's whole history.** `RoleRegistry` refuses to register a supplier that
  is an NGO, a payout Safe, a verifier, a payment provider or a field agent — and, since the v4 review, one that
  *ever was* (`everHeldRole`). Removing a field agent and re-registering it as an "independent" supplier was the
  way around the NGO cap. Re-granting the same role after a removal is still allowed.
- **Off-chain needs (Model A) have no plan and must not carry one.** Their custodian holds the money and attests
  what it paid; the plan is a property of on-chain custody.

### Paying it

- `releaseTranche` releases the tranche as before (the three independent signals of §3.2 are unchanged), then
  splits it by the plan and transfers each share. Rounding dust goes to the last payee, so a tranche is paid out
  to the unit.
- **A transfer the token refuses does not block the others.** Stablecoin issuers can freeze an address; a refused
  transfer is *held* for that payee (`heldPaymentOf`, `totalHeld`) and `claimHeldPayment` — permissionless,
  and it only ever pays the payee — delivers it when the address can receive again. The accounting identity
  carries the term: `balance + totalReleased + totalRefunded == totalDonated + totalHeld`.
- **A need that still owes a held payment is not Completed.** Completed is terminal, and reporting it would close
  the refund, expiry and payee-change paths on money that never left the vault. The need finishes when the last
  held payment is delivered, or when verifiers move it to a replacement payee.
- **Replacing a supplier takes the NGO plus independent verifiers.** The NGO proposes (`proposePayeeChange`),
  and the change applies on the approval that reaches `payeeChangeApprovalsRequired`: the need's own
  verification threshold, but never fewer than two. A tranche that is already releasable cannot be redirected —
  releasing it is permissionless, so a supplier that did the work is paid first — unless the current payee has
  lost its role, which is exactly the case a replacement exists to unblock. Held money follows the replacement.
- **On-chain custody must name a delivery deadline.** Without one, a plan that cannot be paid (a removed
  supplier) could never be expired, and donors had no permissionless way back at all.

### The vault currency is USD

v3 held EURC and converted everything into it, including USDC bought with a card. Base's own stablecoin is USDC,
so that meant the most common donation was the one that paid a swap.

- **A deployment holds one currency, and by default it is the chain's USDC.** The deployer requires a price feed
  for whatever the vault holds (USDC/USD or EUR/USD) and sets a route only for the *other* stablecoin. A donation
  in the vault's own currency is a pass-through: no pool, no price, no cost, and a need that allows no
  intermediary costs can accept it.
- **Euros and ETH still convert** under the same Chainlink bound (§14), and ETH now needs one hop instead of two.
  A euro-denominated deployment is still supported and is what the contract fixtures and the Base mainnet fork
  test exercise.
- **Every published figure is in the vault currency**, and the app derives each token's symbol from the
  deployment (`vaultCurrency`, `donationTokens`) rather than assuming one.

### Adversarial review of v4

A second independent review (payment plans only) wrote a passing PoC per finding; none broke the vault identity,
allowed reentrancy, or exceeded the NGO cap through the plan, the change flow or rounding. Each fix is replayed
by `test/regression/V4ReviewFindings.t.sol`.

| Finding | Fix |
|---|---|
| **F-1** (Medium) A tranche a supplier had already earned could be redirected: after the delivery was confirmed and before the permissionless `releaseTranche`, the NGO and one verifier could swap the payee and pay someone else. | The deciding approval reverts (`ReleasePending`) while a tranche of a payee that can still be paid is releasable. A payee that lost its role is exempt, so a blocked need can still be unblocked. |
| **F-2** (Medium) "One address, one role" was checked against live state only, so an NGO's former field agent could be registered as an independent supplier and take what the 25% cap bounds. | `everHeldRole` remembers, in both directions; the same role can still be re-granted. |
| **F-3** (Medium) With no execution deadline, removing a supplier froze the vault forever: `releaseTranche` reverted on the plan and `expire` reverted `DeadlineNotReached`, leaving only an admin cancellation. | On-chain custody must name an execution deadline, so expiry — and with it refunds — is always reachable without an admin. |
| **F-4** (Low) A held payment on the final tranche was stranded: the need went Completed in the same call, and Completed closed cancellation, expiry, refunds and payee changes. | Completion waits until nothing is held, and an approved replacement inherits the held payment. |
| **D-1** (Design) Any independent verifier could apply a change alone on a need that took one verification. | Two independent approvals always, even on a single-verifier need. |
| **D-4** (Design) `_payPlan` had no `payee != address(this)` guard, unreachable today but load-bearing for the identity. | Refused with `InvalidPaymentPlan`. |
| **D-5** (Coverage) The invariant run never produced a held payment, so the `totalHeld` term and `claimHeldPayment` were never fuzzed. | The invariant's token can be frozen by an issuer action, and the handler freezes and unfreezes payees; entitlement (paid + held) is what the proportion invariants check. |

Accepted and documented in `THREAT_MODEL.md` §3.15: the admin's vetting is what makes a supplier independent;
a change has no cooling-off period for donors (unlike `ConversionRouter`'s two days); and a plan may be changed
while a need is still Pending, so consumers must replay `PayeeChanged` rather than trust `NeedCreated`.

## 16. Taking a donation back (v5)

Until now money could only leave a vault forward, to the payment plan, or back as a **pro-rata refund** once a
need was cancelled or expired. That is the right rule for money that is already committed — an NGO orders goods
against the escrow and the plan's suppliers are named on chain — but it made a mistimed or mistaken donation
irreversible for weeks. `AidVault.withdrawDonation(receiptId, amount)` closes that gap at the only point where
nothing is committed yet: while the need is still raising.

### The rule

- **Only while funding is open.** The call reverts once `fundingClosed` or the need has left `Funding`: from
  that moment the tranches are fixed and the plan's suppliers are entitled to them. Reaching the target closes
  funding in the same transaction as the donation that reached it, so there is no window after a need fills up.
- **Only the receipt's owner, and only their own money.** The withdrawal names a receipt; `DonationReceipt.reduce`
  refuses unless the caller owns it, which is also the authorization check. It is bounded by both the receipt's
  amount and `donatedBy[msg.sender]`, so one receipt can never drain another donation.
- **Not in the final stretch.** `WITHDRAW_LOCK_PERIOD` (2 days) before the funding deadline, withdrawals stop.
  Without it a large donor could sink an all-or-nothing need at the last second, after the NGO had already
  committed to suppliers on the strength of the raise. A need with no funding deadline raises until its target,
  so it has no window to protect and none is applied.
- **A withdrawal cannot break a published promise.** The cost cap is a statement about what donors paid, and a
  donation that is in the vault when a fee is recorded is part of what keeps it true. The vault mirrors
  `ProofOfAidResolver._checkCostCap` against the post-withdrawal figure and refuses with `FeeExceedsDisclosure`
  when taking the money out would push the recorded costs over the cap the NGO disclosed.
- **The receipt is lowered, never burned.** A receipt states what a donation *currently* stands at, so leaving it
  claiming money the donor took back would make the most visible artefact in the system a lie. The token stays
  (it is the tracking reference), its amount falls, and the pair of events — `Donated`, `DonationWithdrawn` —
  remains the full history.
- **Wallet donations only, for now.** Money deposited by a payment provider or sitting in `donatedByRef` is not
  withdrawable this way: a different party holds the claim. Deposit addresses already have a better answer —
  money that has not been swept can be pulled back at any time.

`_totalDonated` is no longer monotonic, which is the change everything downstream had to absorb: the accounting
identity still holds (balance and donated fall together), the invariant suite now fuzzes withdrawals alongside
freezes and releases, and the indexer keeps both figures on the donation row (`amount` net, `withdrawn`) rather
than deleting a row and erasing a fact.

### What was deliberately not built

- **Withdrawing after funding closes.** The NGO has ordered against that escrow. Failure after that point is what
  tranches, the delivery gate, the execution deadline and pro-rata refunds are for.
- **A donor-initiated dispute** that freezes releases mid-delivery. It is the honest answer to "something went
  wrong later", it reuses the existing challenge machinery, and it is a separate feature.
