# Proof of Aid

**The public chain holds flows and proofs. It never holds people.**

A blockchain-native system to register verified needs, trace donations end to end, prove that aid was actually
delivered, protect beneficiaries' data, and publish impact anyone can recompute. Built on Base.

## Where this sits in the proposal

The public proposal ([proof-of-aid.lovable.app](https://proof-of-aid.lovable.app)) describes two ways to hold a
need's money and recommends starting with the first:

- **Model A — non-custodial.** A regulated payment provider holds the money; the chain holds the rules, every
  payment and payout as a signed attestation, and the evidence of delivery.
- **Model B — conditional stablecoin.** The money itself sits in an on-chain escrow and moves only when the rules
  say so.

This repository implements **both on the same contracts**. Every need picks its custody model when it is created;
deadlines, the minimum-funding threshold, tranches, the three-signal delivery gate, fee caps and the impact chain
are identical in both. So it covers the proposal's first phase and its end state, and a need can move from one to
the other without changing what donors are promised. `docs/GAP_PLAN.md` maps every item of the proposal to where
it lives in the code.

| Requirement | Where it lives |
|---|---|
| R1 — register previously verified needs, with their terms | `NeedsRegistry` (deadlines, minimum funding, cost cap, expected outcome) + `NeedVerified` attestations |
| R2 — track the path of donations | `AidVault` or `NonCustodialLedger`, soulbound `DonationReceipt`, `FundingRecorded` and `Settlement` attestations, public tracking links |
| R3 — evidence of aid delivery | `DeliveryManager`, `DeliveryEvidence` + `DeliveryVerified` attestations, Semaphore receipt proofs |
| R4 — protect beneficiaries' data | off-chain PII vault, Semaphore identities, encrypted evidence |
| R5 — verifiable impact | `ImpactReport` attestations, Ponder indexer, public dashboard, PDF audit reports |

## How it works

```
NGO registers a need and its terms ─► independent verifier attests it ─► ledger cloned, funding opens
      │                                                                           │
      │          donors give by wallet, card or bank ◄────────────────────────────┘
      │          (on-chain custody: into the vault; off-chain: recorded by the payment provider)
      │                                        │
      │          funding closes at the target, or at the deadline if the minimum was met
      │          (below it the need expires and every donor is refunded)
      │                                        │
      ▼                         tranche 0 released as pre-financing ─► Settlement report
field agent delivers aid, files encrypted evidence ─► beneficiaries confirm anonymously (Semaphore)
      │                                                                           │
      └──► independent verifier signs off ─► challenge window ─► next tranche ─► Settlement ─► impact report
```

Money only moves forward when three independent signals agree: field evidence, anonymous beneficiary
confirmations above a threshold, and an approving verifier who is provably unrelated to the NGO. A donor follows
all of it through five stages — **verified, funded, settled, delivered, impact confirmed** — from a tracking link
that needs no account.

## Live on Base Sepolia

v2 is deployed and source-verified on Basescan, and its six schemas are registered in the real EAS
SchemaRegistry. `pnpm demo:run base-sepolia` runs three needs on it: one in on-chain custody (wallet and card
donors, settlement after every release), one in off-chain custody (every payment and payout attested by the
payment provider), and one that expires below its minimum and refunds its donor.

| | |
|---|---|
| `NeedsRegistry` | [`0x8931b763c74a1706f78a395dc8b005Ae1E0b7932`](https://sepolia.basescan.org/address/0x8931b763c74a1706f78a395dc8b005Ae1E0b7932) |
| `DeliveryManager` | [`0xfe628B18d322076da87A03d7f265AA2c4BCc6f09`](https://sepolia.basescan.org/address/0xfe628B18d322076da87A03d7f265AA2c4BCc6f09) |
| `ProofOfAidResolver` | [`0xf6854EFa8f77648B0e3638a9a9615C96D63dF29B`](https://sepolia.basescan.org/address/0xf6854EFa8f77648B0e3638a9a9615C96D63dF29B) |
| `RoleRegistry` | [`0x5C4ea3f9A5F704282170890226326Ebab8E522A1`](https://sepolia.basescan.org/address/0x5C4ea3f9A5F704282170890226326Ebab8E522A1) |
| `AidVaultFactory` | [`0xC4D24C30a900C845E9bF06EC2cE2A13C3E232359`](https://sepolia.basescan.org/address/0xC4D24C30a900C845E9bF06EC2cE2A13C3E232359) |
| `BeneficiaryGroups` | [`0xec5cdCa8101323574a8953B0c7B7C26B716989c4`](https://sepolia.basescan.org/address/0xec5cdCa8101323574a8953B0c7B7C26B716989c4) |
| `DonationReceipt` | [`0xe5b765C7b0Bf1FA0af58CC71A3a67E236353F5bA`](https://sepolia.basescan.org/address/0xe5b765C7b0Bf1FA0af58CC71A3a67E236353F5bA) |
| test token (mEURC) | [`0xBC7c4FEa2d4Fe339d4e9a9f43f2D606F25aD1BD8`](https://sepolia.basescan.org/address/0xBC7c4FEa2d4Fe339d4e9a9f43f2D606F25aD1BD8) |

Every address and schema UID is in [`deployments/base-sepolia.json`](deployments/base-sepolia.json); the schemas are
browsable on the [Base Sepolia EAS explorer](https://base-sepolia.easscan.org). EAS and Semaphore v4 are the ones
already deployed on Base Sepolia — this project deploys neither. The v1 release (whose need #5 ran the original
lifecycle) stays on-chain and is recorded in [`deployments/base-sepolia.v1.json`](deployments/base-sepolia.v1.json).

## Repository layout

```
contracts/    Foundry: needs and their terms, vault and non-custodial ledgers, deliveries, Semaphore groups, one EAS resolver
services/     evidence (encrypt + IPFS), pii-vault (envelope-encrypted records), bank-connector (SEPA, card checkout
              sandbox, CSV import, provider settlements), notifier (alerts and signed webhooks)
indexer/      Ponder: events → tables → the API, donation tracking and RSS feeds
app/          Next.js dashboard: public needs and tracking pages, embeddable widget, donor, NGO, verifier, field
              agent and beneficiary tools, PDF reports
demo/         runs the three lifecycle scenarios against a live chain
deployments/  addresses + schema UIDs per network, written by the deploy scripts
docs/         DECISIONS.md, THREAT_MODEL.md, DEMO_SCRIPT.md, ROADMAP.md, GAP_PLAN.md
```

## Quick start

Requires Node 22+, pnpm 12+ and [Foundry](https://getfoundry.sh).

```bash
pnpm install
cp .env.example .env
```

Build and test the contracts:

```bash
cd contracts && forge build && forge test
```

Run the whole system against a local chain:

```bash
pnpm chain          # anvil
pnpm deploy:local   # deploy + register schemas + seed demo data
pnpm demo:run       # the three lifecycle scenarios, with explorer links
pnpm indexer:dev    # indexer on :42069
pnpm app:dev        # dashboard on :3000
pnpm services:up    # Postgres and the four services (Docker)
```

Deploy to Base Sepolia (needs `DEPLOYER_PRIVATE_KEY` and `BASESCAN_API_KEY` in `.env`). The whole system costs
about 0.0003 ETH, and the script reuses the EAS and Semaphore contracts already deployed there:

```bash
pnpm deploy:sepolia
```

## Privacy

No name, ID number, phone number, exact location, photo, or unsalted hash of any of these ever reaches the
chain. Beneficiaries appear only as Semaphore identity commitments; a delivery confirmation reveals a nullifier
and nothing else, and confirmations are relayed so the beneficiary's own wallet never appears in a transaction.
Deliveries below five expected recipients are refused so a count cannot identify a person. Donors are tracked by a
receipt id or a salted payment reference, never by name; alert emails are encrypted and destroyed on unsubscribe.
Right to erasure is handled by destroying the record's data key (crypto-shredding) and removing the identity
commitment from the group. See `docs/THREAT_MODEL.md` for what this does **not** protect against.

## Documentation

- [`docs/DECISIONS.md`](docs/DECISIONS.md) — every open choice and how it was resolved, including v2 and both adversarial reviews
- [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) — threats, mitigations and residual risk, including off-chain custody
- [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md) — the five-minute walkthrough
- [`docs/GAP_PLAN.md`](docs/GAP_PLAN.md) — the proposal, item by item, and where each lives in the code
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — what is deliberately left out, and what it would take
- [`contracts/README.md`](contracts/README.md) — contract map, need terms, money flow and test suites

## License

MIT
