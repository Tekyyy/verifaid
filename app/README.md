# `@poa/app` — Proof of Aid dashboard

Next.js 14 (App Router), wagmi v2 + viem, Tailwind, `next-intl` (English and Spanish).
The chain is locked to whatever `NEXT_PUBLIC_CHAIN_ID` points at; addresses and schema UIDs come from
`@poa/shared`, which bundles `deployments/<network>.json`.

## Routes

All pages live under a locale prefix (`/en/...`, `/es/...`). The middleware redirects `/` to the browser's
preferred locale, and the language switcher in the header keeps the current path and query.

| Route | Rendering | Where the data comes from |
|---|---|---|
| `/` | server, dynamic | `GET /impact/summary` for the live totals; the rest is static copy |
| `/needs` | server, dynamic | `GET /needs?status=&category=&region=&country=&custody=&open=&sort=`; the filters are URL query parameters, and the country list comes from an unfiltered `GET /needs` |
| `/needs/[id]` | server, dynamic | `GET /needs/:id` and `GET /needs/:id/timeline`. Terms panel (custody model, deadlines, minimum funding, cost cap), settlements, the payment plan (who the vault pays, each payee's share of every tranche, what has reached them and any supplier replacement waiting on verifiers), donations by kind, "Apply deadline" (`NeedsRegistry.expire`) once a deadline has passed, refund guidance (`AidVault.claimRefund`) for cancelled or expired on-chain needs, PDF report and RSS links. Wallet donations (approve, then `AidVault.donate`) only for on-chain custody; the card / bank sandbox checkout for both |
| `/track`, `/track/[ref]` | server, dynamic | `GET /donations/:ref` (a receipt id or a payment reference hash). Five-stage stepper, outcome banner, the donation's share, tranches, settlements, deliveries, impact report; alerts form, RSS, copy link and the embed snippet. No login, `noindex` |
| `/embed/track/[ref]` | server, dynamic | The same data as a chrome-less widget (own layout, no wallet provider), light/dark from `prefers-color-scheme`, refreshed every 60 s. The only route allowed in a third-party iframe (`Content-Security-Policy: frame-ancestors *`, set in `next.config.mjs`) |
| `/alerts/unsubscribe` | client | Removes an alert subscription; the id and token arrive in the URL fragment and are wiped from the address bar |
| `/donor` | client | `GET /donors/:address/trace` for the connected wallet, through the same-origin proxy |
| `/ngo` | client | writes only: `BeneficiaryGroups.createProgram` / `addMembers`, `NeedsRegistry.createNeed` (with the v2 terms: custody model and custodian from `GET /providers`, deadlines, minimum funding, cost cap and the hashed disclosure and expected outcome, summarized in plain words before signing), the payment plan (payees from `GET /suppliers`, a share of every tranche each, the NGO's own share capped at 25%, validated as it is typed against `NeedsRegistry._validatePayees`), `closeFunding` (explains the minimum threshold) / `releaseTranche`, and `Settlement` and `ImpactReport` EAS attestations. The ledger address is read on chain with `NeedsRegistry.vaultOf` |
| `/verifier` | server shell, client forms | `GET /needs?status=Pending` and `GET /deliveries`; the dossier hash is read on chain with `NeedsRegistry.dossierHashOf`. Attests `NeedVerified` and `DeliveryVerified` (whose `refUID` is forced to the delivery's evidence attestation) and calls `DeliveryManager.challenge` |
| `/field` | client | `POST /evidence` (multipart) to the evidence service, then a `DeliveryEvidence` attestation with the hash and CID it returned; `DeliveryManager.openDelivery` |
| `/confirm/[deliveryId]` | server shell, client island | the delivery and its program are read **on chain** (so the page works while the indexer catches up); the group members come from `GET /programs/:id/members` |
| `/suppliers`, `/suppliers/[address]` | server, dynamic | `GET /suppliers` and `GET /suppliers/:address`: the registered suppliers a vault may pay directly, what vaults have paid each one, and the needs whose plan names it |
| `/impact` | server, dynamic | `GET /impact/summary` plus `GET /needs?status=Completed` and up to 12 `GET /needs/:id` lookups for the published impact reports |

Route handlers back these pages:

- `GET /api/indexer/*` — a read-only, allow-listed proxy to the indexer (including the RSS feeds and
  `/providers`), so client components do not depend on it serving CORS headers.
- `POST /api/relay/confirm` — the beneficiary relayer (below).
- `POST /api/checkout` — validates a sandbox card / bank donation and forwards it to the bank connector's
  `POST /checkout/sessions`; the donor is redirected to `/track/<trackingRef>`. No card data exists anywhere.
- `POST /api/alerts`, `DELETE /api/alerts/:id` — validate and forward alert subscriptions to the notifier.
- `GET /api/reports/:needId` — the need's donor / funder / audit report as an A4 PDF (pdf-lib, standard fonts),
  rendered from the indexer on every request; 404 for an unknown need, 502 when the indexer is down.

## Sponsored gas

When `NEXT_PUBLIC_PAYMASTER_URL` is set and the connected wallet reports the ERC-7677 `paymasterService`
capability for the configured chain (Coinbase Smart Wallet does), `useTx` sends each write as an EIP-5792
`wallet_sendCalls` batch with that paymaster and waits for the batch status; the transaction status then shows a
"Gas sponsored" badge. Any other wallet falls back to a normal transaction. Role checks are unaffected: the smart
account is still `msg.sender`.

## Voting on evidence

The review panel on a need page is where donors (and, under the rules that give them one, verifiers) approve or
reject the NGO's account of a tranche. Who has a say, and what it weighs, is asked of the contract
(`DeliveryManager.voiceOf`), never decided here.

- **For free by default.** The voter signs an EIP-712 `Vote` (the type is `voteTypedData` in `@poa/shared`) and
  `POST /api/relay/vote` puts it on chain with `RELAYER_PRIVATE_KEY`. The route checks the signature against the
  voter's address — so a passkey Smart Wallet's ERC-1271 signature counts too — and simulates the call before
  spending gas; a vote the contract would refuse comes back as its reason. Unticking "vote for free" sends an
  ordinary transaction instead.
- **Rejecting asks twice.** It can end the need, so the panel says what a rejection does under the need's rule and
  how many second chances are left before it takes the vote.

## Evidence files

`POST /api/uploads` stores each file under its SHA-256 (photo metadata stripped) and, with `PINATA_JWT` set, pins it
to IPFS and returns its CID. `GET /api/files/<sha256>?cid=…` serves the local copy, or fetches the file back from IPFS
when there is none and serves it only if it hashes to the SHA-256 in the link.

## Environment

See `.env.example`. Everything has a working default except the relayer key.

| Variable | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_CHAIN_ID` | `84532` | The only chain the app will talk to. `31337` for anvil |
| `NEXT_PUBLIC_RPC_URL` | the chain's public RPC | Override for a private RPC |
| `NEXT_PUBLIC_INDEXER_URL` | `http://localhost:42069` | Ponder API base, used server side and by the proxy |
| `NEXT_PUBLIC_USE_FIXTURES` | unset | `1` renders `src/lib/fixtures.ts` instead of calling the indexer |
| `PINATA_JWT` | unset | Pins every evidence upload to IPFS; without it files stay on this server |
| `NEXT_PUBLIC_IPFS_GATEWAY` | `https://ipfs.io/ipfs/` | Where pinned evidence is linked to (and read back from, as `IPFS_GATEWAY` server side) |
| `NEXT_PUBLIC_PII_VAULT_URL` | `http://localhost:4002` | Dossier storage and decryption links |
| `BANK_CONNECTOR_URL` | `http://localhost:4003` | Server only (the `NEXT_PUBLIC_` name is also read). Sandbox checkout |
| `NOTIFIER_URL` | `http://localhost:4004` | Server only (the `NEXT_PUBLIC_` name is also read). Alert subscriptions |
| `NEXT_PUBLIC_PAYMASTER_URL` | unset | ERC-7677 paymaster for gas-sponsored writes (see above) |
| `RELAYER_PRIVATE_KEY` | — | **Server only.** Pays for beneficiary confirmations |

If no deployment is bundled for the configured chain (`deployments/*.json` is gitignored, so a fresh clone has
none), every page still renders and the write panels show a "no addresses for this network" notice instead of
crashing. The same is true when the indexer is down: pages show an explicit "indexer unavailable" banner
rather than a zero.

## Running against anvil

From the repository root, with the chain deployed and seeded:

```bash
pnpm chain          # anvil on 127.0.0.1:8545
pnpm deploy:local   # writes deployments/anvil.json
pnpm --filter @poa/indexer dev
```

Then in `app/.env.local`:

```bash
NEXT_PUBLIC_CHAIN_ID=31337
NEXT_PUBLIC_INDEXER_URL=http://localhost:42069
RELAYER_PRIVATE_KEY=0x…      # any funded anvil account
```

```bash
pnpm --filter @poa/app dev
```

Anvil has no block explorer, so transaction hashes and attestation UIDs render as plain monospace text there;
on Base Sepolia the same components link to Basescan and to `base-sepolia.easscan.org`.

To look at the UI without the indexer running, set `NEXT_PUBLIC_USE_FIXTURES=1`. The fixtures are sample data
shaped exactly like the API contract in `services/shared/src/api.ts`; they are never used as a silent fallback.

## Checks

```bash
pnpm --filter @poa/app typecheck
pnpm --filter @poa/app build
npx @biomejs/biome check --write app   # from the repository root
```

## Notes and assumptions

- The `category` and `region` query parameters are sent as the human-readable labels (`FOOD`, `ES-CM`); the
  indexer accepts either a label or the raw `bytes32`, and `status` is the string form of the enum.
- OnchainKit is not used: it requires React 19, which Next 14 cannot run (`docs/DECISIONS.md` §2). Coinbase
  Smart Wallet still comes in through wagmi's `coinbaseWallet({ preference: 'smartWalletOnly' })` connector,
  with an injected wallet as the fallback.
- `next.config.mjs` stubs `@base-org/account` (the unused Base Account connector inside the `wagmi/connectors`
  barrel, whose `@x402/*` dependencies are not installed) and maps `node:` built-ins to the browser fallbacks
  so `@poa/shared` and snarkjs can be bundled for the client.
