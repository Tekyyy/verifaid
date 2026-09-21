# Demo script — five minutes

**Where this sits in the proposal.** The public proposal (proof-of-aid.lovable.app) plans two custody models and
recommends starting with the non-custodial one: *Model A*, where a regulated payment provider holds the money and
the chain holds the rules and the evidence, then moving to *Model B*, conditional stablecoin escrow, in a later
phase. This repository runs **both, side by side, on the same contracts**: every need picks its custody model,
and deadlines, thresholds, tranches, the three-signal delivery gate and the impact chain are identical in both.
So the demo can show the proposal's first phase and its end state in one sitting.

The whole point of the demo is one sentence: **a judge should be able to open a single need page and follow the
money from "someone said this need is real" to "beneficiaries confirmed they received the aid", without taking
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
pnpm services:up                  # optional: evidence, pii-vault, bank-connector (card checkout), notifier (alerts)
```

### Base Sepolia (for a public, verifiable demo)

Put a funded deployer key and a Basescan key in `.env` (with `CHALLENGE_PERIOD_SECONDS=60`), then:

```bash
pnpm deploy:sepolia    # deploy + verify, register the six schemas, seed, create the test Uniswap pool;
                       # archives the previous release first
```

Donations in USDC never touch a pool — the vaults hold USDC — so they cannot fail on a price. If a **euro**
donation starts reverting on testnet, someone moved the test pool (the mock tokens are freely mintable):
`pnpm deploy:sepolia liquidity` swaps it back to the oracle price.

Use a **60-second challenge period** for the demo deployment. The default of 600s is realistic but makes a live
walkthrough painful; say out loud that production would use 72 hours.

`SeedDemo` funds every role wallet with a little ETH, so no faucet round-trip is needed mid-demo.

### Rehearse the lifecycle once

```bash
pnpm demo:run              # anvil
pnpm demo:run base-sepolia # testnet
```

This runs four needs unattended and prints an explorer link for every step: an **on-chain** need (wallet and
card donors, settlements after every release), an **off-chain** need (the payment provider records every payment
and payout by attestation, no token moves), a need whose **funding deadline passes below its minimum**, so it
expires and the donor is refunded, and a need funded in **full blockchain mode**: USDC bought by card (mocked on
testnets, where Coinbase Onramp does not deliver) donated from the donor's own wallet as it is — the vaults hold
USDC, so there is nothing to swap — a euro donation and an ETH donation that *are* swapped on Uniswap under the
Chainlink bound, and an exchange withdrawal to a deposit address that the keeper sweeps. Every on-chain need pays
its tranches straight to the suppliers in its payment plan. Run it once before the demo so the Semaphore proving keys are cached, the
dashboard has data, and you have the tracking links it prints at the end. Pass scenario names to run a subset:
`pnpm demo:run base-sepolia onchain conversion`.

---

## The cast

Role wallets derive from the mnemonic in `DEMO_MNEMONIC` (anvil's default mnemonic when unset), so they are the
same on every machine:

| # | Role | Address (anvil default) | What they do on stage |
|---|---|---|---|
| 0 | Platform admin | `0xf39Fd6e5…92266` | Registered the organizations; can pause; resolves disputes |
| 1 | NGO | `0x70997970…dc79C8` | Creates the need, receives tranches at its payout Safe |
| 2 | NGO payout Safe | `0x3C44CdDd…4293BC` | The only address that can ever receive released funds |
| 3 | Field agent | `0x90F79bf6…93b906` | Opens deliveries, uploads evidence |
| 4 | Verifier 1 | `0x15d34AAf…2C6A65` | Attests the need is real |
| 5 | Verifier 2 | `0x9965507D…B0A4dc` | Signs off on deliveries (and could challenge) |
| 6 | Payment provider | `0x976EA740…3a0aa9` | Deposits card and bank payments on-chain, or holds the money for an off-chain need and attests it |
| 7 | Donor (crypto) | `0x14dC7996…3d9955` | Donates stablecoin, gets a soulbound receipt |
| 9 | Relayer | `0xa0Ee7A14…a79720` | Submits beneficiary confirmations so their wallets never appear |

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
> checks: one address holds one role, and a verifier that is the NGO, one of its field agents, or the Safe that
> receives the money is rejected. Above ten thousand units you need two independent verifiers. One rejection
> kills the need."

If asked to prove it: the test `test_nonIndependentVerifierCannotVerifyNeedOrDelivery` does exactly this.

### 2:15 — The beneficiary page (75s) — **the heart of the demo**

Open `/confirm/1` on a phone (or a narrow browser window).

> "This is what a beneficiary sees. Their identity was generated on this device and never leaves it. When they
> confirm, the phone builds a zero-knowledge proof: 'I am one of the people enrolled in this programme, and I
> am confirming this specific delivery' — without revealing which one they are."

Tap confirm. While it generates:

> "The proof is submitted by a relayer, not by them. If they sent it themselves, their wallet address would be
> on-chain next to the confirmation and the zero-knowledge proof would be pointless. What lands on-chain is a
> nullifier and a counter: seven of ten confirmed. Nothing else. They cannot confirm twice, because the
> nullifier is scoped to this delivery — and the contract, not our code, enforces that."

Then show the delivery on the need page: the count went up.

### 3:30 — Two custody models, one set of rules (45s)

Open the off-chain need from the demo run, then the expired one.

> "This need's money never touched the chain: a payment provider holds it, as the proposal's first phase
> recommends. The provider's attestations recorded every payment and every payout, and the provider was named up
> front, so no one else can speak for this money. Same deadlines, same tranches, same anonymous confirmations
> gating each payout."

> "And this one missed its minimum by the deadline. Nobody had to decide anything: anyone could call expire, and
> the donor got every unit back. Wallet donors see the same thing through their soulbound receipt at `/donor`,
> and anyone can download the whole need as a PDF audit report."

**If you have 30 more seconds — full blockchain mode.** Open the converted need from the demo run.

> "This donor paid by card. Coinbase Onramp put USDC in their own passkey wallet — never ours — and one tap donated
> it. The vaults hold USDC, so every cent reached the need: no pool, no price, no cost. This donor gave euros
> instead: the contract swapped them on Uniswap and refused anything below the Chainlink price minus 1%, and what
> the swap cost is recorded on the donation and counted against the cost cap the NGO published. And this one came
> from an exchange to a deposit address that commits to this need: only what the need could still take was donated,
> the rest went straight back."

### 4:15 — Where it can still go wrong (30s)

> "Hash anchoring proves evidence has not changed. It does not prove the photo is real. A staged photo hashes
> just as well. What makes it expensive is the combination: independent verification, anonymous confirmations
> from real people at a threshold, a challenge window where any other verifier can freeze the money, and
> tranches, so fraud stops at the first unproven delivery instead of taking the whole budget. Collusion between
> an NGO and its verifier is the residual risk, and the fix is staking and random assignment — that is written
> down in our threat model, not hidden."

### 4:45 — Close (15s)

> "Verified needs, traceable donations, proof of delivery, beneficiaries who stay anonymous, impact anyone can
> recompute. On Base, with EAS and Semaphore. The chain holds the flows and the proofs; it never holds people."

---

## If something breaks

| Symptom | Fix |
|---|---|
| Dashboard shows no needs | The indexer is not running or is still syncing: `pnpm --filter @poa/indexer dev` and check `GET /needs` |
| A transaction reverts with a custom error | The error names the reason (`NotIndependent`, `TooFewRecipients`, `ChallengePeriodActive`…). Read it out — it is a feature, not an excuse |
| Proof generation is slow the first time | Semaphore's proving keys are being downloaded. Run `pnpm demo:run` once before the demo |
| Challenge window has not elapsed | On anvil: `cast rpc evm_increaseTime 601 && cast rpc evm_mine`. On testnet, wait — or use the pre-run need |
| A role wallet is out of gas on testnet | Re-run `pnpm deploy:sepolia seed`; it tops the role wallets up |
| Tracking page says "not found" | The indexer has not reached that block yet; the widget refreshes every minute on its own |
| Card checkout fails | The bank connector is not running (`pnpm services:up`) or the need is not open for funding any more |
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
Independent verification before any money moves, beneficiary confirmations they cannot forge at scale without
enrolling fake people, a verifier who can challenge, and tranches so the loss is bounded at the first
unverified delivery. And the honest part: enrollment fraud is a human problem — we make it auditable
(`enrollmentPolicyHash` commits to the published eligibility rules), not impossible.

**"Why not just put the beneficiary list on IPFS?"**
Because a hash of a name is still a name to anyone who can guess it, and an encrypted list is one leaked key
away from being a targeting list. Beneficiaries appear only as Poseidon commitments, and erasure is destroying
the data key.

**"Is this GDPR compliant?"**
Crypto-shredding plus removal from the group is a defensible erasure story, and no personal data is ever on
chain. It still needs a legal review before production, and we say so in the threat model.

**"What if the admin key is stolen?"**
They can pause the system and cancel needs — which refunds donors — and register bogus organizations. They
cannot withdraw from a vault: there is no admin withdrawal path, and releases only go to the payout address
recorded at registration, which has no setter.

**"Isn't the off-chain model just trusting the payment provider?"**
Yes, for the money itself, and the proposal says so too. What changes is that every claim the provider makes is
signed, dated and specific: this payment, this fee, this payout of this tranche to this supplier reference. An
auditor compares its books to its attestations line by line. And the provider cannot unlock anything on its own:
payouts after the first still need evidence, anonymous confirmations and an independent sign-off.

**"Couldn't someone manipulate the swap?"**
They can make it revert, not steal from it. The minimum output comes from Chainlink, not from the caller or the
pool; routes can only pass through USDC and WETH; only the donor or our keeper can sweep a deposit address, so
nobody can wrap a sweep between two trades of their own; and even our admin key needs two public days to change a
price feed or a route.

**"Why Base?"**
Cheap enough that a per-beneficiary confirmation is viable, EAS and Semaphore v4 already deployed, and Coinbase
Smart Wallet means a donor with no crypto can still get a passkey wallet.
