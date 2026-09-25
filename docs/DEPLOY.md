# Putting VerifAid online

**Live now:** the site at https://www.verifaid.org (Vercel, domain at name.com) and the indexer at
https://hackathon-blockchainforgood-production.up.railway.app (Railway). This guide is how they were set up.

The contracts are already on Base Sepolia. What goes online is the rest:

| Part | Host | Why there |
|---|---|---|
| Web app (`app/`) | **Vercel** | Next.js pages and API routes; Vercel's home ground |
| Indexer (`indexer/`) | **Railway** | Follows the chain around the clock, which a serverless host cannot do |
| Its database | **Railway Postgres** | A container's disk does not outlive a redeploy |
| Notifier, records vault | Railway, later | Only the Alerts page and the NGO records need them |

The repo is set up for both: `indexer/Dockerfile` and `indexer/railway.json` for Railway, `app/vercel.json` for
Vercel. Nothing needs to be typed as a build command.

**Which branch.** Both hosts deploy `main`, which holds the code that matches the live contracts (v10). A branch
without `indexer/railway.json` makes Railway fall back to guessing the build ("Railpack"), which fails.

---

## 1. Railway: the database and the indexer

1. Go to **railway.com** and sign in with GitHub. That starts the 30-day trial ($5 of credit, no card).
2. **New Project → Deploy PostgreSQL** (it may be under *Database*). Wait until it is running.
3. In the same project: **+ Create → GitHub Repo → `Tekyyy/hackathon-blockchainforgood`**. Railway starts a first
   build; it will fail or build the wrong thing until the next step, which is fine.
4. Open the new service → **Settings**:
   - **Source → Branch**: the branch above.
   - **Config-as-code → Railway config file**: `/indexer/railway.json` (this picks the Dockerfile, the health
     check and the restart policy).
   - Leave **Root Directory** empty: the Docker build needs the whole repo.
5. **Variables** tab of the same service, add:

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (type it exactly; Railway fills in the database's address) |
   | `PONDER_RPC_URL` | `https://sepolia.base.org` (or an Alchemy / QuickNode Base Sepolia URL, faster and not rate-limited) |
   | `PORT` | `42069` (Railway sets its own `PORT` otherwise, and the domain below would reach nothing: a 502) |
   | `RAILWAY_DOCKERFILE_PATH` | `indexer/Dockerfile` (a safety net in case the config file is not picked up) |
   | `APP_BASE_URL` | leave for now; set it to the site's address in step 3 |

6. **Settings → Networking → Generate Domain**, port **42069**. You get something like
   `https://verifaid-indexer-production.up.railway.app`. If Networking says "Could not load public networking",
   deploy once first and reload the page.
7. Railway redeploys. The deployment turns healthy once the indexer has caught up with the chain (a few minutes;
   the health check waits up to 10). Check it in a browser:
   - `https://<indexer-domain>/ready` → `200`
   - `https://<indexer-domain>/baskets` → the six giving baskets

Every redeploy indexes into a fresh database schema (Ponder only resumes a schema written by the same build) and
takes those few minutes; the previous deployment keeps serving until the new one is ready. A crash or restart of
the same deployment resumes where it stopped.

## 2. Vercel: the web app

1. Go to **vercel.com** and sign up with GitHub (the free Hobby plan is for non-commercial use, fine for this).
2. **Add New → Project → Import** `Tekyyy/hackathon-blockchainforgood`.
3. **Root Directory**: `app`. Framework: Next.js (detected). Leave the build and install commands alone:
   `app/vercel.json` sets them (install the app and `@poa/shared`, build shared, then the app).
4. **Environment Variables** (all environments):

   | Name | Value |
   |---|---|
   | `NEXT_PUBLIC_INDEXER_URL` | the Railway indexer domain from step 1.6 (`https://…up.railway.app`, no trailing slash) |
   | `UPLOAD_DIR` | `/tmp/verifaid-uploads` (Vercel's only writable folder) |
   | `RELAYER_PRIVATE_KEY` | copy it from `app/.env.local` (the wallet that pays for free votes) |
   | `PINATA_JWT` | your Pinata key, as soon as you have one (see below) |

   Chain, RPC and contract addresses need nothing: the app defaults to Base Sepolia and reads the addresses from
   `deployments/base-sepolia.json`.
5. **Deploy.**
6. Open the site: the needs, `/baskets`, a need page and a donation's tracking page should all show live data.

**Evidence files need Pinata.** The app keeps uploads on its own disk and pins them to IPFS when `PINATA_JWT` is
set. On Vercel that disk is temporary, so without Pinata an uploaded photo or receipt can disappear after a while.
Get a free key at **app.pinata.cloud → API Keys → New Key** (admin or `pinFileToIPFS`), copy the JWT, add it as
`PINATA_JWT` and redeploy.

## 3. Swap the local addresses for the real one

Once the Vercel address is known (e.g. `https://verifaid.vercel.app`):

1. **Railway → indexer → Variables**: `APP_BASE_URL` = the Vercel address. (Links in the RSS feeds.)
2. **Receipt NFTs** point at `http://localhost:3000/needs/` on chain. Changing it is one timelocked admin action,
   run from this machine (it signs with the deployer and council keys of the Safe, then waits 10 minutes):

   ```bash
   pnpm admin base-sepolia run DonationReceipt "setDashboardBaseURI(string)" https://<vercel-address>/needs/
   ```

## 4. Donation alerts: the notifier

The "alert me" form on every donation's tracking page needs the notifier. Until `NOTIFIER_URL` is set in Vercel the
site hides the form instead of showing one that fails.

1. **Railway → your project → + Create → GitHub Repo →** the same repo again. This makes a second service beside the
   indexer.
2. **Settings** of the new service:
   - **Branch:** `main`
   - **Config-as-code → Railway config file:** **`/services/notifier/railway.json`** (not the indexer's).
   - Leave **Root Directory** empty.
3. **Variables:**

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}?schema=verifaid` (its own schema, apart from the indexer's) |
   | `NOTIFIER_KEK` | 64 hex characters (32 bytes) that encrypt stored email addresses. Generate them with `openssl rand -hex 32`. **Keep a copy**: losing it makes every stored address unreadable |
   | `INDEXER_URL` | `https://hackathon-blockchainforgood-production.up.railway.app` |
   | `APP_BASE_URL` | `https://www.verifaid.org` |
   | `PUBLIC_BASE_URL` | this service's own domain, once generated (step 4), for unsubscribe links |
   | `PORT` | `4004` |

4. **Settings → Networking → Generate Domain**, port **4004**. Put that address in `PUBLIC_BASE_URL`.
5. **Deploy.** At start the container creates its tables (`prisma db push`), and `/health` answers once it is up.
6. **Vercel → Settings → Environment Variables:** add `NOTIFIER_URL` = the notifier's domain (`https://…up.railway.app`,
   no trailing slash). Then **redeploy**. The alerts form appears on tracking pages.

**Webhooks work at once. Emails are queued until an email service is set.** To send them, create a free account
at **resend.com**, verify `verifaid.org` there (it gives DNS records to add at name.com), and add to the notifier:

- `EMAIL_API_URL=https://api.resend.com/emails`
- `EMAIL_API_KEY=` your Resend key
- `EMAIL_FROM=VerifAid <alerts@verifaid.org>`

## 5. Later, if you want them

- **NGO records (vault)**: one more Railway service from `services/pii-vault/Dockerfile`, on the same Postgres. The
  site then gets `NEXT_PUBLIC_PII_VAULT_URL`. Until then an NGO creating a need pastes its dossier's hash instead of
  storing the dossier.
- **A custom domain**: add it in Vercel; then redo step 3 with it.
- **Free transactions for smart wallets**: a Coinbase Developer Platform paymaster URL as
  `NEXT_PUBLIC_PAYMASTER_URL`.

## Costs

- Vercel Hobby: free.
- Railway: the trial covers the first 30 days. After it, the Free plan's $1 a month does not keep an indexer running
  all month; the Hobby plan ($5 a month, $5 of usage included) does, with room for the notifier and the vault.
- The relayer wallet pays the gas of relayed votes and sweeps on Base Sepolia (cheap; top it up from a faucet if it
  ever runs dry). Its address is the one `RELAYER_PRIVATE_KEY` belongs to.

## If something goes wrong

| Symptom | Likely cause |
|---|---|
| Railway deployment never turns healthy | `DATABASE_URL` not set to `${{Postgres.DATABASE_URL}}`, or the RPC is rate-limiting: use an Alchemy URL |
| Railway says "Railpack failed to prepare the build" | the branch has no `indexer/railway.json`, or the config-as-code path is not `/indexer/railway.json`; `RAILWAY_DOCKERFILE_PATH=indexer/Dockerfile` also forces the Dockerfile |
| The indexer domain answers 502 "Application failed to respond" | `PORT` is not `42069`, so the app listens on Railway's port while the domain points at 42069 |
| The site says the indexer is unreachable | `NEXT_PUBLIC_INDEXER_URL` missing or has a trailing slash; redeploy after changing it (it is baked in at build time) |
| The site shows old needs or errors on new ones | Vercel is building a branch with the v9 code |
| Uploading evidence fails | `UPLOAD_DIR` not set to `/tmp/verifaid-uploads` |
| Vercel build cannot find `@poa/shared` or `pnpm-lock.yaml` | **Settings → Build → Include files outside the Root Directory** must stay on (the default) |
