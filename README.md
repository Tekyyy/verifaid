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
| R3 — evidence of aid delivery | `DeliveryManager`: the NGO files photos, receipts and bank statements by hash (and pinned to IPFS); the rule the need chose — donors, a verifier, or both — approves or rejects it before the next tranche |
| R4 — protect beneficiaries' data | off-chain PII vault; no beneficiary on chain in any form; evidence photos stripped of metadata |
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
NGO accounts for it: photos, receipts, bank statements (committed on chain by hash, pinned to IPFS)
      │                                                                           │
      ├──► approved under the need's rule (e.g. donors who gave 30%) ─► next tranche ─► … ─► impact report
      └──► rejected (donors who gave 50%, or a verifier) ─► NGO files again once ─► rejected again: need
           cancelled, donors refunded what was not released
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

**The need chooses who judges its evidence.** When it is created, a need picks one of the platform's release
rules and keeps it for life: *donors decide* (the default: donors who gave 30% of the money approve, 50% reject),
*a verifier checks*, or *donors and a verifier*. A rejection sends the NGO back once; a second one cancels the need
and refunds what was not released. Donors vote for free — they sign, and the platform's relayer pays the gas. New
rules can be approved later without redeploying anything, and never change a need that already exists.

**The admin has to wait.** Every admin action is proposed by a 2-of-3 Safe and waits out a public timelock before
anyone can execute it; a guardian can only pause. Nobody, including the admin, can take money out of a vault.

A donor follows all of it through five stages — **verified, funded, settled, delivered, impact confirmed** — from
a tracking link that needs no account.

## Live on Base Sepolia

v9 is deployed and every contract is source-verified on Basescan; its schemas are registered in the real EAS
SchemaRegistry. The vaults hold a test USDC, so a donation in USDC never touches a pool. Euro donations convert on
Uniswap v3's own Base Sepolia deployment under Chainlink's USDC/USD feed; Base Sepolia has no EUR/USD feed and no
liquid pool for test tokens, so those two are mocked and the deploy creates the mock EURC / USDC pool at the oracle
price. A need whose deliveries run for months can let its committed money wait in an ERC-4626 venue (a mock one
on testnets). `pnpm demo:run base-sepolia` runs five needs on it: escrow with a wallet donor and a card donor,
each tranche paid straight to the need's supplier and the NGO's disclosed share; a need that expires below its
minimum and refunds its donor; conversions (card-bought USDC donated as it is, euros and ETH converted, an exchange
withdrawal to a deposit address); idle capital earning while it waits; and a need whose evidence is rejected
twice, cancelled and refunded. A donor who changes their mind while a
need is still raising can take their donation back, up to two days before its funding deadline.

| | |
|---|---|
| `NeedsRegistry` | [`0xDDf49b52728edc38eB662Fdb934CB19Ec037997a`](https://sepolia.basescan.org/address/0xDDf49b52728edc38eB662Fdb934CB19Ec037997a) |
| `DeliveryManager` | [`0xF8FD93f388A45df337f077C36E04E8fDD8844fCC`](https://sepolia.basescan.org/address/0xF8FD93f388A45df337f077C36E04E8fDD8844fCC) |
| `ProofOfAidResolver` | [`0xD2771615B63D967Ff2f7D704dE0fdaca985ba181`](https://sepolia.basescan.org/address/0xD2771615B63D967Ff2f7D704dE0fdaca985ba181) |
| `RoleRegistry` | [`0xf42EBd86a3decDD5466540F41D9B9dEeAdCFE8b5`](https://sepolia.basescan.org/address/0xf42EBd86a3decDD5466540F41D9B9dEeAdCFE8b5) |
| `AidVaultFactory` | [`0x05bcf934DcB1462AA234C854Fd514325895CA161`](https://sepolia.basescan.org/address/0x05bcf934DcB1462AA234C854Fd514325895CA161) |
| `ProgramRegistry` | [`0x9e23d1Cc7281c95FA83765517cF770438668d48A`](https://sepolia.basescan.org/address/0x9e23d1Cc7281c95FA83765517cF770438668d48A) |
| release policy: donors decide | [`0x81123F83CAB4651F1b830E83376cC0Ec8fc8A816`](https://sepolia.basescan.org/address/0x81123F83CAB4651F1b830E83376cC0Ec8fc8A816) |
| release policy: a verifier checks | [`0xFA616eAD54Edff5d541eeb1c99888d7F1C5BEB14`](https://sepolia.basescan.org/address/0xFA616eAD54Edff5d541eeb1c99888d7F1C5BEB14) |
| release policy: donors and a verifier | [`0x5c9A0C7A35EAEf076b7c62f7d2638c394F3E03a7`](https://sepolia.basescan.org/address/0x5c9A0C7A35EAEf076b7c62f7d2638c394F3E03a7) |
| admin: TimelockController | [`0xf5DD48f4aB8232F32eB527c15d56D39F3314580A`](https://sepolia.basescan.org/address/0xf5DD48f4aB8232F32eB527c15d56D39F3314580A) |
| admin proposer: Safe (2-of-3) | [`0xd9575509cE883456185C458b5dD778aD2341b898`](https://sepolia.basescan.org/address/0xd9575509cE883456185C458b5dD778aD2341b898) |
| `DonationReceipt` | [`0x191232C46D30923a36cFa2Ff94b47C90203039fB`](https://sepolia.basescan.org/address/0x191232C46D30923a36cFa2Ff94b47C90203039fB) |
| `ConversionRouter` | [`0x25391Cab52DECb9e451cC247B74FAF5768393A02`](https://sepolia.basescan.org/address/0x25391Cab52DECb9e451cC247B74FAF5768393A02) |
| `DonationForwarderFactory` | [`0x0a364893BF2686e3982dA7481A4A3aDbF0F38Dc1`](https://sepolia.basescan.org/address/0x0a364893BF2686e3982dA7481A4A3aDbF0F38Dc1) |
| vault currency, test USDC (mUSDC) | [`0x32e8765f9aCF760f4c353e118A6C1a22367a23ff`](https://sepolia.basescan.org/address/0x32e8765f9aCF760f4c353e118A6C1a22367a23ff) |
| test EURC (mEURC), converted on the way in | [`0xA0523ee77ca7219eD0E4a0FdBc7699C3E1F6eDE5`](https://sepolia.basescan.org/address/0xA0523ee77ca7219eD0E4a0FdBc7699C3E1F6eDE5) |
| idle-capital venue (mock ERC-4626) | [`0x1fcc22EfB1e3eD6484d9E944F5eeDD084e29789E`](https://sepolia.basescan.org/address/0x1fcc22EfB1e3eD6484d9E944F5eeDD084e29789E) |

Every address and schema UID is in [`deployments/base-sepolia.json`](deployments/base-sepolia.json); the schemas are
browsable on the [Base Sepolia EAS explorer](https://base-sepolia.easscan.org). EAS, Safe, Uniswap v3 and
the Chainlink feeds are the ones already deployed on Base Sepolia — this project deploys none of them. Earlier
releases stay on-chain and are recorded in `deployments/base-sepolia.v1.json` through
[`deployments/base-sepolia.v8.json`](deployments/base-sepolia.v8.json).

## Repository layout

```
contracts/    Foundry: needs and their terms, vaults, deliveries judged by release policies, programmes, one EAS
              resolver, and the Safe + timelock handover
services/     pii-vault (envelope-encrypted records), notifier (alerts and signed webhooks)
indexer/      Ponder: events → tables → the API, donation tracking and RSS feeds
app/          Next.js dashboard: public needs and tracking pages, embeddable widget, donor, NGO and verifier tools,
              evidence uploads (content-addressed, pinned to IPFS), the free-vote relay, PDF reports
demo/         runs the five lifecycle scenarios against a live chain (escrow, expiry, conversions, idle capital,
              rejection)
scripts/      deploy (local and Base Sepolia), `pnpm admin` for timelocked admin actions after the handover
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
well under 0.001 ETH, and the script reuses the EAS, Safe, Uniswap and Chainlink contracts already deployed there.
Its last step hands the admin role to a Safe (`ADMIN_SAFE_OWNERS`) behind a timelock; from then on admin actions
go through `pnpm admin base-sepolia …`:

```bash
pnpm deploy:sepolia
```

## Privacy

No name, ID number, phone number, exact location, photo, or unsalted hash of any of these ever reaches the
chain. Beneficiaries do not appear on chain at all: a programme is a label and a hash of its eligibility rules.
Delivery evidence is public, for donors to judge: photos are stripped of their location and camera metadata before
they are stored, and the NGO is told
to black out names, faces and account numbers first. Impact reports below five people served are refused so a
count cannot identify a person. Donors are tracked by a
receipt id or a deposit address, never by name; alert emails are encrypted and destroyed on unsubscribe.
Right to erasure is handled by destroying the record's data key (crypto-shredding); nothing on chain refers to the
person. See `docs/THREAT_MODEL.md` for what this does **not** protect against.

## Documentation

- [`docs/DECISIONS.md`](docs/DECISIONS.md) — every open choice and how it was resolved, including v2, v3 conversions and all three adversarial reviews
- [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) — threats, mitigations and residual risk, including conversions, card payments and idle capital
- [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md) — the five-minute walkthrough
- [`docs/GAP_PLAN.md`](docs/GAP_PLAN.md) — the proposal, item by item, and where each lives in the code
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — what is deliberately left out, and what it would take
- [`contracts/README.md`](contracts/README.md) — contract map, need terms, money flow and test suites
