# VerifAid — project status

A snapshot of everything this machine and the working session hold: what is live, what is running, where the
keys are (names only, never values), how to operate it, and what is still open.

*Last updated: 2026-09-24 · code at `500c673` on `main` (pushed to GitHub, nothing uncommitted)*

---

## 1. At a glance

| | |
|---|---|
| Release | **v9**, live on **Base Sepolia** (chain 84532), indexed from block 47,217,423 |
| Source | every contract source-verified on Basescan (18 system contracts + the timelock) |
| Admin | a **TimelockController** (10-minute delay), proposed by a **2-of-3 Safe**; the deployer is only the guardian (pause) |
| Tests | 320 Foundry, 19 shared, 63 notifier, 42 app — all passing; typecheck and Biome lint clean |
| Demo | all 5 scenarios passed on anvil and on Base Sepolia |
| Your wallets | `0xa087…42Da` registered as an NGO; 1,000,000 test USDC each in `0xa087…42Da`, `0x4C2d…3636`, `0x28EA…F708` |
| Open | threshold counts money that cannot vote (item #1, deliberately not done); Pinata key; paymaster URL |

---

## 2. What v9 changed (items 2–8 of the architecture review)

| # | Change | Where |
|---|---|---|
| 2 | Admin moved to a timelock proposed by a 2-of-3 Safe; `GUARDIAN_ROLE` can only pause | `script/Handover.s.sol`, `RoleRegistry`, `scripts/admin.mjs` |
| 3 | Donors can **reject**: 50% of the money rejects; the NGO gets one retry per need, the next rejection cancels it and opens refunds; replacing contested evidence costs the retry | `DeliveryManager.reject`, `NeedsRegistry.onEvidenceRejected` |
| 4 | Evidence files pinned to IPFS (Pinata) when a key is set; CID in the manifest; files read back from IPFS and hash-checked | `app/src/lib/server/ipfs.ts`, `/api/uploads`, `/api/files/[sha256]` |
| 5 | Each need picks a **release policy** at creation and keeps it: *Donors decide* (default), *A verifier checks*, *Donors and a verifier*; new policies need no redeploy | `IReleasePolicy`, `ReleasePolicy`, `NeedsRegistry.setReleasePolicy` |
| 6 | **Free votes**: signed EIP-712 votes (ERC-1271 smart wallets too), relayed by the app | `DeliveryManager.voteBySig`, `/api/relay/vote` |
| 7 | `deployIdle` refuses shares worth less than the deposit (first-depositor attack) | `AidVault.deployIdle` → `DepositShortfall` |
| 8 | Semaphore removed; programmes are labels only; no beneficiary on chain in any form | `ProgramRegistry` replaces `BeneficiaryGroups` |

Design record: `docs/DECISIONS.md` §22. Threats: `docs/THREAT_MODEL.md` §3.4, §3.7, §3.20–3.22.

---

## 2b. On branch `feature/beneficiary-needs` (v10, not deployed, not committed yet)

Your v10 work (beneficiary needs, news, community proofs) plus, from this machine:

- **Rewards are credit, not cash.** `CommunityProofs.rewardProof` now credits `creditOf[filer]`; the filer can only
  spend it with `giveCredit` on a need or a basket. The donor of record is the CommunityProofs contract, so a reward
  buys no vote, and `ReleasePolicy` leaves that money out of the 30%/50% thresholds. A failed need's refund comes
  back as credit (`reclaimCredit`), pro rata.
- **Giving baskets.** `DonationForwarderFactory.donateEqually` splits one gift equally, now, across up to 25 needs of a
  category; each part is a normal donation in the giver's name (receipt, vote, refund). Leftover goes back.
- Indexer: `/baskets`, `/baskets/:category`, `/credits/:address`; donation kinds BASKET and REWARD; timeline
  DonatedBasket / DonatedReward / CreditReclaimed. App: `/baskets`, `/baskets/[category]`, credit panel on `/earn`.
- Demo scenario 7 (`pnpm demo:run anvil baskets`). Docs: DECISIONS §26, THREAT_MODEL §3.26.
- Checked: 390 contract tests, shared 26, app 91, notifier 63; typecheck and lint clean; all seven demo scenarios
  on a fresh anvil with the indexer.

## 3. Live contracts (Base Sepolia)

| Contract | Address |
|---|---|
| RoleRegistry | `0xf42EBd86a3decDD5466540F41D9B9dEeAdCFE8b5` |
| NeedsRegistry | `0xDDf49b52728edc38eB662Fdb934CB19Ec037997a` |
| DeliveryManager | `0xF8FD93f388A45df337f077C36E04E8fDD8844fCC` |
| ReleasePolicy — Donors decide (default) | `0x81123F83CAB4651F1b830E83376cC0Ec8fc8A816` |
| ReleasePolicy — A verifier checks | `0xFA616eAD54Edff5d541eeb1c99888d7F1C5BEB14` |
| ReleasePolicy — Donors and a verifier | `0x5c9A0C7A35EAEf076b7c62f7d2638c394F3E03a7` |
| ProgramRegistry | `0x9e23d1Cc7281c95FA83765517cF770438668d48A` |
| AidVaultFactory | `0x05bcf934DcB1462AA234C854Fd514325895CA161` |
| AidVault implementation | `0x521156892BC1Bc40b1EeabeD4e5F9194bBD976F5` |
| DonationReceipt | `0x191232C46D30923a36cFa2Ff94b47C90203039fB` |
| ProofOfAidResolver | `0xD2771615B63D967Ff2f7D704dE0fdaca985ba181` |
| ConversionRouter | `0x25391Cab52DECb9e451cC247B74FAF5768393A02` |
| DonationForwarderFactory | `0x0a364893BF2686e3982dA7481A4A3aDbF0F38Dc1` |
| DonationForwarder implementation | `0xE9066c7e6E0e8C59a3D399b74B533824a42D0676` |

**Governance**

| | Address |
|---|---|
| TimelockController (the admin, 600 s delay) | `0xf5DD48f4aB8232F32eB527c15d56D39F3314580A` |
| Safe (the only proposer, 2-of-3) | `0xd9575509cE883456185C458b5dD778aD2341b898` |
| Safe owner — you | `0xa08747Ef92c817C7c9cF7170d22CeD148b7742Da` |
| Safe owner — deployer (also the guardian) | `0x7642C9178a738Dd623Aac1F943bAFB81589E9050` |
| Safe owner — "council", demo mnemonic index 6 | `0x95DE870810E8c362571D2098423464d841f20adE` |

**External and test tokens**

| | Address |
|---|---|
| Vault currency: test USDC (mUSDC, freely mintable) | `0x32e8765f9aCF760f4c353e118A6C1a22367a23ff` |
| Test EURC (converted on the way in) | `0xA0523ee77ca7219eD0E4a0FdBc7699C3E1F6eDE5` |
| Idle-capital venue (mock ERC-4626) | `0x1fcc22EfB1e3eD6484d9E944F5eeDD084e29789E` |
| EUR/USD feed (mock) | `0xB192c080451494f90aafDc63155660F611ADcba1` |
| USDC/USD, ETH/USD (Chainlink) | `0xd30e2101…E67A35165`, `0x4aDC6769…c7cb1` |
| Uniswap v3 SwapRouter02 / WETH | `0x94cC0AaC…12bc4` / `0x4200…0006` |
| EAS / SchemaRegistry | `0x4200…0021` / `0x4200…0020` |

**Parameters**: approve 30% of the money, reject 50%, 1 retry, high-value threshold 10,000 USDC (two verifiers),
impact reports need ≥ 5 people served, stablecoin slippage 1%, ETH 1.5% (ETH donations off on testnet).

Everything above is also in `deployments/base-sepolia.json`. Earlier releases: `deployments/base-sepolia.v1–v8.json`.

---

## 4. Data on the testnet

| Need | What | Status | Rule |
|---|---|---|---|
| #1 | FOOD, 5,000 USDC (seeded) | Funding | Donors decide |
| #2 | SHELTER, 12,000 USDC, high value (seeded) | Funding | Donors and a verifier |
| #3 | MEDICAL, 3,000 USDC (seeded) | Funding | Donors decide |
| #4 | Demo: escrow, wallet + card donors, signed votes | Completed | Donors decide |
| #5 | Demo: deadline passed below the minimum | Expired, refunded | Donors decide |
| #6 | Demo: conversions (card USDC, EURC, deposit address) | Funded | Donors decide |
| #7 | Demo: idle capital earning in the venue | Completed | Donors decide |
| #8 | Demo: evidence rejected twice → cancelled, donor refunded 700 | Cancelled | Donors and a verifier |

To leave evidence waiting for a live vote: `pnpm demo:run base-sepolia review`.

---

## 5. What is running on this machine

| Service | Where | Notes |
|---|---|---|
| Dashboard (Next.js) | http://localhost:3000 | preview server "app"; reads `app/.env.local` (Base Sepolia) |
| Indexer (Ponder) | http://localhost:42069 | preview server "indexer"; state in `indexer/.ponder/pglite` |
| anvil | stopped | local chain; `pnpm chain` to start |

Start/stop from the Claude app's preview panel (`.claude/launch.json`: `app`, `indexer`, `app-anvil` on port 3001
for a local chain). After any redeploy: delete `indexer/.ponder/pglite` and `app/.next/cache/fetch-cache`.

---

## 6. Keys and config (names only)

| File | Set | Empty — fill in when you have it |
|---|---|---|
| `.env` (repo root) | `DEPLOYER_PRIVATE_KEY`, `BASESCAN_API_KEY`, `DEMO_MNEMONIC` (wrapped in quotes), `ADMIN_SAFE_OWNERS`, `ADMIN_SAFE_THRESHOLD`, `ADMIN_TIMELOCK_DELAY`, `EXTRA_NGOS`, RPC and indexer settings | `GUARDIAN_ADDRESS` (deployer by default) |
| `app/.env.local` | chain, indexer URL, `RELAYER_PRIVATE_KEY` (pays for relayed votes, sweeps, sandbox mints) | **`PINATA_JWT`** (turns IPFS pinning on), **`NEXT_PUBLIC_PAYMASTER_URL`** (gas-free Smart Wallet transactions) |

Both files are committed to the **private** GitHub repo, as agreed. Never paste their values anywhere public.
Restart the app after editing `app/.env.local`.

---

## 7. How to operate it

```bash
# admin actions (after the handover, every one waits 10 minutes)
pnpm admin base-sepolia status
pnpm admin base-sepolia register-ngo 0xNGO            # pays out to itself
pnpm admin base-sepolia run RoleRegistry "registerVerifier(address)" 0xVERIFIER
pnpm admin base-sepolia run RoleRegistry "registerSupplier(address,bytes32,string)" 0xSUP 0x<32 bytes> ipfs://sup
pnpm admin base-sepolia pause                         # guardian, immediate; unpause is: run RoleRegistry "unpause()"

# tests and checks
pnpm --filter @poa/contracts test     # or: cd contracts && forge test --no-match-path "test/fork/*"
pnpm -r typecheck && npx biome lint .
pnpm --filter @poa/app test

# local chain end to end
pnpm chain                            # terminal 1
pnpm deploy:local --handover          # deploys, seeds, hands over (proposer = anvil #6, 60 s delay)
pnpm demo:run anvil                   # the five scenarios

# redeploy the testnet (wipes its needs; your wallets must be re-set, see §9)
pnpm deploy:sepolia
pnpm sync:deployments && pnpm abis && pnpm --filter @poa/shared build
```

A 2-of-3 Safe action can also be co-signed by you in the Safe web app (app.safe.global, Base Sepolia).

---

## 8. Open items

1. **Item #1, left out on purpose**: the 30% approval (and 50% rejection) is a share of *everything* raised,
   including money that has no vote (the NGO's own gifts, a deposit address that credited itself). A need where
   most of the money cannot vote can stall until its deadline. Fix: take the thresholds over voting money only.
   (v10 already does this for reward credit, which could otherwise be used to freeze a need; the rest is open.)
2. **Pinata key** → `PINATA_JWT` in `app/.env.local`, then restart the app. Until then evidence is on this server only.
3. **Paymaster** → a Coinbase Developer Platform URL in `NEXT_PUBLIC_PAYMASTER_URL` (votes are already free through
   the relayer; this makes every other Smart Wallet transaction free too).
4. Before mainnet: an audit; Safe owners who are really independent (today two of the three keys sit with one
   operator); the default two-day timelock instead of ten minutes; a real sequencer uptime feed.
5. Small leftovers: `docs/ROADMAP.md` still mentions Semaphore identities in a future-work paragraph;
   `scripts/verify-all.mjs` lists `NonCustodialLedger.sol` (removed in v7) in its coverage floor.

---

## 9. Things this machine needs to remember

- **pnpm** is in `~/.npm-global` and **Foundry** in `%USERPROFILE%\.foundry\bin` — neither is on
  the default PATH; prepend both.
- **Ponder** exits when stdin is not a terminal on Windows: run it as `tail -f /dev/null | npx ponder dev`.
- **forge** deploys need `--slow`; verification after the fact needs `--resume --broadcast --verify` (and a
  `forge clean` if artifacts are stale).
- **Public RPC** (`sepolia.base.org`) is load-balanced: reads right after a transaction can lag, and parallel
  deployer transactions race on the nonce — send them one at a time.
- **`DEMO_MNEMONIC` is quoted** in `.env`: strip the quotes before deriving accounts (a helper that did not produced
  a wrong Safe owner once; fixed with a `swapOwner`).
- **After every redeploy**: register `0xa087…42Da` as an NGO (the deploy does it through `EXTRA_NGOS` before the
  handover) and mint 1M mUSDC each to `0xa087…42Da`, `0x4C2d7cD2669B46f49889fFe97B48E15467F03636`,
  `0x28EAb867F1570f00145DC7c65430b7Cd59c3F708` (mUSDC `mint(address,uint256)` is open to anyone).
- The app keeps uploaded evidence in `app/.uploads/`; the PII vault's tests need a private Postgres on port 5434.

---

## 10. Release history

| Version | What it added |
|---|---|
| v1–v2 | Needs and terms, vaults, EAS resolver, tracking, notifier, PDF reports |
| v3 | Conversions (Uniswap v3 + Chainlink), deposit addresses, Coinbase on-ramp |
| v4 | Vaults pay suppliers directly (payment plans); USDC as the vault currency |
| v5 | Donors can withdraw while funding is open; community schemas; tax receipts |
| v6 | Idle capital in an ERC-4626 venue |
| v7 | Money only arrives on chain (cash paths retired) |
| v8 | Donors approve each tranche (weighted by what they gave) |
| v9 | Release policies per need, rejection with one retry, free signed votes, Safe + timelock admin, IPFS evidence, deposit check, Semaphore removed |
| v10 (branch) | Beneficiary-posted needs, news, community proof; rewards as give-only credit; giving baskets |
