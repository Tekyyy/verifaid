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
- **Refund shares freeze at cancellation.** `refund = donatedBy × (totalDonated − totalReleased) / totalDonated`
  is evaluated against values that can no longer change once the need is `Cancelled` (donations require
  `Funding`, releases require `Funded`/`InDelivery`). Floor division can strand at most one base unit per
  claimant in the vault; that dust keeps the invariant intact rather than being sweepable by whoever claims last.
- **Fiat donations mint no receipt NFT.** The spec allows "partner custody address or skipped". Minting to the
  bank partner would suggest the partner is the donor; the donor is represented by the salted `donorRefHash`,
  and only the partner that deposited a reference can trigger its refund.
- **Payment references are globally unique.** The vault records `paymentRefUsed` per the spec, and additionally
  calls `AidVaultFactory.consumePaymentRef`, so one bank transfer cannot be replayed against a second need.
- **Only standard ERC-20s are supported.** No fee-on-transfer or rebasing tokens (the deployer chooses the token).

## 7. Attestations and resolvers

- **Each resolver derives the UID of the one schema it serves** from its own address:
  `keccak256(abi.encodePacked(schema, address(this), revocable))`, the same formula the SchemaRegistry uses.
  Without this, anyone could register a second schema pointing at our resolver and produce attestations the
  indexer would not recognise while the core contracts still accepted them.
- **`recipient` is enforced**, never a person: the registry for `NeedVerified`, the DeliveryManager for
  `DeliveryEvidence`/`DeliveryVerified`, the vault for `FiatDonation`/`ImpactReport`.
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
receiver hook cannot re-enter the donating vault), `unsafe-typecast` (`uint64(block.timestamp)`),
`block-timestamp` (the challenge window is a coarse timer), plus three categories that are false positives here
(`missing-events-access-control`, `uninitialized-local`, `require-revert-in-loop`).
