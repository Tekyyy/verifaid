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
| R2 — track the path of donations | `AidVault` or `NonCustodialLedger`, soulbound `DonationReceipt`, `FundingRecorded` and `Settlement` attestations, on-chain conversions (`ConversionRouter`, `DonationForwarderFactory`), vaults that pay the need's registered suppliers directly, public tracking links |
| R3 — evidence of aid delivery | `DeliveryManager`, `DeliveryEvidence` + `DeliveryVerified` attestations, Semaphore receipt proofs |
| R4 — protect beneficiaries' data | off-chain PII vault, Semaphore identities, encrypted evidence |
| R5 — verifiable impact | `ImpactReport` attestations, Ponder indexer, public dashboard, PDF audit reports |

## How it works

```
NGO registers a need and its terms ─► independent verifier attests it ─► ledger cloned, funding opens
      │                                                                           │
      │          donors give by wallet, card or bank ◄────────────────────────────┘
      │          (on-chain custody: into the vault, euros and ETH converted on the way in under a
      │           Chainlink bound; off-chain: recorded by the payment provider)
      │                                        │
      │          funding closes at the target, or at the deadline if the minimum was met
      │          (below it the need expires and every donor is refunded)
      │                                        │
      ▼                tranche 0 paid to the need's suppliers as pre-financing ─► Settlement report
field agent delivers aid, files encrypted evidence ─► beneficiaries confirm anonymously (Semaphore)
      │                                                                           │
      └──► independent verifier signs off ─► challenge window ─► next tranche ─► Settlement ─► impact report
```

**Full blockchain mode.** The vaults hold USDC, so a donation in USDC — from a wallet, a card or an exchange —
reaches a need untouched: no pool, no price, no cost. Euros (EURC) and ETH are swapped on Uniswap v3 in the same
transaction, and any result below the Chainlink fair value minus 1% is refused. Card donors buy USDC through
Coinbase Onramp into their own passkey wallet and donate it in one tap. Money withdrawn from an exchange goes to
a deposit address that commits to the need and to where refunds go. Every conversion's cost is recorded on the
donation and counted against the cost cap the NGO disclosed.

**The vault pays the suppliers.** An on-chain need names its payment plan when it is registered — vetted
suppliers the admin registered, each with a share of every tranche, and the NGO itself only for a share it
discloses, capped at a quarter of the need. It is verified with the rest of the need, and releasing a tranche
pays those suppliers directly in the same transaction. Replacing one takes the NGO plus two independent
verifiers, and a tranche someone has already earned cannot be redirected.

Money only moves forward when three independent signals agree: field evidence, anonymous beneficiary
confirmations above a threshold, and an approving verifier who is provably unrelated to the NGO. A donor follows
all of it through five stages — **verified, funded, settled, delivered, impact confirmed** — from a tracking link
that needs no account.

## Live on Base Sepolia

v3 is deployed and all 15 contracts are source-verified on Basescan; its six schemas are registered in the real EAS
SchemaRegistry. Conversions run on Uniswap v3's own Base Sepolia deployment and Chainlink's USDC/USD feed there;
because Base Sepolia has no EUR/USD feed and no liquid pool for the test tokens, those two are mocked and the
mock EURC / USDC pool is created by the deploy at the oracle price (USDC donations need no pool: the vaults hold USDC). `pnpm demo:run base-sepolia` runs four needs
on it: on-chain custody (wallet and card donors, settlement after every release), off-chain custody (every payment
and payout attested by the payment provider), a need that expires below its minimum and refunds its donor, and a
need funded in full blockchain mode (card-bought USDC from the donor's own wallet, and an exchange withdrawal to a
deposit address).

| | |
|---|---|
| `NeedsRegistry` | [`0x2476F8CEfe3143a76D1995Cf01A9d66ffeFA00CE`](https://sepolia.basescan.org/address/0x2476F8CEfe3143a76D1995Cf01A9d66ffeFA00CE) |
| `DeliveryManager` | [`0xBE7d731b59C0E3A8ad66f604a1Ad0e3260e04DAf`](https://sepolia.basescan.org/address/0xBE7d731b59C0E3A8ad66f604a1Ad0e3260e04DAf) |
| `ProofOfAidResolver` | [`0x1A5F05AC4aE7DDE22a5CA869509D8e849E5349da`](https://sepolia.basescan.org/address/0x1A5F05AC4aE7DDE22a5CA869509D8e849E5349da) |
| `RoleRegistry` | [`0x1e858a0dae31a20815aa85D27Ffb2ec18898ee7F`](https://sepolia.basescan.org/address/0x1e858a0dae31a20815aa85D27Ffb2ec18898ee7F) |
| `AidVaultFactory` | [`0xAD1582aFfedbddf96252bfe02BbE5F0F183FdFEf`](https://sepolia.basescan.org/address/0xAD1582aFfedbddf96252bfe02BbE5F0F183FdFEf) |
| `BeneficiaryGroups` | [`0x7B8fb05147dff265842CC804C6326cc5699F598a`](https://sepolia.basescan.org/address/0x7B8fb05147dff265842CC804C6326cc5699F598a) |
| `DonationReceipt` | [`0x47EC520CCAb71665dDFACD14f5387E106bfaC4df`](https://sepolia.basescan.org/address/0x47EC520CCAb71665dDFACD14f5387E106bfaC4df) |
| `ConversionRouter` | [`0x227D3Cee9C2eA43d447cdb496C625b30439ED8BD`](https://sepolia.basescan.org/address/0x227D3Cee9C2eA43d447cdb496C625b30439ED8BD) |
| `DonationForwarderFactory` | [`0x8048f5A99fBDd59BB41DC99BB467915E39ddcd21`](https://sepolia.basescan.org/address/0x8048f5A99fBDd59BB41DC99BB467915E39ddcd21) |
| test token (mEURC) | [`0x979EfA4EAfAF168E33642875779e7ab42D74dDB7`](https://sepolia.basescan.org/address/0x979EfA4EAfAF168E33642875779e7ab42D74dDB7) |
| test USDC (mUSDC) | [`0xc42Aae28D9e4fF0E70aFB73B7135CD25d1645693`](https://sepolia.basescan.org/address/0xc42Aae28D9e4fF0E70aFB73B7135CD25d1645693) |

Every address and schema UID is in [`deployments/base-sepolia.json`](deployments/base-sepolia.json); the schemas are
browsable on the [Base Sepolia EAS explorer](https://base-sepolia.easscan.org). EAS, Semaphore v4, Uniswap v3 and
the Chainlink feeds are the ones already deployed on Base Sepolia — this project deploys none of them. Earlier
releases stay on-chain and are recorded in [`deployments/base-sepolia.v1.json`](deployments/base-sepolia.v1.json)
and [`deployments/base-sepolia.v2.json`](deployments/base-sepolia.v2.json).

## Repository layout

```
contracts/    Foundry: needs and their terms, vault and non-custodial ledgers, deliveries, Semaphore groups, one EAS resolver
services/     evidence (encrypt + IPFS), pii-vault (envelope-encrypted records), bank-connector (SEPA, card checkout
              sandbox, CSV import, provider settlements), notifier (alerts and signed webhooks)
indexer/      Ponder: events → tables → the API, donation tracking and RSS feeds
app/          Next.js dashboard: public needs and tracking pages, embeddable widget, donor, NGO, verifier, field
              agent and beneficiary tools, PDF reports
demo/         runs the four lifecycle scenarios against a live chain (including conversions)
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
pnpm demo:run       # the four lifecycle scenarios, with explorer links
pnpm indexer:dev    # indexer on :42069
pnpm app:dev        # dashboard on :3000
pnpm services:up    # Postgres and the four services (Docker)
```

Deploy to Base Sepolia (needs `DEPLOYER_PRIVATE_KEY` and `BASESCAN_API_KEY` in `.env`). The whole system costs
well under 0.001 ETH, and the script reuses the EAS, Semaphore, Uniswap and Chainlink contracts already deployed
there:

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

- [`docs/DECISIONS.md`](docs/DECISIONS.md) — every open choice and how it was resolved, including v2, v3 conversions and all three adversarial reviews
- [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) — threats, mitigations and residual risk, including off-chain custody and conversions
- [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md) — the five-minute walkthrough
- [`docs/GAP_PLAN.md`](docs/GAP_PLAN.md) — the proposal, item by item, and where each lives in the code
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — what is deliberately left out, and what it would take
- [`contracts/README.md`](contracts/README.md) — contract map, need terms, money flow and test suites

## License

MIT
