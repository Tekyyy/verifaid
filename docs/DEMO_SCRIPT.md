# Demo script — five minutes

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
```

### Base Sepolia (for a public, verifiable demo)

Put a funded deployer key and a Basescan key in `.env`, then:

```bash
cd contracts
CHALLENGE_PERIOD_SECONDS=60 forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --verify
forge script script/RegisterSchemas.s.sol --rpc-url base_sepolia --broadcast
forge script script/SeedDemo.s.sol --rpc-url base_sepolia --broadcast
```

Use a **60-second challenge period** for the demo deployment. The default of 600s is realistic but makes a live
walkthrough painful; say out loud that production would use 72 hours.

`SeedDemo` funds every role wallet with a little ETH, so no faucet round-trip is needed mid-demo.

### Rehearse the lifecycle once

```bash
pnpm demo:run              # anvil
pnpm demo:run base-sepolia # testnet
```

This runs the full lifecycle unattended and prints an explorer link for every step. Run it once before the
demo so the artifacts (Semaphore proving keys) are cached and the dashboard has data.

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
| 6 | Bank partner | `0x976EA740…3a0aa9` | Converts a SEPA transfer and deposits it on-chain |
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

### 0:30 — Start at the end: the need page (60s)

Open `/needs/3` (or whichever id `pnpm demo:run` printed). Scroll the timeline once, top to bottom.

> "One need. Every state change is an event, and every claim is an attestation signed by somebody who is
> accountable for it. Verified here, funded here — this donation is crypto, this one came from a bank transfer.
> Pre-financing released so the NGO could actually buy the goods. Then a delivery: evidence, confirmations,
> sign-off, a challenge window, and only then the next tranche moved."

Click one Basescan link and one EAS link. Let them see it is real.

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

### 3:30 — Follow my money (45s)

Open `/donor` with the donor wallet.

> "A donor holds a soulbound receipt — it cannot be sold or transferred, because it is evidence, not an asset.
> And this is their trace: their share of each tranche that was actually released, the deliveries behind those
> releases, and the confirmation ratios. Not 'we spent your money well'. The chain of evidence, recomputable
> by anyone."

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
| A role wallet is out of gas on testnet | Re-run `forge script script/SeedDemo.s.sol --broadcast`; it tops the role wallets up |

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

**"Why Base?"**
Cheap enough that a per-beneficiary confirmation is viable, EAS and Semaphore v4 already deployed, and Coinbase
Smart Wallet means a donor with no crypto can still get a passkey wallet.
