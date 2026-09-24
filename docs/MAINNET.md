# Going to Base mainnet

Everything needed to put VerifAid on Base mainnet with real money, what is already done on the `mainnet-prep`
branch, and how the deployment runs. The deployment itself costs well under a dollar in gas at today's prices; the
real costs are the audit and running it properly afterwards.

---

## Done on this branch

| | What | Where |
|---|---|---|
| ✅ | Money that can never vote (the NGO's own gifts, its payout address, payees, the owner's-share payee, the beneficiary, reward credit, deposit addresses that credited themselves) counts for no donor threshold, so it cannot freeze a need | `ReleasePolicy._voiceless`, `AidVault.donatedByRefTotal` |
| ✅ | A beneficiary's own need raises at most the high-value threshold, and one NGO's certificates open at most 20 at a time: an NGO certifying wallets it controls cannot use them to bypass its 25% cap at scale | `BeneficiaryRegistry` |
| ✅ | Secrets out of git: `.env` and `app/.env.local` are no longer tracked; every setting is in the `.example` templates | `.env.example`, `app/.env.example` |
| ✅ | Rate limits shared by every server instance (Upstash Redis), and a daily ceiling on relayed votes | `app/src/lib/server/rateLimit.ts` |
| ✅ | A mainnet deploy script that refuses unsafe setups: a key that was ever in git, Safe owners that include the deployer, a timelock under two days, no separate guardian, no source verification | `scripts/deploy-mainnet.mjs` |
| ✅ | A full rehearsal on a local fork of Base mainnet, against the real USDC, EURC, Uniswap pools, Chainlink feeds, EAS and Safe factory | `scripts/rehearse-mainnet.mjs` |
| ✅ | Wallets that delegated their code (EIP-7702, live on Base) still sign votes, certificates and refunds with their own key; OpenZeppelin's check sent them to ERC-1271 alone. Found by the rehearsal | `libraries/Signatures.sol` |
| ✅ | Mainnet admin without owner keys on any server: `pnpm admin base prepare …` writes Safe Transaction Builder files for the owners to sign in the Safe app | `scripts/admin.mjs` |

Every Base mainnet dependency address in `deploy-mainnet.mjs` was checked on chain (token symbols, feed
descriptions and freshness, the router's factory, pool depth, Safe v1.4.1 and EAS predeploys).

## Still to do before real money

1. **An external security audit** of `contracts/src` (about 3,400 lines in 38 files), then freeze the code. Rough
   market range for this size: $20k–$80k from an established firm, less from a solo auditor or a competitive audit;
   Base and Optimism grants for public goods can fund it. Nothing below replaces it.
2. **Keys.**
   - A fresh deployer key, funded with about 0.005 ETH, that has never been in git.
   - Three Safe owners, each with a hardware wallet (you and two friends).
   - A separate guardian wallet, the pause switch.
   - A fresh relayer key, funded with a little ETH, set only in Vercel.
3. **Legal.**
   - An entity (an association or foundation).
   - Terms and a privacy policy. The records vault holds personal data, so GDPR applies.
   - Whether the tax receipts are valid in each country.
   - A lawyer's view on handling donations and on sanctions screening.
4. **Coinbase.**
   - A project at portal.cdp.coinbase.com with Onramp enabled, and an API key.
   - `www.verifaid.org` on its domain allowlist, and Coinbase's review.
5. **Hosting for mainnet** (see below).
   - A second indexer with its own database.
   - Pinata, now required.
   - Upstash for the rate limits.
   - Vercel Pro if an organisation runs it.
6. **A soft launch:** a few vetted NGOs and low targets first.

## Deploying

### 1. Settings: `.env.mainnet` at the repo root

Git ignores it, like every `.env.*` file. Never put these in the testnet `.env`.

```bash
DEPLOYER_PRIVATE_KEY=0x…            # fresh, funded with ~0.005 ETH, never committed
BASESCAN_API_KEY=…                   # source verification
BASE_MAINNET_RPC_URL=https://…       # an Alchemy / QuickNode Base mainnet URL
ADMIN_SAFE_OWNERS=0xYou,0xFriend1,0xFriend2
ADMIN_SAFE_THRESHOLD=2
ADMIN_TIMELOCK_DELAY=172800          # two days (the minimum the script accepts)
GUARDIAN_ADDRESS=0x…                 # may pause at once, and do nothing else
EXTRA_NGOS=                          # optional: vetted NGO wallets to register before the handover
# DASHBOARD_BASE_URI defaults to https://www.verifaid.org/needs/
```

Every dependency address (USDC, EURC, WETH, the Uniswap router, the Chainlink feeds, EAS) has a checked default in
the script; set one here only to override it. There is no idle-capital venue unless `YIELD_VENUE_ADDRESS` names a
real ERC-4626 vault.

### 2. Rehearse on a fork of mainnet

This costs nothing and touches nothing real:

```bash
pnpm rehearse:mainnet
```

It forks Base mainnet locally and runs `deploy-mainnet.mjs` against the copy, just as it would run for real, with its
own throwaway keys. Then it:
- checks the governance
- registers the demo organisations through the Safe and the two-day timelock, and confirms that executing early is
  refused
- gives the demo wallets real USDC and EURC on the copy
- runs the demo scenarios: conversions, escrow, expiry, rejection, a beneficiary's own need, and baskets with reward
  credit
- checks the guardian can pause

Its records move to `deployments/rehearsal/`, which git ignores, so nothing of it can pass for a mainnet
deployment.

### 3. Check, then deploy

```bash
pnpm deploy:mainnet          # runs every check and prints the plan; deploys nothing
pnpm deploy:mainnet --yes    # deploys: Deploy → schemas → community schemas → NGOs → handover to the Safe
```

### 4. Right after

- **Verify the timelock** on Basescan. The handover deploys it without verification. Use the same `forge verify-contract`
  command as for the testnet, with `--chain base`.
- **Commit** `deployments/base.json` and `contracts/broadcast/*/8453/`.
- Then run `pnpm sync:deployments && pnpm --filter @poa/shared build`.
- **Indexer:** a new Railway service from `indexer/railway.json`, with its own Postgres, and:
  - `PONDER_NETWORK=base`
  - `PONDER_RPC_URL=` a dedicated Base mainnet RPC
  - `PORT=42069`
  - `APP_BASE_URL=https://www.verifaid.org`
- **Site:** in Vercel's production environment, set:
  - `NEXT_PUBLIC_CHAIN_ID=8453`
  - `NEXT_PUBLIC_INDEXER_URL=` the mainnet indexer
  - `RELAYER_PRIVATE_KEY=` the fresh relayer key
  - `PINATA_JWT`
  - `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`
  - `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET`

  On mainnet, card payments switch to the real Coinbase checkout by themselves, and the test-USDC mint is refused.
  Keep the testnet as a staging site, for example at `testnet.verifaid.org`.

### 5. Admin from then on

There are no owner keys on any machine. Each action is prepared here and signed in the Safe app:

```bash
pnpm admin base status
pnpm admin base prepare RoleRegistry "registerVerifier(address)" 0xVERIFIER
```

`prepare` writes two Safe Transaction Builder files to `admin-proposals/`:
1. **Schedule:** import it in the Safe app (Apps → Transaction Builder). The owners sign it.
2. **Execute:** use it two days later, once the delay has passed. Anyone may execute; so can
   `pnpm admin base execute … --salt 0x…` from any funded key.

Until the execute step, the Safe can still cancel the change.
