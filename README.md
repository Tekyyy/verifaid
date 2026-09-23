# VerifAid

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

The platform runs **Model B only: everything happens on chain.** No payment provider holds anyone's money. A card
reaches a need through the Coinbase on-ramp, which buys USDC into the donor's own wallet before anything is given,
so even a card payment arrives as a token. The contracts still contain Model A (a `NonCustodialLedger` and
provider-attested deposits) from earlier releases, but nothing in the product can create or fund such a need
anymore. `docs/DECISIONS.md` §20 explains why. `docs/GAP_PLAN.md` maps every item of the proposal to where it
lives in the code.

| Requirement | Where it lives |
|---|---|
| R1 — register previously verified needs, with their terms | `NeedsRegistry` (deadlines, minimum funding, cost cap, expected outcome) + `NeedVerified` attestations |
| R2 — track the path of donations | `AidVault`, soulbound `DonationReceipt`, `Settlement` attestations, on-chain conversions (`ConversionRouter`, `DonationForwarderFactory`), card payments through the Coinbase on-ramp, vaults that pay the need's registered suppliers directly, public tracking links |
| R3 — evidence of aid delivery | `DeliveryManager`, `DeliveryEvidence` + `DeliveryVerified` attestations, Semaphore receipt proofs |
| R4 — protect beneficiaries' data | off-chain PII vault, Semaphore identities, encrypted evidence |
| R5 — verifiable impact | `ImpactReport` attestations, Ponder indexer, public dashboard, PDF audit reports |

## How it works

```
NGO registers a need and its terms ─► independent verifier attests it ─► ledger cloned, funding opens
      │                                                                           │
      │          donors give by wallet, card or exchange ◄────────────────────────┘
      │          (all of it on chain, into the vault: a card buys USDC through the Coinbase on-ramp;
      │           euros and ETH are converted on the way in under a Chainlink bound)
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
Coinbase Onramp into their own passkey wallet and donate it in one tap — Coinbase's terms require the buyer to
own the destination, so the on-ramp never pays a vault directly, and there is no other way for a card to reach a
need. The on-ramp is live only on Base mainnet with CDP API keys; on testnets a sandbox mints test USDC instead. Money withdrawn from an exchange goes to
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

v6 is deployed and every contract is source-verified on Basescan; its schemas are registered in the real EAS
SchemaRegistry. The vaults hold a test USDC, so a donation in USDC never touches a pool. Euro donations convert on
Uniswap v3's own Base Sepolia deployment under Chainlink's USDC/USD feed; Base Sepolia has no EUR/USD feed and no
liquid pool for test tokens, so those two are mocked and the deploy creates the mock EURC / USDC pool at the oracle
price. A need whose deliveries run for months can let its committed money wait in an ERC-4626 venue (a mock one
on testnets). `pnpm demo:run base-sepolia` runs four needs on it: escrow with a wallet donor and a card donor,
each tranche paid straight to the need's supplier and the NGO's disclosed share; a need that expires below its
minimum and refunds its donor; conversions (card-bought USDC donated as it is, euros and ETH converted, an exchange
withdrawal to a deposit address); and idle capital earning while it waits. A donor who changes their mind while a
need is still raising can take their donation back, up to two days before its funding deadline.

| | |
|---|---|
| `NeedsRegistry` | [`0xC463634d663b610E93Fc92b8f5017f78E086bdeF`](https://sepolia.basescan.org/address/0xC463634d663b610E93Fc92b8f5017f78E086bdeF) |
| `DeliveryManager` | [`0x43F77A6e406506503fC5983A1E694470A6a870D6`](https://sepolia.basescan.org/address/0x43F77A6e406506503fC5983A1E694470A6a870D6) |
| `ProofOfAidResolver` | [`0xf2E94923c0fbc2D568348Cd5C2639a57F28a471f`](https://sepolia.basescan.org/address/0xf2E94923c0fbc2D568348Cd5C2639a57F28a471f) |
| `RoleRegistry` | [`0x3E1FC207c10d1994aA6383ED4Bcd1d5927674dB0`](https://sepolia.basescan.org/address/0x3E1FC207c10d1994aA6383ED4Bcd1d5927674dB0) |
| `AidVaultFactory` | [`0xc986335eA83De1E763DC7675ef01e43ed04A2Dcc`](https://sepolia.basescan.org/address/0xc986335eA83De1E763DC7675ef01e43ed04A2Dcc) |
| `BeneficiaryGroups` | [`0x9f9de11C9Ebc81f3bC1B0396615b39Ea7279c658`](https://sepolia.basescan.org/address/0x9f9de11C9Ebc81f3bC1B0396615b39Ea7279c658) |
| `DonationReceipt` | [`0xb9f6318c036d2d0A3bDFAC03B5B5Fe401C30bDd6`](https://sepolia.basescan.org/address/0xb9f6318c036d2d0A3bDFAC03B5B5Fe401C30bDd6) |
| `ConversionRouter` | [`0x13E2585BA64E232ff10Ddbfef44D5DA017A4778a`](https://sepolia.basescan.org/address/0x13E2585BA64E232ff10Ddbfef44D5DA017A4778a) |
| `DonationForwarderFactory` | [`0x7a752FDB53CD1B2e86cefF77767ac5E1484529bf`](https://sepolia.basescan.org/address/0x7a752FDB53CD1B2e86cefF77767ac5E1484529bf) |
| vault currency, test USDC (mUSDC) | [`0x2b55a998Ea617d494a1BeE85F21d4b10Df8329ff`](https://sepolia.basescan.org/address/0x2b55a998Ea617d494a1BeE85F21d4b10Df8329ff) |
| test EURC (mEURC), converted on the way in | [`0x2C3a6eB95b63dd0fb006067147E4916eDa3f570D`](https://sepolia.basescan.org/address/0x2C3a6eB95b63dd0fb006067147E4916eDa3f570D) |
| idle-capital venue (mock ERC-4626) | [`0x49A1B718FB4f0c7822e08fb2cAa1fDF0473f6d37`](https://sepolia.basescan.org/address/0x49A1B718FB4f0c7822e08fb2cAa1fDF0473f6d37) |

Every address and schema UID is in [`deployments/base-sepolia.json`](deployments/base-sepolia.json); the schemas are
browsable on the [Base Sepolia EAS explorer](https://base-sepolia.easscan.org). EAS, Semaphore v4, Uniswap v3 and
the Chainlink feeds are the ones already deployed on Base Sepolia — this project deploys none of them. Earlier
releases stay on-chain and are recorded in `deployments/base-sepolia.v1.json` through
[`deployments/base-sepolia.v5.json`](deployments/base-sepolia.v5.json).

## Repository layout

```
contracts/    Foundry: needs and their terms, vaults, deliveries, Semaphore groups, one EAS resolver
services/     evidence (encrypt + IPFS), pii-vault (envelope-encrypted records), notifier (alerts and signed webhooks)
indexer/      Ponder: events → tables → the API, donation tracking and RSS feeds
app/          Next.js dashboard: public needs and tracking pages, embeddable widget, donor, NGO, verifier, field
              agent and beneficiary tools, PDF reports
demo/         runs the four lifecycle scenarios against a live chain (escrow, expiry, conversions, idle capital)
deployments/  addresses + schema UIDs per network, written by the deploy scripts
docs/         DECISIONS.md, THREAT_MODEL.md, DEMO_SCRIPT.md, ROADMAP.md, GAP_PLAN.md
justfile      one-command shortcuts (see "Quick start")
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
pnpm services:up    # Postgres and the three services (Docker)
```

### Shortcuts with `just`

With [`just`](https://github.com/casey/just) installed, the everyday workflows are a single command:

```bash
just up             # install, build everything, and start the full stack (Base Sepolia)
just front          # dashboard only, on bundled sample data — no chain or indexer needed
just stack          # indexer + dashboard together, against the live Base Sepolia deployment
just install        # install dependencies only
​```

- `just up` is the one-shot "get it running": it installs, runs `pnpm build` (which compiles the contracts, so
  it needs Foundry) and then starts the stack.
- `just front` renders the bundled fixtures (`NEXT_PUBLIC_USE_FIXTURES=1` in `app/.env.local`), so the UI runs
  with no backend at all — handy for frontend and design work.
- `just stack` shows real testnet data: it reads needs straight from the deployed contracts. It expects
  `PONDER_NETWORK=base-sepolia` in `indexer/.env.local`, and `NEXT_PUBLIC_CHAIN_ID=84532` with fixtures off in
  `app/.env.local`. `Ctrl+C` stops both processes. It uses the contracts already deployed on Base Sepolia — it
  does not redeploy anything.

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
receipt id or a deposit address, never by name; alert emails are encrypted and destroyed on unsubscribe.
Right to erasure is handled by destroying the record's data key (crypto-shredding) and removing the identity
commitment from the group. See `docs/THREAT_MODEL.md` for what this does **not** protect against.

## Documentation

- [`docs/DECISIONS.md`](docs/DECISIONS.md) — every open choice and how it was resolved, including v2, v3 conversions and all three adversarial reviews
- [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) — threats, mitigations and residual risk, including conversions, card payments and idle capital
- [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md) — the five-minute walkthrough
- [`docs/GAP_PLAN.md`](docs/GAP_PLAN.md) — the proposal, item by item, and where each lives in the code
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — what is deliberately left out, and what it would take
- [`contracts/README.md`](contracts/README.md) — contract map, need terms, money flow and test suites
