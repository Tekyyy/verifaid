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

The platform runs **Model B only: everything happens on chain.** No payment provider holds anyone's money, and
since v7 the contracts have no way for one to: every need's money is escrowed in its own vault. A card reaches a
need through the Coinbase on-ramp, which buys USDC into the donor's own wallet before anything is given, so even a
card payment arrives as a token. `docs/DECISIONS.md` §20 explains why. `docs/GAP_PLAN.md` maps every item of the proposal to where it
lives in the code.

| Requirement | Where it lives |
|---|---|
| R1 — register previously verified needs, with their terms | `NeedsRegistry` (deadlines, minimum funding, cost cap, expected outcome) + `NeedVerified` attestations |
| R2 — track the path of donations | `AidVault`, soulbound `DonationReceipt`, `Settlement` attestations, on-chain conversions (`ConversionRouter`, `DonationForwarderFactory`), card payments through the Coinbase on-ramp, vaults that pay the need's registered suppliers directly, public tracking links |
| R3 — evidence of aid delivery | `DeliveryManager`: the NGO files photos, receipts and bank statements by hash; donors who gave 30% of the money approve before the next tranche |
| R4 — protect beneficiaries' data | off-chain PII vault, Semaphore identity commitments, evidence photos stripped of metadata |
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
NGO accounts for it: photos, receipts, bank statements (committed on chain by hash)
      │                                                                           │
      └──► donors who gave 30% of the money approve ─► next tranche ─► Settlement ─► … ─► impact report
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

v7 is deployed and every contract is source-verified on Basescan; its schemas are registered in the real EAS
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
| `NeedsRegistry` | [`0x0Dd9B7368cF1fC105C26dBadC4Cc300c28B3337b`](https://sepolia.basescan.org/address/0x0Dd9B7368cF1fC105C26dBadC4Cc300c28B3337b) |
| `DeliveryManager` | [`0x01e72Bdd6c2F4b9A9368779983D96DDc480ecb61`](https://sepolia.basescan.org/address/0x01e72Bdd6c2F4b9A9368779983D96DDc480ecb61) |
| `ProofOfAidResolver` | [`0xDbA10d7752a02250E75204772b26445777cde022`](https://sepolia.basescan.org/address/0xDbA10d7752a02250E75204772b26445777cde022) |
| `RoleRegistry` | [`0x4b47C5F9785b1eeABa9873BFF8E02AD32c23F6ae`](https://sepolia.basescan.org/address/0x4b47C5F9785b1eeABa9873BFF8E02AD32c23F6ae) |
| `AidVaultFactory` | [`0x7cD2e055BB3BAeBD10FA72a3b975048aD0293a4C`](https://sepolia.basescan.org/address/0x7cD2e055BB3BAeBD10FA72a3b975048aD0293a4C) |
| `BeneficiaryGroups` | [`0xcf2965B6D1D42b6069772E704980cb83f05c920B`](https://sepolia.basescan.org/address/0xcf2965B6D1D42b6069772E704980cb83f05c920B) |
| `DonationReceipt` | [`0x14333d2F56D9d6Ace68468C575ca639633080E5C`](https://sepolia.basescan.org/address/0x14333d2F56D9d6Ace68468C575ca639633080E5C) |
| `ConversionRouter` | [`0x2A622A75B029746E5C48a3Ad3E7f89b4f83BE700`](https://sepolia.basescan.org/address/0x2A622A75B029746E5C48a3Ad3E7f89b4f83BE700) |
| `DonationForwarderFactory` | [`0x5255F0AA422115C1A2c06aEc9533dcaC83115DB5`](https://sepolia.basescan.org/address/0x5255F0AA422115C1A2c06aEc9533dcaC83115DB5) |
| vault currency, test USDC (mUSDC) | [`0x1c2c7cc327B3831C26b2F693A7Ae8313E93694bC`](https://sepolia.basescan.org/address/0x1c2c7cc327B3831C26b2F693A7Ae8313E93694bC) |
| test EURC (mEURC), converted on the way in | [`0x8610062BE5Ed0370a9008369A0eee4E515A406f4`](https://sepolia.basescan.org/address/0x8610062BE5Ed0370a9008369A0eee4E515A406f4) |
| idle-capital venue (mock ERC-4626) | [`0x124aEC642D75618f017A97ecCC37A999716dF279`](https://sepolia.basescan.org/address/0x124aEC642D75618f017A97ecCC37A999716dF279) |

Every address and schema UID is in [`deployments/base-sepolia.json`](deployments/base-sepolia.json); the schemas are
browsable on the [Base Sepolia EAS explorer](https://base-sepolia.easscan.org). EAS, Semaphore v4, Uniswap v3 and
the Chainlink feeds are the ones already deployed on Base Sepolia — this project deploys none of them. Earlier
releases stay on-chain and are recorded in `deployments/base-sepolia.v1.json` through
[`deployments/base-sepolia.v6.json`](deployments/base-sepolia.v6.json).

## Repository layout

```
contracts/    Foundry: needs and their terms, vaults, donor-approved deliveries, Semaphore groups, one EAS resolver
services/     pii-vault (envelope-encrypted records), notifier (alerts and signed webhooks)
indexer/      Ponder: events → tables → the API, donation tracking and RSS feeds
app/          Next.js dashboard: public needs and tracking pages, embeddable widget, donor, NGO and verifier tools,
              and the evidence uploads (content-addressed)
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
chain. Beneficiaries appear only as Semaphore identity commitments. Delivery evidence is public, for donors to
approve: photos are stripped of their location and camera metadata before they are stored, and the NGO is told
to black out names, faces and account numbers first. Impact reports below five people served are refused so a
count cannot identify a person. Donors are tracked by a
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
