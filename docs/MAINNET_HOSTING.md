# Railway and Vercel changes for mainnet

What to change in the hosts once the contracts are on Base mainnet. The contracts step is `docs/MAINNET.md`. The
aim: **www.verifaid.org serves Base mainnet**, and the testnet stays online as a staging site at
**testnet.verifaid.org**.

Do the steps in order. The live site keeps working throughout, and the last step is the only one visitors notice.

---

## 0. Before touching the hosts

- **Contracts deployed.** `pnpm deploy:mainnet --yes` has run, and `deployments/base.json` plus
  `contracts/broadcast/*/8453/` are committed.
- **`mainnet-prep` merged into `main`.** The site finds the mainnet addresses in its own build: without
  `deployments/base.json` in `main`, a site set to Base mainnet shows "missing deployment".
  - Pushing `deployments/**` also redeploys the testnet indexer and notifier. That's harmless; the indexer
    re-indexes for a few minutes.
- **Ready to paste:**

| What | Where to get it |
|---|---|
| A Base mainnet RPC URL | Alchemy or QuickNode, a Base mainnet app (the free tier is fine to start) |
| A new relayer key, funded with ~0.01 ETH on Base | a fresh wallet; never the testnet one, never in git |
| A new `NOTIFIER_KEK` (64 hex characters) | `openssl rand -hex 32`. Keep a copy: losing it makes stored email addresses unreadable |
| A new `NGO_KEK` and `SESSION_SECRET` (64 hex characters each) | `openssl rand -hex 32`, twice. Keep a copy of `NGO_KEK`: losing it makes stored NGO records unreadable |
| Coinbase Onramp keys `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` | portal.cdp.coinbase.com → project → Onramp, with `www.verifaid.org` on its domain allowlist |
| Resend key (for alert emails) | resend.com, with `verifaid.org` verified (DNS records at name.com) |

---

## 1. Keep the testnet online: testnet.verifaid.org

Do this first, so the testnet never goes dark.

**Vercel**
1. **Add New → Project → Import** the same repo again, and name it e.g. `verifaid-testnet`.
   - Root Directory: `app`
   - Production Branch: `main`
2. **Environment Variables:** the testnet values the current project uses today.

   | Name | Value |
   |---|---|
   | `NEXT_PUBLIC_INDEXER_URL` | `https://hackathon-blockchainforgood-production.up.railway.app` |
   | `RELAYER_PRIVATE_KEY` | the testnet relayer key (the value in `app/.env.local`) |
   | `UPLOAD_DIR` | `/tmp/verifaid-uploads` |
   | `PINATA_JWT` | your Pinata key |
   | `NOTIFIER_URL` | the testnet notifier's domain, if you created it |
   | `NEXT_PUBLIC_PII_VAULT_URL` | the testnet records vault's domain, if you created it (with `https://`) |

   Leave `NEXT_PUBLIC_CHAIN_ID` unset: unset means Base Sepolia.
3. **Settings → Domains → Add** `testnet.verifaid.org`. At name.com, add the **CNAME** record Vercel shows, with host
   `testnet`.

**Railway (the existing testnet project)**
- Set `APP_BASE_URL=https://testnet.verifaid.org` on the indexer, and on the notifier if it exists.
- On the records vault, if it exists: `SIWE_DOMAIN=testnet.verifaid.org` and `CORS_ORIGIN=https://testnet.verifaid.org`.
  The vault only answers the site it names, so without this the staging site cannot store or read assessments.

**Optional:** point the testnet's receipt NFTs at the staging site. It's a 10-minute timelocked action:

```bash
pnpm admin base-sepolia run DonationReceipt "setDashboardBaseURI(string)" https://testnet.verifaid.org/needs/
```

---

## 2. Railway: a separate mainnet project

A separate project keeps mainnet's database and settings apart from the testnet's.

1. **New Project → Deploy PostgreSQL.** Name the project e.g. `verifaid-mainnet`.
2. **Indexer: + Create → GitHub Repo →** the repo.
   - **Settings:** branch `main`; Config-as-code `/indexer/railway.json`; Root Directory empty.
   - **Variables:**

     | Name | Value |
     |---|---|
     | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
     | `PONDER_NETWORK` | **`base`** (the Dockerfile defaults to `base-sepolia`) |
     | `PONDER_RPC_URL` | the Base mainnet RPC URL |
     | `PORT` | `42069` |
     | `RAILWAY_DOCKERFILE_PATH` | `indexer/Dockerfile` |
     | `APP_BASE_URL` | `https://www.verifaid.org` |

   - **Networking → Generate Domain**, port **42069**. Optional: a custom domain `api.verifaid.org` (Railway shows the
     CNAME record for name.com; Hobby allows two).
   - **Check:** `https://<indexer>/ready` → `200`, and `/needs` returns `[]`, or the needs registered so far.
3. **Notifier: + Create → GitHub Repo →** the repo again.
   - **Settings:** branch `main`; Config-as-code `/services/notifier/railway.json`; Root Directory empty.
   - **Variables:**

     | Name | Value |
     |---|---|
     | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}?schema=verifaid` |
     | `NOTIFIER_KEK` | the new 64-hex key (not the testnet's) |
     | `INDEXER_URL` | the mainnet indexer's domain |
     | `APP_BASE_URL` | `https://www.verifaid.org` |
     | `PUBLIC_BASE_URL` | this notifier's own domain (after the next step) |
     | `PORT` | `4004` |
     | `EMAIL_API_URL` | `https://api.resend.com/emails` |
     | `EMAIL_API_KEY` | the Resend key |
     | `EMAIL_FROM` | `VerifAid <alerts@verifaid.org>` |
     | `RAILWAY_DOCKERFILE_PATH` | `services/notifier/Dockerfile` (without it Railway may guess the build: "Railpack failed") |

   - **Networking → Generate Domain**, port **4004**, then set `PUBLIC_BASE_URL` to it.
   - **Check:** `https://<notifier>/health` → `"status":"ok"`, `"production":true`, and `"emailDriver":"api"` once the
     Resend key is in.
4. **Records vault: + Create → GitHub Repo →** the repo once more.
   - **Settings:** branch `main`; Config-as-code `/services/pii-vault/railway.json`; Root Directory empty.
   - **Variables:**

     | Name | Value |
     |---|---|
     | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}?schema=verifaid` (shared with the notifier) |
     | `NGO_KEK` | the new 64-hex key (not the testnet's). **Required**: without it every stored record is lost on the next deploy |
     | `SESSION_SECRET` | the new 64-hex secret |
     | `SIWE_DOMAIN` | `www.verifaid.org` |
     | `CORS_ORIGIN` | `https://www.verifaid.org` |
     | `POA_NETWORK` | **`base`** |
     | `RPC_URL` | the Base mainnet RPC URL |
     | `PORT` | `4002` |
     | `RAILWAY_DOCKERFILE_PATH` | `services/pii-vault/Dockerfile` |

   - **Networking → Generate Domain**, port **4002**.
   - **Check:** `https://<vault>/health` → `"status":"ok"` and `"network":"base"`.
5. **Plan:** the Hobby plan ($5 a month) or above. The Free plan cannot keep an indexer running.

---

## 3. Vercel: switch www.verifaid.org to mainnet

In the **existing** project (the one serving www.verifaid.org), go to **Settings → Environment Variables**. Edit the
**Production** values only: Preview deployments of other branches keep the testnet values.

| Name | Now (testnet) | Mainnet |
|---|---|---|
| `NEXT_PUBLIC_CHAIN_ID` | unset (Base Sepolia) | **`8453`** |
| `NEXT_PUBLIC_INDEXER_URL` | the testnet indexer | the mainnet indexer (or `https://api.verifaid.org`) |
| `RELAYER_PRIVATE_KEY` | testnet relayer | **the new mainnet relayer key** |
| `NOTIFIER_URL` | testnet notifier | the mainnet notifier |
| `NEXT_PUBLIC_PII_VAULT_URL` | testnet vault | the mainnet records vault, with `https://` (type **Config**, not Secret) |
| `UPLOAD_DIR` | `/tmp/verifaid-uploads` | same |
| `PINATA_JWT` | your key | same key (or a separate Pinata key for mainnet) |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | — | Vercel → **Storage / Marketplace → Upstash Redis → Connect**. It adds `KV_REST_API_URL` / `KV_REST_API_TOKEN`, which work as they are |
| `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` | — | the Coinbase Onramp keys |
| `NEXT_PUBLIC_PAYMASTER_URL` | — | optional: a CDP paymaster for Base mainnet, so smart-wallet users pay no gas. You pay it instead |

Then **Deployments → Redeploy**. `NEXT_PUBLIC_*` values are baked in at build time, so saving alone changes nothing.

On chain 8453:
- card payments switch to the real Coinbase checkout by themselves;
- the test-USDC mint is refused;
- EURC and ETH donations convert through Uniswap.

If an organisation runs the site, move to **Vercel Pro**: Hobby is for non-commercial use.

---

## 4. Right after the switch

- **Look at the site:** www.verifaid.org shows Base, not Base Sepolia. Check `/needs`, `/baskets` and a tracking page.
- **Make the relayer a keeper**, so "Sweep now" works on deposit addresses. Skip this if its address was in
  `KEEPERS` at deploy time. Otherwise it goes through the Safe and the timelock:

  ```bash
  pnpm admin base prepare DonationForwarderFactory "setKeeper(address,bool)" <relayer address> true
  ```

  Import the schedule file in the Safe app, and the execute file once the delay has passed.
- **Register any further NGOs, verifiers and suppliers** the same way, with `prepare`. The ones listed in
  `.env.mainnet` at deploy time are already registered.
- **Make one small real donation** (1 USDC). Check the receipt, the tracking page, and an alert subscription
  (webhook or email).
- **Watch the relayer's balance.** Keep ~0.01 ETH. It pays for free votes, sweeps and refunds.

## Rolling back

Set the Production variables back to the testnet values in §3 and redeploy. The site is back on the testnet within
minutes. The mainnet contracts keep running untouched: nothing on the hosts can move their money.

## Monthly cost

| Item | Cost |
|---|---|
| Railway, two projects (testnet and mainnet) | ~$5–15 |
| Vercel | free on Hobby; Pro is $20 per member |
| Alchemy/QuickNode, Upstash, Resend, Pinata | free tiers at first |
| Relayer gas on Base | cents |
