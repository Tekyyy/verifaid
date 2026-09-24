# VerifAid — project status

A snapshot of everything this machine and the working session hold: what is live, what is running, where the
keys are (names only, never values), how to operate it, and what is still open.

*Last updated: 2026-09-24 · v10 live; `main` and `feature/beneficiary-needs` both at the same code on GitHub*

---

## 1. At a glance

| | |
|---|---|
| Release | **v10**, live on **Base Sepolia** (chain 84532), indexed from block 47,256,760 |
| Source | every contract source-verified on Basescan (20 system contracts + the timelock) |
| Admin | a **TimelockController** (10-minute delay), proposed by your existing **2-of-3 Safe**; the deployer is only the guardian (pause) |
| Tests | 391 Foundry, 26 shared, 64 notifier, 91 app — all passing; typecheck and Biome lint clean |
| Demo | all 7 scenarios passed on anvil and on Base Sepolia |
| Your wallets | `0xa087…42Da` and `0x4C2d…3636` registered as NGOs; 1,000,000 test USDC each in `0xa087…42Da`, `0x4C2d…3636`, `0x28EA…F708` |
| Branch | `main` holds v10 (fast-forwarded from `feature/beneficiary-needs`) |
| Open | threshold counts other money that cannot vote (item #1, reward credit already excluded); Pinata key; paymaster URL |

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

## 2b. What v10 changed

Your v10 work (needs a certified person posts for themselves, news on a need's page, community proof and reward
pots) plus, from this machine:

- **Rewards are credit, not cash.** `CommunityProofs.rewardProof` credits `creditOf[filer]`; the filer can only
  spend it with `giveCredit` on a need or a basket. The donor of record is the CommunityProofs contract, so a reward
  buys no vote, and `ReleasePolicy` leaves that money out of the 30%/50% thresholds. A failed need's refund comes
  back as credit (`reclaimCredit`), pro rata.
- **Giving baskets.** `DonationForwarderFactory.donateEqually` splits one gift equally, now, across up to 25 needs of a
  category; each part is a normal donation in the giver's name (receipt, vote, refund). Leftover goes back.
- **Proof cap.** One wallet may file 3 proofs per need; the need page folds proof after the first ten.
- **No impact report on a person's own need.** The resolver refuses one; trackers show "Impact confirmed" as not
  applicable, and the need is done when its last tranche is paid.
- Indexer: `/baskets`, `/baskets/:category`, `/credits/:address`; donation kinds BASKET and REWARD. App: `/baskets`,
  `/baskets/[category]`, credit panel on `/earn`. Demo scenario 7 (`baskets`).
- Design record: DECISIONS §23, §25, §26. Threats: THREAT_MODEL §3.23, §3.25, §3.26.

## 3. Live contracts (Base Sepolia)

| Contract | Address |
|---|---|
| RoleRegistry | `0x22FCd2D3fC053A22e815bCD038310df6B1517391` |
| NeedsRegistry | `0x84Aca78cEa47830ee59Ee112B084B7d5e5DAA503` |
| BeneficiaryRegistry | `0x50827EE08bB9FcdC0a6563a340ca5694135f2A84` |
| DeliveryManager | `0x1d05bB87E7Fe78951a5a5458D09bb5cC032286AA` |
| ReleasePolicy — Donors decide (default) | `0xDcb7c3562f7A912c714b1b3318Af6EF9ad81B50F` |
| ReleasePolicy — A verifier checks | `0x087BE4fCfafa8530421Cc6817C33F2e6c01357D2` |
| ReleasePolicy — Donors and a verifier | `0x0999eBEf1cA78cAa433Dc67da0A479b0f97F8dF0` |
| CommunityProofs (proof, reward pots, reward credit) | `0xE0821CCA3CB9cDb0B258546e1d093c39260c74f1` |
| ProgramRegistry | `0x4DBb8e4e1db01e8962141DcBb5D17C4161A0a945` |
| AidVaultFactory | `0x4652C505C49f24A80349a4042Dee7d717Cd5D0b2` |
| AidVault implementation | `0xe4847d8d656494C4A32dFF3eC61AaFdF3F158557` |
| DonationReceipt | `0xaab42e8c0181d7E3dfBaBC3a23e0B3aB76A6D18d` |
| ProofOfAidResolver | `0xdCDD41c89749Ab2A9e78bbfb0717bA14C9FE568C` |
| ConversionRouter | `0x75d1546809A5B5d53aB8b2f97f1d5952317aac21` |
| DonationForwarderFactory (also giving baskets) | `0xAe7ce346412b9EdF8E8b331dF7a880F681Ca4dd4` |
| DonationForwarder implementation | `0x68e09558c1A09Be0330e35f914Af763827827553` |

**Governance**

| | Address |
|---|---|
| TimelockController (the admin, 600 s delay) | `0xbB8AD7b251CD4e37B75eac300b571618a1a38368` |
| Safe (the only proposer, 2-of-3, kept from v9) | `0xd9575509cE883456185C458b5dD778aD2341b898` |
| Safe owner — you | `0xa08747Ef92c817C7c9cF7170d22CeD148b7742Da` |
| Safe owner — deployer (also the guardian) | `0x7642C9178a738Dd623Aac1F943bAFB81589E9050` |
| Safe owner — "council", demo mnemonic index 6 | `0x95DE870810E8c362571D2098423464d841f20adE` |

**External and test tokens**

| | Address |
|---|---|
| Vault currency: test USDC (mUSDC, freely mintable) | `0xa7e8cDD8ADc49653DaAD626282F484c79Af6F984` |
| Test EURC (converted on the way in) | `0xCAd6670bFe37a5283933569e83820fa1484D24A5` |
| Idle-capital venue (mock ERC-4626) | `0x3a8Cef9Ba1d847638F5DA14422F10fFd40b86613` |
| EUR/USD feed (mock) | `0x8b26Ba0340D92ecBd624c951906eC91182BCa697` |
| USDC/USD, ETH/USD (Chainlink) | `0xd30e2101…E67A35165`, `0x4aDC6769…c7cb1` |
| Uniswap v3 SwapRouter02 / WETH | `0x94cC0AaC…12bc4` / `0x4200…0006` |
| EAS / SchemaRegistry | `0x4200…0021` / `0x4200…0020` |

**Parameters**: approve 30% of the money, reject 50%, 1 retry, high-value threshold 10,000 USDC (two verifiers),
impact reports need ≥ 5 people served, stablecoin slippage 1%, ETH 1.5% (ETH donations off on testnet).

Everything above is also in `deployments/base-sepolia.json`. Earlier releases: `deployments/base-sepolia.v1–v9.json`.

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
| #8 | Demo: evidence rejected twice → cancelled, donor refunded | Cancelled | Donors and a verifier |
| #9 | Demo: a certified person's own need, every tranche to their wallet | Completed (no impact report) | Donors decide |
| #10, #12 | Demo: water basket (550 each) + 15 each of reward credit | Funding | Donors decide |
| #11 | Demo: water basket filled it (400); a proof on it was rewarded with 30 of credit | Funded | Donors decide |

To leave evidence waiting for a live vote: `pnpm demo:run base-sepolia review`.

---

## 5. What is running on this machine

| Service | Where | Notes |
|---|---|---|
| Dashboard (Next.js) | http://localhost:3000 | preview server "app"; reads `app/.env.local` (Base Sepolia) |
| Indexer (Ponder) | http://localhost:42069 | preview server "indexer" (Base Sepolia, v10); state in `indexer/.ponder/pglite` |
| Local test stack | anvil :8545, indexer :42070, app :3001 | `app-anvil` / `indexer-anvil`; a throwaway chain for checks |

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
pnpm demo:run anvil                   # the seven scenarios

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
- **After every redeploy**: register `0xa087…42Da` and `0x4C2d…3636` as NGOs (the deploy does it through
  `EXTRA_NGOS` before the handover; `.env` lists only `0x4C2d…`, so pass both, as the v10 deploy did) and reuse the
  Safe with `ADMIN_SAFE_ADDRESS=0xd9575509cE883456185C458b5dD778aD2341b898` (otherwise a new Safe is created); then
  mint 1M mUSDC each to `0xa087…42Da`, `0x4C2d7cD2669B46f49889fFe97B48E15467F03636`,
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
| v10 | Needs a certified person posts, news, community proof (3 per wallet per need); rewards as give-only credit; giving baskets; no impact report on a person's own need |
