# Demo script — five minutes

**Where this sits in the proposal.** The public proposal (proof-of-aid.lovable.app) plans a regulated payment
provider holding the money first and conditional stablecoin escrow later. This repository runs the end state only:
every donation arrives on chain and waits in its need's own vault (see `docs/DECISIONS.md` §20), and since v8 the
people who paid decide when each tranche after the first is released (§21).

The whole point of the demo is one sentence: **a judge should be able to open a single need page and follow the
money from "someone said this need is real" to "the donors approved how it was spent", without taking
anyone's word for it.** Everything below serves that.

---

## 0. Before the demo (10 minutes, done once)

### Local (recommended for a live demo — instant, no gas, no faucet)

```bash
pnpm install
cp .env.example .env
pnpm chain            # terminal 1: anvil
pnpm deploy:local     # terminal 2: deploy + register schemas + seed demo data
pnpm --filter @poa/indexer dev    # terminal 3: indexer on :42069
pnpm --filter @poa/app dev        # terminal 4: dashboard on :3000
pnpm services:up                  # optional: pii-vault, notifier (alerts)
```

### Base Sepolia (for a public, verifiable demo)

Put a funded deployer key and a Basescan key in `.env`, then:

```bash
pnpm deploy:sepolia    # deploy + verify, register the three schemas, seed, create the test Uniswap pool;
                       # archives the previous release first
```

Donations in USDC never touch a pool — the vaults hold USDC — so they cannot fail on a price. If a **euro**
donation starts reverting on testnet, someone moved the test pool (the mock tokens are freely mintable):
`pnpm deploy:sepolia liquidity` swaps it back to the oracle price.

`SeedDemo` funds every role wallet with a little ETH, so no faucet round-trip is needed mid-demo.

### Rehearse the lifecycle once

```bash
pnpm demo:run              # anvil
pnpm demo:run base-sepolia # testnet
```

This runs four needs unattended and prints an explorer link for every step: an **escrow** need (a wallet donor
and a card donor; after tranche 0 the NGO files a receipt for each tranche and the donors approve it before the
next one is paid), a need whose **funding deadline passes below its minimum**, so it expires and the donor is
refunded, a need funded in **full blockchain mode** (USDC bought by card — mocked on testnets, where Coinbase
Onramp does not deliver — euros and ETH swapped on Uniswap under the Chainlink bound, and an exchange withdrawal to
a deposit address), and an **idle-capital** need whose committed money earns in a lending venue while it waits.
Every need pays its tranches straight to the suppliers in its payment plan. Run it once before the demo so the
dashboard has data and you have the tracking links it prints at the end. Pass scenario names to run a subset:
`pnpm demo:run base-sepolia onchain conversion`.

---

## The cast

Role wallets derive from the mnemonic in `DEMO_MNEMONIC` (anvil's default mnemonic when unset), so they are the
same on every machine:

| # | Role | Address (anvil default) | What they do on stage |
|---|---|---|---|
| 0 | Platform admin | `0xf39Fd6e5…92266` | Registered the organizations and suppliers; can pause |
| 1 | NGO | `0x70997970…dc79C8` | Creates the need, releases tranches, files the evidence for each one |
| 2 | NGO payout Safe | `0x3C44CdDd…4293BC` | Receives the NGO's own disclosed share, never a supplier's |
| 4 | Verifier 1 | `0x15d34AAf…2C6A65` | Attests the need is real |
| 5 | Verifier 2 | `0x9965507D…B0A4dc` | Second signature on high-value needs and supplier changes |
| 7 | Donor (wallet) | `0x14dC7996…3d9955` | Donates stablecoin, gets a soulbound receipt, approves deliveries |
| 8 | Donor (card) | `0x23618e81…B3f8f` | Pays by card through the on-ramp sandbox, then approves like any donor |
| 9 | Relayer | `0xa0Ee7A14…a79720` | Mints the sandbox on-ramp's test USDC and sweeps deposit addresses |

Beneficiaries have **no wallet and no address** — that is the point. They exist on-chain only as Semaphore
identity commitments.

---

## The five minutes

### 0:00 — The problem (30s, no screen)

> "An NGO, a donor platform, a bank and a supplier each hold a piece of the story of a donation. Nobody holds
> all of it, so 'was the aid delivered?' is answered by a PDF. And the one group with the most to lose from
> transparency — the people receiving aid — is the group that gets exposed by it. We put the *flows and the
> proofs* on-chain and kept the *people* off it."

### 0:30 — Start where a donor starts: the tracking link (60s)

Open the card donor's tracking link that `pnpm demo:run` printed (`/en/track/0x…`).

> "I gave by card. I have no wallet, and I get this link. Five stages, the ones the proposal promises: verified,
> funded, settled, delivered, impact confirmed. Each one is a link to the transaction or the attestation that
> reached it, signed by somebody accountable for it. Not a status someone typed into a CRM."

Click one Basescan link and one EAS link. Then show the "Embed this" snippet and the alerts form:

> "Any NGO can drop this widget on its own website. And I can get alerts by email, webhook or RSS without an
> account; my email is encrypted and destroyed when I unsubscribe."

Open the need page from there and scroll its **Terms** panel and timeline once:

> "The NGO committed to these terms before anyone gave: a funding deadline, a minimum of 60% to go ahead, a cap of
> 1.5% on intermediary costs, an expected outcome. The contract enforces them. Fees the provider and the NGO
> reported are counted against that cap, cumulatively."

### 1:30 — Who is allowed to say a need is real (45s)

Open `/verifier`.

> "The NGO cannot verify its own need. That is not a policy in a document, it is a precondition the contract
> checks: one address holds one role, and a verifier that is the NGO or the Safe that receives its money is
> rejected. Above ten thousand units you need two independent verifiers. One rejection
> kills the need."

If asked to prove it: the test `test_nonIndependentVerifierCannotVerifyANeed` does exactly this.

### 2:15 — The donors decide (75s) — **the heart of the demo**

Open the escrow need from the demo run and scroll to **Deliveries**.

> "Tranche zero pre-finances the work. Every tranche after it has to be earned: the NGO shows what the money it was
> already paid bought — photos, the supplier's invoice, the bank statement. Each file is committed on chain by its
> hash, so it cannot be swapped after anyone has seen it."

Point at the approval bar, then at the **Approve** panel beside it (connect a donor wallet if you have one):

> "Then the people who paid decide. A donor's say weighs what they gave — splitting a gift across a hundred wallets
> gains nothing — and once donors who gave 30% of the money approve, the next tranche is released straight to the
> suppliers. The NGO and its suppliers have no vote, however much they donated. And if nobody is convinced, the
> money simply stays in escrow until the deadline, and then goes back."

### 3:30 — What happens when a need fails (45s)

Open the expired need from the demo run.

> "This one missed its minimum by the deadline. Nobody had to decide anything: anyone could call expire, and the
> donor got every unit back. A need whose donors never approve its evidence ends the same way — the unreleased
> money goes back, pro rata. Wallet donors see all of it through their soulbound receipt at `/donor`, and anyone
> can download the whole need as a PDF audit report."

**If you have 30 more seconds — full blockchain mode.** Open the converted need from the demo run.

> "This donor paid by card. Coinbase Onramp put USDC in their own passkey wallet — never ours — and one tap donated
> it. The vaults hold USDC, so every cent reached the need: no pool, no price, no cost. This donor gave euros
> instead: the contract swapped them on Uniswap and refused anything below the Chainlink price minus 1%, and what
> the swap cost is recorded on the donation and counted against the cost cap the NGO published. And this one came
> from an exchange to a deposit address that commits to this need: only what the need could still take was donated,
> the rest went straight back."

### 4:15 — Where it can still go wrong (30s)

> "Hash anchoring proves evidence has not changed. It does not prove the photo is real. A staged photo hashes
> just as well. What makes it expensive is the combination: an independent verifier before any money moves,
> donors with their own money at stake reading the receipts, 30% of the money having to agree, and tranches, so
> fraud stops at the first unconvincing account instead of taking the whole budget. The honest weak spot is donor
> apathy, and collusion between an NGO and a large donor — both written down in our threat model, not hidden."

### 4:45 — Close (15s)

> "Verified needs, traceable donations, proof of delivery, beneficiaries who stay anonymous, impact anyone can
> recompute. On Base, with EAS and Semaphore. The chain holds the flows and the proofs; it never holds people."

---

## If something breaks

| Symptom | Fix |
|---|---|
| Dashboard shows no needs | The indexer is not running or is still syncing: `pnpm --filter @poa/indexer dev` and check `GET /needs` |
| A transaction reverts with a custom error | The error names the reason (`NotIndependent`, `NotADonor`, `PreviousTrancheNotReleased`…). Read it out — it is a feature, not an excuse |
| Evidence files do not show on the need page | They are served by the app that received the upload; run the demo with the dashboard up, or upload from the NGO dashboard |
| A role wallet is out of gas on testnet | Re-run `pnpm deploy:sepolia seed`; it tops the role wallets up |
| Tracking page says "not found" | The indexer has not reached that block yet; the widget refreshes every minute on its own |
| A euro or ETH donation reverts | `FeeExceedsDisclosure`: the need allows no intermediary costs, give EURC. `InsufficientOutput` / "Too little received": the pool is off the oracle price, run `pnpm deploy:sepolia liquidity`. `StalePrice`: a Chainlink feed has not updated within its heartbeat |

### 3:45 — Who actually got the money (20s)

Open the need page and scroll to **"Who the vault pays"**.

> "The NGO does not receive this money. When the need was registered it named who would be paid and what share of
> every tranche each of them gets — vetted suppliers the admin registered, and itself only for the share it
> disclosed, capped at a quarter of the need. Verified on chain with the rest of the need. Releasing a tranche pays
> them directly, in the same transaction, and each payment is an event with its own link. Replacing a supplier
> takes the NGO plus two independent verifiers, and a tranche someone has already earned cannot be redirected."

## Questions judges actually ask

**"What stops the NGO from just making all of this up?"**
Independent verification before any money moves, then the donors themselves: every tranche after the first waits
for the NGO's receipts and statements to be approved by donors who gave 30% of the money, and those documents are
public for anyone to check against the supplier payments the vault made. Tranches bound the loss at the first
unconvincing account. And the honest part: a forged receipt hashes as well as a real one — what we add is that it
has to fool people who paid.

**"Why not just put the beneficiary list on IPFS?"**
Because a hash of a name is still a name to anyone who can guess it, and an encrypted list is one leaked key
away from being a targeting list. Beneficiaries appear only as Poseidon commitments, and erasure is destroying
the data key.

**"Is this GDPR compliant?"**
Crypto-shredding plus removal from the group is a defensible erasure story, and no personal data is ever on
chain. It still needs a legal review before production, and we say so in the threat model.

**"What if the admin key is stolen?"**
They can pause the system and cancel needs — which refunds donors — and register bogus organizations. They
cannot withdraw from a vault: there is no admin withdrawal path, releases only go to the payees fixed in each
need's payment plan, and they cannot approve a delivery on the donors' behalf.

**"Couldn't someone manipulate the swap?"**
They can make it revert, not steal from it. The minimum output comes from Chainlink, not from the caller or the
pool; routes can only pass through USDC and WETH; only the donor or our keeper can sweep a deposit address, so
nobody can wrap a sweep between two trades of their own; and even our admin key needs two public days to change a
price feed or a route.

**"Why Base?"**
Cheap enough that every donor can approve every delivery, EAS and Semaphore v4 already deployed, and Coinbase
Smart Wallet means a donor with no crypto can still get a passkey wallet.
