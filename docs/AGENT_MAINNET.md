# Agent handoff: taking VerifAid to Base mainnet

A quick index for an agent picking this up. Read it top to bottom once; each section points to the file with the
detail. The human-facing version is `docs/MAINNET.md`.

## 0. Ground rules

- **Never print, log, commit or paste a secret.** That covers private keys, the mnemonic, the Basescan key, the
  Pinata JWT, the Upstash token and the CDP keys.
  - Secrets live in `.env` (testnet), `.env.mainnet` (mainnet) and `app/.env.local`, all git-ignored on this branch.
  - Read them only by passing them to child processes through their environment.
- **Anything with real money needs the human, every time.** That covers `pnpm deploy:mainnet --yes`, funding any
  wallet, and signing for the Safe. Prepare it, show the plan, and stop for a yes.
- **Nothing reaches mainnet before an external audit.** No code change can replace it.
- Work on the branch **`mainnet-prep`**. `main` is the live testnet code (www.verifaid.org); don't merge into it unless
  asked.
- Commit or push only when asked. End commits with the co-author line the repo already uses.

## 1. Where things are

| What | Path |
|---|---|
| Contracts (Foundry, Solidity 0.8.24, OZ 5.6) | `contracts/src`, tests in `contracts/test` |
| How a system is deployed (shared by every network) | `contracts/script/lib/SystemDeployer.sol`, `contracts/script/Deploy.s.sol` |
| Handover to the Safe and timelock | `contracts/script/Handover.s.sol` |
| **Mainnet deploy** | `scripts/deploy-mainnet.mjs` (`pnpm deploy:mainnet`) |
| **Mainnet rehearsal on a fork** | `scripts/rehearse-mainnet.mjs` (`pnpm rehearse:mainnet`) |
| Admin (timelock via the Safe) | `scripts/admin.mjs` (`pnpm admin <network> …`) |
| Deployment records (read by everything) | `deployments/<network>.json` → `pnpm sync:deployments` → `services/shared` |
| ABIs for the app, indexer and services | `pnpm abis` → `services/shared/src/abis` |
| Indexer (Ponder 0.17) | `indexer/` (Railway: `indexer/Dockerfile`, `indexer/railway.json`) |
| Web app (Next.js 14) | `app/` (Vercel: `app/vercel.json`) |
| Demo runner (end to end) | `demo/src/run.ts` (`pnpm demo:run <network> [scenarios]`) |
| Why things are the way they are | `docs/DECISIONS.md` (§27 = mainnet prep), `docs/THREAT_MODEL.md` (§3.27) |
| Live state, addresses, running services | `STATUS.md` |

## 2. State right now

- **Live:**
  - v10 on Base Sepolia; addresses in `deployments/base-sepolia.json`.
  - Site: https://www.verifaid.org (Vercel, builds `main`).
  - Indexer: https://hackathon-blockchainforgood-production.up.railway.app (Railway, Postgres).
- **`mainnet-prep`**, pushed but not merged or deployed. On top of `main` it adds:

| Commit | What |
|---|---|
| `ca3e719` | Money that can never vote counts for no donor threshold (`ReleasePolicy._voiceless`, `AidVault.donatedByRefTotal`). A beneficiary's need is capped at `HIGH_VALUE_THRESHOLD`, with at most 20 open per NGO (`BeneficiaryRegistry`) |
| `8482276` | Rate limits shared across server instances through Upstash Redis (`app/src/lib/server/rateLimit.ts`), plus a daily ceiling on relayed votes |
| `e67818c` | `.env` and `app/.env.local` untracked; every setting is in the `.example` templates |
| `c442482` | `libraries/Signatures.sol`: ECDSA first, then ERC-1271, so EIP-7702-delegated wallets can still sign |
| `fd12b81` | Demo: `DEMO_RPC_URL`, `DEMO_FORK=1`, and a vote deadline taken from chain time |
| `43b5c59` | The mainnet deploy script, the rehearsal, `admin.mjs` support for mainnet (`prepare`), and the docs |

- **Baseline checks, which all passed when handed over:**
  - 395 Foundry tests, 26 shared, 97 app, 64 notifier (10 skip without Postgres)
  - typecheck, Biome lint and `forge lint` all clean
  - `pnpm rehearse:mainnet` passes end to end

## 3. Environment

- **Tools on the PATH:** pnpm and Foundry (`$HOME/.foundry/bin`) must both be on the PATH of every shell.
- **Ad-hoc Node scripts:** write them to a file. Inline `node -e` breaks on quotes and backticks.
- **Ponder locally:** it needs stdin kept open: `tail -f /dev/null | npx ponder dev`. Delete `indexer/.ponder/<dir>`
  after any redeploy.
- **Forge deploys** use `--slow`, because public RPCs drop or reorder bursts.

## 4. Verify before and after any change

```bash
cd contracts && forge fmt --check && forge lint && forge test          # expect 395 passed, 2 skipped
pnpm abis && pnpm --filter @poa/shared build                           # after any contract ABI change
pnpm -r typecheck && pnpm lint
pnpm --filter @poa/shared test && pnpm --filter @poa/app test && pnpm --filter @poa/notifier test
pnpm rehearse:mainnet                                                  # the full dress rehearsal (~10 min)
```

## 5. Remaining work, in order

Items marked **(human)** need a person; the agent prepares them and checks them afterwards.

1. **Audit prep (agent).**
   - Freeze `contracts/src`.
   - Write an audit scope file: the contracts in scope, commit hash, known issues from THREAT_MODEL §6 and the
     residual risks.
   - Run Slither or Aderyn and triage what they find.
   - Add invariant or fuzz tests where they point.
   - Fix two small leftovers: `scripts/verify-all.mjs` still lists `src/funds/NonCustodialLedger.sol` (removed in v7),
     and `docs/ROADMAP.md` still mentions Semaphore identities.
2. **The audit (human),** then fix its findings (agent). Rerun §4 after each fix.
3. **Keys (human):**
   - a fresh deployer key with about 0.005 ETH, never in git
   - three Safe owners on hardware wallets
   - a separate guardian wallet
   - a fresh relayer key with a little ETH
4. **Settings:** create `.env.mainnet` from the block under "Deploying → 1. Settings" in `docs/MAINNET.md`. Git ignores it, and it must never be
   read into logs.
5. **Rehearse:** `pnpm rehearse:mainnet` must pass on the audited commit.
6. **Plan:** `pnpm deploy:mainnet` with no flags. It only checks and prints the plan. Show that output to the human.
7. **Deploy (human says yes):** `pnpm deploy:mainnet --yes`.
8. **Post-deploy (agent):**
   - Verify the timelock on Basescan. The handover doesn't verify it:
     ```bash
     forge verify-contract <Timelock> node_modules/@openzeppelin/contracts/governance/TimelockController.sol:TimelockController \
       --chain base --watch --constructor-args $(cast abi-encode "constructor(uint256,address[],address[],address)" \
       <delay in seconds, e.g. 600> "[<Safe>]" "[0x0000000000000000000000000000000000000000]" 0x0000000000000000000000000000000000000000)
     ```
     Run it from `contracts/`, with `ETHERSCAN_API_KEY` set in the environment only.
   - Commit `deployments/base.json` and `contracts/broadcast/*/8453/`.
   - Run `pnpm sync:deployments && pnpm --filter @poa/shared build`.
9. **Hosting:** follow `docs/MAINNET_HOSTING.md`: testnet staging first, then a Railway mainnet project (indexer and
   notifier), then Vercel's production switch. Summary:

   **Mainnet indexer (human clicks, agent checks).** A second Railway service from `indexer/railway.json`, with its own
   Postgres. Variables:
   - `DATABASE_URL=${{Postgres.DATABASE_URL}}`
   - `PONDER_NETWORK=base`
   - `PONDER_RPC_URL=` a dedicated Base mainnet RPC
   - `PORT=42069`
   - `APP_BASE_URL=https://www.verifaid.org`

   Check `/ready` and `/needs`.
10. **Site (human clicks, agent checks).** Vercel production variables:
    - `NEXT_PUBLIC_CHAIN_ID=8453`
    - `NEXT_PUBLIC_INDEXER_URL=` the mainnet indexer
    - `RELAYER_PRIVATE_KEY`
    - `UPLOAD_DIR=/tmp/verifaid-uploads`
    - `PINATA_JWT`
    - `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`
    - `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET`

    `NEXT_PUBLIC_*` values are baked in at build time, so redeploy after changing them. Keep the testnet as a staging
    site, for example `testnet.verifaid.org`, a second Vercel project on the same repo.
11. **First admin actions:** registering NGOs, verifiers and suppliers, and setting the relayer as keeper on
    `DonationForwarderFactory`. For each one:
    - run `pnpm admin base prepare <Contract> "<fn(types)>" args…`
    - hand the human the two files in `admin-proposals/`: schedule now in the Safe app, execute once the delay has passed (ten minutes by default)
    - the agent may run `pnpm admin base execute … --salt 0x…` from a funded key once the delay has passed
12. **Soft launch:** a few vetted NGOs with low targets. Watch the relayer's balance and the indexer's health.

## 6. Gotchas already paid for

- **anvil's well-known keys on Base mainnet** all carry an EIP-7702 delegation to a sweeper contract. Any fork test
  that signs with them needs `libraries/Signatures.sol`, which is already in place.
- **Circle's USDC and EURC can't be given balances with `anvil_dealERC20`**, because each balance is packed with a
  blacklist flag. On a fork, mint instead: impersonate `masterMinter()`, call `configureMinter`, then `mint` (see
  the rehearsal).
- **Chainlink feeds on a fork go stale after `evm_increaseTime`.** The rehearsal swaps in `MockV3Aggregator` code
  carrying each feed's last real answer. Run conversions before any time jump.
- **anvil unlocks only its accounts 0–9.** Impersonate any other before sending from it.
- **Railway:**
  - Set `PORT=42069`, or the domain answers 502.
  - A branch without `indexer/railway.json` makes Railpack guess the build and fail.
  - Every Ponder deployment indexes into a fresh schema (`RAILWAY_DEPLOYMENT_ID`).
- **Vercel:** set `UPLOAD_DIR=/tmp/…`, or uploads fail. Without Pinata, uploaded files don't survive.
- **Pulling `mainnet-prep` deletes the `.env` files** on other clones. Restore them with
  `git show 3f28c6d:.env > .env` and `git show 3f28c6d:app/.env.local > app/.env.local`. The keys in them are
  testnet-only for good.
- **`deploy-mainnet.mjs` refuses** to overwrite an existing `deployments/base.json`, and the rehearsal refuses to run
  where one exists. Don't bypass either.
