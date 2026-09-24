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

## 17. What an NGO may say, and what the chain says back

Three schemas are registered with **no resolver** (`RegisterCommunitySchemas.s.sol`). Nothing on-chain reads
them and no money depends on them, so they are open by construction: anyone can attest one. What makes them
mean something is the indexer, which applies the rules the chain deliberately does not.

| Schema | Who may write it | What it is |
|---|---|---|
| `NeedPresentation` | kept only from the need's own NGO | cover image, gallery, summary, tags — the crowdfunding-style face of a need |
| `WorkPhotos` | kept only from the need's own NGO | images of finished work, published against a need |
| `SupplierApplication` | kept only when the applicant signs for itself | a public request to be registered; grants nothing |

- **Presentation never overrides terms.** It renders *above* the terms panel, never inside it. The target,
  tranche plan, deadlines, cost cap and payment plan were fixed and verified at creation; a picture and a
  sentence cannot move them, and publishing a new presentation replaces only itself.
- **Links, not uploads.** The images stay wherever the NGO hosts them; the attestation carries the URLs and the
  signature. The indexer keeps only `https://` and `ipfs://` links, caps how many it stores, and the app renders
  them with `referrerpolicy=no-referrer`. Photos are of goods, sites and deliveries — this system never puts a
  beneficiary in a picture.
- **Two badges on every need card**, recomputed from events rather than awarded: "photos of the work", and the
  share of everything that NGO ever released that reached the payees its plans named (below 100% means a payment
  is still held because a token refused it). Nobody can buy either one, and neither can be revoked by us.
- **Applications are a queue, not a role.** `SUPPLIER_ROLE` remains an admin decision, because "independent of
  the NGO" is a judgement the chain cannot make (§15, THREAT_MODEL §3.15). What the chain adds is that the
  request, and who signed it, are public and dated.

A deployment that predates these schemas simply has no `communitySchemas` entry, and every panel that would
write one hides itself.

## 18. Receipts a donor can file (US, phase 1)

A soulbound receipt already proved that a donation happened. What a US donor actually needs at tax time is
narrower and stricter, so this release makes the receipt carry it — without pretending the chain can decide
anything it cannot.

**What the law asks for, and who can answer it**

| Requirement | Who satisfies it |
|---|---|
| The donee is a qualified organisation under §170(c) | the organisation, off-chain; a register says so |
| A contemporaneous written acknowledgment for $250+ | the **donee**, in writing, stating amount, date and whether anything was given in return |
| Non-cash reporting: Form 8283 above $500, a qualified appraisal above $5,000 | the donor, with the donee signing Section B |

Crypto is **property**, not cash, so every donation here is a non-cash contribution and those thresholds apply.
Nothing in this system can make a contribution deductible; what it can do is make the evidence complete and
checkable.

**Two more resolver-less schemas** (§17 explains the pattern):

- `OrgTaxStatus(org, jurisdiction, taxId, legalName, source)` — the organisation states its standing. When the
  **platform admin** signs the same schema for that organisation, the indexer marks it verified and records
  *where* they checked, because a chain cannot read a tax register but it can record who says they read it. A
  restated claim clears the previous check: what was checked was the old text. The number published is the
  organisation's public registration number (an EIN for a US 501(c)(3)) — a donor's tax number is never asked
  for anywhere in this system.
- `DonationAcknowledged(receiptId, needId, documentHash, statement)` — the donee signing for one donation,
  kept only when the need's own NGO signed it. The statement is the acknowledgment sentence itself and the hash
  is its keccak256, so a document downloaded months later can be checked against what was signed.

**The document is built in the donor's browser.** Their legal name and address are typed into the page and used
only to render the PDF: no server sees them, nothing is stored, and nothing about the donor goes on chain. The
document states the amount, date, transaction, the need, the receipt token, the donee's signed acknowledgment
and its attestation, the organisation's standing and whether anyone checked it — and then says plainly that it
is not tax advice and that deductibility depends on the donor's own circumstances.

**The reviewer never has to trust this document.** Every figure in the receipt is restated as a link to a
block explorer, which is a third party with no stake in the claim. The first of them opens the receipt token
itself: the explorer names the wallet holding it, renders the metadata the token carries on chain — the need,
the amount, the date — and lists the mint. Because the token is soulbound (ERC-5192; every transfer but the
mint reverts) the holder cannot have bought it, so *whoever holds it is the wallet that paid*. The rest of the
links open the "Read Contract" tab of the receipt and of the vault, where `ownerOf`, `receiptOf`, `locked`,
`donatedBy` and `totalDonated` can be called by anyone without a wallet or an account. The document says
plainly that an explorer's rendering of token metadata is a cache and that `receiptOf` is the figure of
record — which matters after a withdrawal, since the receipt is reduced rather than burned and the reduced
amount is the deductible one.

**Deliberately not claimed.** The app never says "tax-deductible". A need shows the organisation's registration
number and whether it was checked; a donor decides with their accountant. An unverified claim renders as the
organisation's own statement, in grey, next to the words *(unverified)*.

**Still to come** (phase 2 and 3, §16 has the contract cadence): recording USD fair market value and the
Chainlink round at donation time rather than reconstructing it, a Form 8283 prefill with the appraisal warning
above $5,000, a Form 8282 disposition export built from the payment events (a vault that pays suppliers is
disposing of donated property within three years, which the organisation must report), and a fiscal-sponsor
mode where the recipient of record is a US 501(c)(3) and the field NGO is a payee in the plan.

The wording of the acknowledgment and of the receipt has **not** been reviewed by a US tax professional. That
review is a release gate before this is offered to a real donor.

## 19. Money that waits (idle capital, v6)

A need whose deliveries run over a year holds escrow that nobody can spend yet. Until now it sat still. It can
now wait in an ERC-4626 vault instead — Morpho's curated vaults on Base are the intended venue, and coupling to
the standard rather than to Morpho keeps the choice reviewable and replaceable.

**Only the window where the money genuinely cannot move.** Deployment is refused until funding closes. While
funding is open a donor can call `withdrawDonation` at any moment (§16), and money that can be recalled has no
business in a lending market. That one rule removes most of the complexity: the withdrawal path and the sleeve
can never race each other.

**Donors are repaid principal, never yield.** A refund is computed from what was donated and released, never
from the vault's balance, so nothing the venue does changes what a donor is owed. This is not only tidiness: a
donor credited with yield has received income, which would make the receipt in §18 wrong.

**The accounting identity grows four terms and still closes.**

```
balance + deployedPrincipal + totalReleased + totalRefunded + lossRealised
    == totalDonated + totalHeld + yieldRealised - yieldPaid
```

Principal is tracked at cost — what the vault put in — never as `convertToAssets`. Yield never enters
`totalDonated`, which drives the cost cap, the refund pro-rata and every donor's `shareBps`.

**Liquidity is a rule, not a hope.** Money a payee could claim this instant never leaves: the deployable amount
excludes held payments and every tranche a verified delivery has already unlocked. Beyond that, `releaseTranche`,
`claimRefund`, `claimRefundByRef` and `claimHeldPayment` each pull back from the venue before paying, and refuse
to pay a part of a tranche while the rest is still lent — a supplier paid late is a problem, a supplier paid a
part while the rest sits in a lending market is a worse one. Being short with *nothing* lent is a different
thing: that is a loss the need has already taken, and the held-payment path carries it honestly.

**Who decides.** One venue per deployment, the platform admin's to approve, with a cap in basis points; never an
address an NGO picks. A need opts in through its NGO while it is still `Pending` — before it can take a single
donation — because this changes what a donation is exposed to and that belongs on the page beforehand, not
switched on over the heads of people who already gave.

**What the NGO sees.** The NGO console opens on its campaigns and, for the long ones (at least 90 days between
funding closing and the delivery deadline), lists Morpho's listed USDC vaults on Base with live net APY, size and
what can be withdrawn right now, plus what the campaign's waiting escrow could earn in each — an upper bound, since
tranches leave as deliveries are verified. It is market information, not a choice: the list is sorted by
withdrawable liquidity because escrow has to come back the day a tranche is due, and money still only goes to the
venue approved on chain. On a test network the rates are Base mainnet's and the approved venue is a mock.

**Where the earnings go.** To the NGO, once the need is over and the position is closed, under its own event. A
loss is charged against them first. If a loss exceeds everything earned, the need is short the difference and
says so: `SleeveLoss` is on the timeline and on the need page, because a need that lost donors' money has to
state it.

**What a position being "closed" means.** Value, not share count. Redeeming everything a venue will part with
routinely leaves a share or two behind worth nothing, and a position that can never be called closed is one
whose loss is never recognised and whose earnings can never be handed on. The tests found this; it is why
`previewRedeem(balanceOf) == 0` is the test rather than `balanceOf == 0`.

**Still to come.** A first-loss reserve absorbing before the need's budget, a keeper that deploys after close and
unwinds ahead of each tranche rather than relying on the on-demand pull, more than one venue with per-venue
caps, and an allowlist that expires rather than persists — a vault approved in 2026 is not the same vault in
2028.

## 20. Every donation goes on chain (cash paths retired)

The platform used to take money three ways: tokens from a wallet or an exchange, a card through the Coinbase
on-ramp, and card or bank payments taken by a payment provider — which either deposited the net into the vault
(`donateOnBehalf`) or, for off-chain custody (Model A), held the money itself and attested every movement. The
third is gone. A card now reaches a need one way only:

```
donor's card ─► Coinbase Onramp ─► USDC in the donor's own wallet ─► one tap ─► AidVault
```

**Why not straight into the vault.** Coinbase's terms require the buyer to own the destination address, so the
on-ramp never pays a vault or a deposit address. The donor's wallet can be a Coinbase Smart Wallet created with a
passkey — nothing to install, no seed phrase — and the approve and donate are one batched signature. The USDC sits
in a wallet the donor controls for as long as it takes them to tap, and nowhere else.

**What was removed.** The card/bank panel, `/api/checkout`, the bank-connector service (SEPA webhook, checkout
sandbox, CSV imports, provider settlements) and its two database tables, the off-chain custody choice and the
custodian picker in the need form, the payment-provider flows in the demo, and the bank partner and off-chain need
from the seed. The on-ramp's cost-cap gate went too: it dated from v3, when card USDC was swapped into EURC and
the swap was a cost the need had to allow. The vaults hold USDC, so card money goes in as it is and costs the need
nothing; Coinbase's own fee is between the donor and Coinbase, paid before the USDC exists.

**Then the contracts (v7).** The first pass left them alone, so the retired paths stayed deployed and a demo key
still held the bank-partner role. v7 removes them: `donateOnBehalf` and the deposit digest a `FundingRecorded`
attestation was matched against; the `FundingRecorded` schema, so the resolver serves five; off-chain custody —
`NonCustodialLedger`, the custodian, and the `CustodyMode` choice between them, since one option is no choice; the
factory's payment-reference registry; and `BANK_PARTNER_ROLE`. `Settlement` keeps its on-chain branch, the NGO
reconciling a tranche the vault already paid.

Refunds by reference stay, because deposit addresses use them: a deposit address that credits itself, when the
donor gave no wallet, is recorded under its own address as the reference, and `claimRefundByRef` is how it gives
the money back. The guard against another party owning a reference first stays too, though only a forwarder can
write one now. The indexer, API, notifier payload and app lose the custody field, the provider fields on a
donation (`paymentRefHash`, gross, fee, currency, its attestation), the custody filter and `/providers`; a
tracking reference is a receipt id or a deposit address, nothing else.

**Consequences worth knowing.**
- On mainnet the on-ramp is live with CDP API keys; on testnets Coinbase cannot deliver, so a sandbox mints test
  USDC. There is no card path at all on a deployment without either.
- Every donation is now a digital-asset gift for tax purposes, card included: the card buys USDC before anything
  is given. For a US 501(c)(3) that means Form 8283 above $500, as the receipt already says. For a Singapore IPC
  it means **nothing given here is deductible** — IRAS allows cash and a short list of assets, not tokens — so the
  deduction notice no longer appears for one (`OFFERED_CHANNELS` in `taxEligibility.ts`), and the receipt tells
  a Singapore donor to give to the organisation directly if they want the deduction.
- A donor who paid by card has a receipt and a wallet like any other donor, so refunds and withdrawals go back to
  that wallet. There is no refund by payment reference to administer.

## 21. Donors approve each tranche (v8)

Until v7 every tranche after the first waited for three independent signals: evidence filed by the NGO's field
agent, anonymous Semaphore confirmations from enrolled beneficiaries, an independent verifier's sign-off, then a
challenge window. It was thorough, and nobody could run it: an NGO created from the app had no field agent, no
enrolled beneficiaries who could prove anything, and no verifier assigned to its deliveries, so its money stopped
at tranche 0. The user's call: something simpler, where the people who paid decide.

**How it works now.** Once a tranche has been paid, the NGO accounts for it: photos of the work, supplier receipts,
bank statements and a note. The app stores each file under its SHA-256 (photo metadata stripped first); the NGO
signs a manifest listing the files by hash with `DeliveryManager.submitEvidence`, which keeps the manifest's hash
and emits its text. Donors to the need read it on the need page and approve it with `approve`. When donors who
gave **30% of the raised amount** have approved, the next tranche becomes releasable in the same transaction, and
anyone can release it to the payment plan's suppliers as before.

**Weighted by money, not by wallets.** A donor's say is `AidVault.donatedBy` — what their wallet gave, frozen once
funding closes. One donor, one vote would let anyone split a gift across a hundred wallets; weighting by amount
makes a vote cost what it claims to represent. A deposit address that credited itself (no wallet given) counts
towards the raised amount but cannot vote.

**Who has no say.** The NGO, its payout address and every payee of the need, however much they gave: they would be
approving their own accounts. The rest of the escrow's guarantees are untouched — payees are still registered,
vetted suppliers, the NGO's own share is still capped at 25%, and a need whose donors never approve still expires
at its deadline and refunds what was not released.

**New evidence starts from nothing.** Filing again replaces the evidence under review and discards its approvals:
donors approved what they saw. The NGO can correct a mistake; it cannot keep old approvals for new documents.

**What went.** Field agents and their role; Semaphore receipt confirmations and the relayer that submitted them;
the verifier's delivery sign-off; the challenge window and admin-resolved disputes; the `DeliveryEvidence` and
`DeliveryVerified` schemas (the resolver serves three); the evidence service, which encrypted bundles for a
verifier to open. Verifiers still verify needs before funding opens and still approve supplier changes. Programmes
stay, so a need still states who it serves; enrolment is no longer needed to deliver.

**What it costs.** Anonymity no longer does the work: the evidence is public, to every donor, so it is the NGO's job
to black out account numbers, names and faces before uploading, and the upload form says so. A staged photo and a
forged receipt still hash perfectly well; what stands against them is donors with money at stake reading the
documents, and 30% of them having to agree. Donor apathy is the new failure mode — a legitimate NGO can stall if
nobody looks — and its remedy is the donor's own interest: alerts when evidence is filed, and a refund at the
deadline if it is never approved.

**Still to come.** Pinning evidence files beyond this app's server (IPFS or object storage; the hashes on chain
would not change), a "flag" for donors who object rather than only approvals that never come, and letting an NGO
choose a higher threshold per need.


## 22. Rules a need chooses, votes that can say no, and an admin that has to wait (v9)

v8 made the donors the judges of every tranche. v9 keeps that and fixes what a review of it found: the admin was a
single key, donors could only say yes, the evidence lived on one server, every change to the rule meant a new
deployment, voting cost gas, and the unused Semaphore groups were still on chain.

**The rule is a policy the need picks.** `DeliveryManager` stays the ballot box and the evidence log; the rule —
who has a say, what each say weighs, how much agreement approves or rejects — moved into `IReleasePolicy`
contracts. A need names one when it is created (`CreateNeedParams.releasePolicy`, zero for the platform default)
and keeps it for life: the admin approves and withdraws policies for *new* needs only, so the rule donors were shown
is the rule their money is released under. Three built-ins ship, one `ReleasePolicy` contract configured three ways:
*donors decide* (the default: 30% of the money approves, 50% rejects), *a verifier checks* (as many independent
verifiers as verified the need, so two for a high-value one), and *donors and a verifier* (both must approve;
either can reject). A new kind of rule is a new policy contract and an admin approval, with nothing redeployed and
no existing need affected. We chose this over upgradeable proxies on purpose: a proxy would let the admin change
the rules under money already in escrow, which is exactly what the escrow exists to prevent. The limit is stated
plainly: a policy answers questions about donors and verifiers; a rule that needs a new kind of voter needs a new
ballot box.

**Donors can reject, and the NGO gets one second chance.** `reject(deliveryId)` weighs like `approve`. Rejecting
takes more agreement than approving (half of the money, against 30%) because it can end the need: the first
rejection sends the NGO back to file better evidence; the next cancels the need (`NeedsRegistry.onEvidenceRejected`)
and every donor can claim back what was not released — nothing is releasable at that point, since evidence is only
filed once the previous tranche has been paid. Strikes count per need. Replacing evidence someone already rejected
costs the same second chance, and is refused once it is spent: otherwise an NGO watching rejections pile up could
re-file just before they land and never be rejected at all. Replacing uncontested evidence (a wrong file) stays free.
The retry count is a policy parameter (`REJECTION_RETRIES`, 1).

**Votes are free.** `voteBySig` takes an EIP-712 `Vote(voter, deliveryId, approve, deadline)` signature, checked with
OpenZeppelin's `SignatureChecker`, so a passkey smart wallet (ERC-1271) signs as well as a plain key. No nonce is
needed — a voter votes once per delivery — and the deadline keeps an old signature from being played in later. The
app signs in the browser and `POST /api/relay/vote` checks the signature and simulates the call before its relayer
pays for it. Setting `NEXT_PUBLIC_PAYMASTER_URL` (a Coinbase Developer Platform paymaster) makes every other
transaction from a Smart Wallet free as well; the code for it was already there.

**The admin has to wait.** `Handover.s.sol`, the last deployment step, creates a Safe (canonical v1.4.1 factory) and
an OpenZeppelin `TimelockController` whose only proposer is that Safe and whose executor is anyone, gives the
timelock `DEFAULT_ADMIN_ROLE` and has the deployer renounce it. Every admin action — registering an NGO, a verifier
or a supplier, approving a release policy or a yield venue, cancelling a need — is then signed by the Safe's
threshold and waits out a public delay (10 minutes on the testnet, two days by default) before anyone executes it;
the Safe can cancel it meanwhile. A new `GUARDIAN_ROLE` can pause at once and do nothing else; unpausing goes
through the timelock. On the testnet the Safe is 2-of-3: the user's wallet, the deployer and demo account #6, and
`pnpm admin` signs with the last two. `SeedDemo` and `RegisterNgos` run before the handover, while one transaction
still suffices.

**Evidence outlives the server.** With `PINATA_JWT` set, `/api/uploads` pins every file to IPFS and the manifest
carries its CID next to its SHA-256; the file link carries the CID too, so `/api/files/<sha>` fetches the file back
from IPFS when its own copy is gone, and serves it only if it hashes to what the chain committed to. Without a key
nothing changes: files stay on the app's server and the manifest has no CID.

**A deposit must be worth what it cost.** `deployIdle` is permissionless, so anyone could call it at the moment a
venue's share price is being pushed up (a donation to an empty ERC-4626 ahead of its first deposit): the vault would
get too few shares and the difference would go to whoever pushed. It now refuses shares worth less than the deposit
beyond 0.1% of rounding (`DepositShortfall`).

**Semaphore is gone.** Nothing read programme membership since v8, and a beneficiary is safest nowhere on chain at
all. `BeneficiaryGroups` became `ProgramRegistry`: a programme is an NGO, a hash of its published eligibility rules
and a description, and needs still point to one. Enrolment lives only in the NGO's encrypted PII vault, whose
`commitment` field is now the NGO's own reference for a household.

**Not done, on purpose.** The 30% threshold is still a share of everything raised, including money that has no vote
(the NGO's own gifts, a deposit address that credited itself); a need where most of the money cannot vote can
therefore stall until its deadline. It was left out of this release by choice and is the next thing to change.

## 23. People who post their own needs (v10)

Until v9 only an NGO could post a need, and a beneficiary existed nowhere on chain. v10 lets a person an NGO supports
post a need of their own — rent arrears, a medical bill, school costs — and run it: they receive its tranches in
their own wallet and account for each one with evidence, exactly as an NGO does. What the NGO adds is its word that
this person is one of its beneficiaries.

**The NGO's list stays private; the NGO signs a certificate.** Each NGO keeps its beneficiaries in its own records
(the PII vault), never on chain. For a wallet it has certified, it signs an EIP-712 `Certification` — this wallet, in
this programme of ours, from `issuedAt` until `expiresAt` — and sends the beneficiary a link carrying it. The link is
no bearer credential: `BeneficiaryRegistry.createNeed` only accepts it from the wallet it names. Nothing reaches the
chain until that person posts a need, which is their own choice to appear; from then on their wallet is public, next
to the NGO that certified it, and nothing else about them is. We chose this over a public registry of every NGO's
beneficiary wallets, which would have listed people who never asked for anything, and over a Merkle root, which
adds an update transaction per change without hiding more than signatures do. Smart-wallet NGOs sign through
ERC-1271. What "certified" requires the NGO to have checked is deliberately left for a later certification scheme;
it can tighten what an NGO must do before it signs without touching needs already posted.

**Withdrawing a certification.** `revoke(wallet)` voids every certificate the NGO issued for that wallet until now;
a later one works again. It is the one step that writes a wallet on chain without its owner choosing to, so the app
defaults certificates to 30 days (365 at most) and tells the NGO to prefer letting them expire. A posted need is not
touched by a withdrawal: its money is escrowed under the terms donors saw. Its NGO can still withdraw it until funding
closes, like one of its own.

**The need is an ordinary need with a different owner.** `NeedsRegistry` records the beneficiary (`beneficiaryOf`)
and answers `ownerOf` (the beneficiary, else the NGO) and `ownPayoutOf` (their wallet, else the NGO's payout Safe).
Everything the owner does moved from "the NGO" to "the owner": closing funding, filing evidence, replacing a
supplier, opting into idle capital, the Settlement attestation, receiving the yield. Independent verifiers still
attest the need before it can raise a cent (two above the high-value threshold), the release policy still judges
every tranche after the first, and rejections still cancel and refund. The need stays under its NGO: its programme,
its standing — a suspended NGO freezes its beneficiaries' needs exactly as it freezes its own. It has no impact
report: the resolver refuses one (`ImpactReportNotApplicable`). A report states how many people a need served, with
a five-people floor so the count identifies no one; a need a person posted for themselves serves one household, so
any honest count would identify it, and its donors have already approved the receipts for every tranche. A donor's
tracker shows "Impact confirmed" as not applicable on such a need, and the need is done when its last tranche is paid. `BeneficiaryRegistry` is a separate
contract, and the only caller of `createBeneficiaryNeed`, because `NeedsRegistry` had 3.3 KB left under EIP-170.

**The whole tranche can be the beneficiary's.** An NGO keeps at most 25% of a need for itself and pays the rest to
vetted suppliers. For a beneficiary the own share *is* the aid, so it has no cap; the plan may still name registered
suppliers to be paid directly (a landlord, a pharmacy). The protection that replaces the cap is the tranche: only
the pre-financing is paid before any evidence exists, and each later tranche waits for the donors (or verifiers) to
approve how the last was spent. That only holds if the pre-financing is not the whole need, so a beneficiary's need
has at least two tranches and the first is at most half (`MAX_BENEFICIARY_FIRST_TRANCHE_BPS`, reverting with
`BeneficiaryPrefinancingTooLarge`) — enough up front for rent that is already due, with the rest behind evidence.
Found in the final review: without it a single 100% tranche paid everything before any proof.

**Nobody judges their own account.** A wallet that holds or ever held an operational role (NGO, verifier, supplier,
payout Safe) can never post as a beneficiary (`RoleRegistry.holdsOperationalRole`). The reverse cannot be enforced
at registration — the role registry does not know who posted needs — so it is enforced where it matters: the
beneficiary is never independent of their own need (verification, supplier changes) and never has a say on its
evidence, and neither does the NGO that certified them.

**One open need per beneficiary.** A certificate is not a licence to post a stream of needs for verifiers to wade
through: the next one can be posted once the last is completed, cancelled or expired.

**Where it shows.** The NGO console gains *Certify a beneficiary* (sign, copy the link — too long for a QR code) and
*Withdraw a certification*. `/apply` reads the link, checks the network, the connected wallet, the certificate's
standing on chain and the one-open-need rule, then shows the need form in beneficiary mode. `/beneficiary` is the
per-need dashboard an NGO has, for the needs the person posted; the NGO sees them in its own list, marked as run by
the beneficiary, with only what stays the NGO's. Need cards and pages say who runs the need, and the payment plan
shows the own share as the beneficiary's wallet. The indexer credits payments to that wallet to the plan's own share,
accepts work photos and presentations from whoever runs the need, and filters `/needs?beneficiary=`.

**Not done.** The certificate says nothing about what the NGO checked (see above). The PII vault does not store
wallets or certificates yet: the NGO keeps track of whom it certified itself. A beneficiary must pay gas for their
own transactions unless the paymaster is configured.

## 24. The problem in the news (v10 app)

A donor looking at a need for water in Castilla-La Mancha reads what the NGO says, and sees on chain what happened
to the money; nothing tells them whether the region really has a water problem. The need page now shows recent news
about the problem the need addresses: up to six articles, each a link to the article with its outlet, date, a short
summary and, where the article has one, its own picture.

**What is searched for.** The need's category and its coarse region, both already public on chain, and nothing else —
not its description or presentation, which could say something about a person. The region is named the way news
names it: Spain's autonomous communities by name, in Spanish and English; any other ISO code falls back to its
country. The category becomes a few keywords per language (water: drought, water shortage, drinking water; sequía,
escasez de agua, agua potable). A need is searched in the language of its place, where most of its news is written,
and in the reader's as well when that differs; an article in the other language says so.

**Where from.** Bing News and Google News, read as RSS: no key, no account. Google is the better search — its boolean
query holds to the place — but its links go through a redirect that ends at a consent page, so its results come
without a preview. Bing links to the article itself, so the server reads that page's Open Graph tags for the picture
and summary. Both are searched and merged, one copy per story. GDELT, the open research index, refused every request
from our network. Both feeds' terms allow personal, non-commercial use: fine for this project, but a deployment beyond
it should swap in a licensed news API, in `app/src/lib/server/news.ts`.

**What counts as on topic.** Search engines match anywhere in a page, and Bing does not even hold to the quoted place,
so a raw search is mostly the region's other news and other regions' news of the same problem. An article is kept
only if its title or snippet names both the problem and the place — the region in either language, or one of its
provinces or main cities — matched as whole words, accents aside. A few phrases that use a keyword for something
else are left out (a hunger strike is not a food shortage). A mention in the title counts for more, a result with a
preview edges ahead of one without, no outlet gets more than two, and nothing is older than a year.

**How it is fetched.** On the server, streamed into the page after everything else, so a slow news site holds nothing
up; cached for three hours per region and category; and with the address checks of THREAT_MODEL §3.24, because the
server fetches pages whose addresses a third party chose. `NEWS_SEARCH=off` turns it off.

**Not done.** Region names outside Spain's communities (the country is searched instead). Relevance is keywords, not
understanding: expect the odd article that mentions both the problem and the place and is about neither. An NGO
cannot pin or hide an article.

## 25. Proof from anyone, and rewards an NGO pays for it (v10)

Everything a donor sees about a need's delivery comes from the people who run it: the NGO's evidence, the NGO's
photos, the beneficiary's own. Someone who watched the water tanks arrive at the school — a teacher, a neighbour, a
passer-by — had no way to say so. Now any wallet that does not run a need can file proof on its page: photos and a
line on what they show. And an NGO can set money aside, from its own wallet, to pay the people whose proof is useful.

**A contract of its own.** `CommunityProofs` sits beside the registry and only reads it: a need's status, its NGO, its
owner and their payout wallets. `NeedsRegistry` has about 2 KB left under the size limit, and nothing here needs to
change a need.

**Who may file, and what.** Any wallet except the need's NGO, the NGO's payout wallet, the beneficiary who posted it
and the beneficiary's payout wallet: their proof would only repeat their own evidence. Proof opens once the need is
funded (Funded, In delivery, Completed); before that there is nothing on the ground to photograph. Photos go through
the same upload as delivery evidence — location and camera data stripped, each file committed by hash — and are
listed in the same manifest format, which the contract emits in full. No photos of people, as for work photos.

**What it does not do.** Proof decides nothing. It releases no tranche, casts no vote and is not evidence: tranches
still move only on the evidence the need's rule approves (§21, §22). It is context a donor can weigh, from someone
the NGO does not control.

**The pot.** An NGO opens one pot per need at a time: a reward per proof, how many rewards (1 to 1,000) and for how
long (1 to 365 days). `reward × count` moves from the NGO's wallet into the contract when the pot opens, so what the
page promises is there; donors' money is never touched. The NGO pays proof one at a time. The contract allows one
reward per wallet per need, across pots, and only for proof filed before the deadline. Closing returns the balance to
the NGO. After the deadline anyone can close a pot, and the balance still goes to the NGO, so none is left hanging.
A pause stops new proof, new pots and payments, but not closing: an NGO can always take its money back.

**Why the NGO chooses.** Paying automatically would pay for any photo from any wallet, and wallets are free: a
hundred photos of nothing from a hundred wallets would empty a pot. Only the NGO knows what useful proof of its need
looks like. The cost of that choice is that an NGO could reward only flattering proof, so every proof stays public
whether or not it was paid, and the page shows which were. An NGO chooses what it rewards, never what donors see.

**Where it shows.** A "Community proof" section on the need page: the open pot, the form, and every proof filed,
with a badge on the rewarded ones. A "Pay for proof" tool on the NGO's dashboard opens a pot (approve, then open),
lists the proof it can still pay for — oldest first, one per wallet — and closes it. A public "Prove & earn" page
lists the needs with a pot open. The timeline records each proof, reward, and pot opened or closed.

**A cap per wallet.** One wallet may file three proofs about one need (`MAX_PROOFS_PER_WALLET`): enough to follow a
delivery — the goods, the site, the handover — and a wallet that wants to flood a need's page has to fund a new wallet
for every three. A cap per need would be worse: whoever filed first could fill it and shut everyone else out. The page
lists rewarded proof first, then the newest, and folds everything after the first ten.

**Not done.** No moderation: proof that is off topic, false or shows a person stays listed, and the NGO simply does
not pay for it. Its photos are in the upload store, not on chain, so they can be taken down there; the manifest,
note included, stays in the event log. Rewards are paid in the donation token only.

Since §26 a reward is not paid out: it is credit its holder can only give to a need or a basket.

## 26. Rewards that can only be given, and giving baskets (v10)

Two changes that meet in one place: the money an NGO pays for proof (§25) no longer leaves the system as cash, and a
donor can back a cause — water, food, shelter — instead of picking a single need.

**Giving baskets.** A basket is a category. `DonationForwarderFactory.donateEqually(basket, needIds, total)` takes one
gift and splits it equally, in the same transaction, between the needs it names, and each part is an ordinary
donation through the vault's `donateVia` in the giver's name: a receipt per need, a say on that need's evidence, a
refund if it fails. Nothing is pooled and nothing waits: a basket holds no money, so there is no fund to govern, no
manager to trust and no second place for money to sit. A need takes what it can: one nearly full takes only what it
still needs, and the others share the rest equally (the needs with the least room are served first, each gets the
lesser of its room and an equal part of what is left, and the rounding dust goes to the need with the most room).
Whatever no need can take — every need full, closed, past a deadline or run by a suspended NGO — goes straight back to
the giver; if none can take anything the gift is refused. At most 25 needs share one gift, named in increasing order
so none can be named twice.

**Why "split now" and "equally".** Holding basket money until needs appear would make the basket a fund: it would need
rules for who decides where it goes and when, and a donor's money would wait with no need, no receipt and no vote.
Splitting at once keeps every euro attached to a need and a donor. Equal parts are the rule a donor can check by
eye; weighting by gap or urgency would be a judgement the platform makes for them.

**Which needs.** A need's category is committed only in its creation event (`category` is event-only in
`NeedsRegistry`, which has no bytes left to store it), so the factory cannot check that a basket's needs are of its
category. The app sends the ones the indexer lists: needs of the category raising money right now, run by an active
NGO, oldest first. The indexer checks each part against the need's category, and a part that went to a need of another
category is still a donation, just not the basket's: it counts for no basket.

**Rewards as credit.** `rewardProof` no longer transfers anything. The reward stays in `CommunityProofs` as
`creditOf[filer]`, and the filer's only use for it is `giveCredit(basket, needIds, amount)`: to one need (basket zero)
or to a basket, through the same `donateEqually`. What no need could take stays credit. The donor of record is the
`CommunityProofs` contract, never the filer, so the NGO's money buys no one a vote: the contract has no way to call
`approve` or `reject` and implements no ERC-1271, so it cannot sign one either. The filer is named in the
`CreditGiven` event and shown on the need as the source of a "reward credit" donation.

**Credit counts for no threshold.** Money that can never vote would otherwise raise the bar for those who can: a need
7 of whose raised 10 came from credit could never reach "donors who gave 30% approve". Worse, it would be a lever: an
NGO could reward wallets it controls and pour the credit into another NGO's need to freeze it. So `ReleasePolicy`
takes an immutable `rewardCredit` address and leaves what it gave out of the amount the donor thresholds are shares
of. If a need's whole raise was credit, the donors' half of its rule is empty: under "donors and a verifier" the
verifiers decide; under "donors decide" nobody can vote, the evidence waits, and the need expires at its deadline and
refunds.

**When a need fails.** Its refund comes back as credit, never as cash. The first `reclaimCredit(needId)` claims the
contract's refund from the vault once; each filer then gets back their share of it, pro rata to what they gave to that
need, so a need that had released a tranche before it failed returns everyone the same fraction.

**Where it shows.** A "Baskets" page lists one per category — the needs raising money now, what they still need, what
was given through the basket and what its category has completed — and each basket's page lists its needs, the gift
form (approve and `donateEqually` in one batch where the wallet can bundle them, with the split previewed by the same
rule) and its latest gifts. "Prove & earn" shows the filer's credit, where to give it, where it went and which failed
needs can be reclaimed. A need's donations say "Basket gift" or "Reward credit", and its timeline says so too.

**Not done.** No weighting or rebalancing, no recurring basket gifts, and no basket of needs across categories. A
receipt NFT for a reward-credit donation is minted to `CommunityProofs`, where it stays. The receipt a wallet gets per
need means a gift to five needs is five receipts, and five refunds to claim if they fail.
