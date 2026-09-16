# evidence service

Encrypts delivery evidence, strips image metadata, pins the ciphertext to IPFS and serves it back to the people
the chain says may read it. Runs on **port 4001**; OpenAPI at [`/docs`](http://localhost:4001/docs).

The value that matters is `evidenceHash = keccak256(ciphertext)`. It is what the field agent puts in the
on-chain `DeliveryEvidence` attestation, so the chain anchors exactly the bytes that were uploaded — not a
description of them.

## Endpoints

| Method | Path | Auth | What it does |
|---|---|---|---|
| `POST` | `/auth/nonce` | — | Returns a single-use nonce and the exact SIWE message to sign |
| `POST` | `/auth/verify` | — | Verifies the signature and returns a bearer session token |
| `POST` | `/evidence` | session, field agent | Multipart upload → strip → encrypt → IPFS → `{ cid, evidenceHash }` |
| `GET` | `/evidence/:cid` | session, NGO / uploader / independent verifier | Decrypted bundle |
| `GET` | `/evidence/:cid/meta` | session | Hash, delivery id, non-personal manifest, grant count |
| `GET` | `/health` | — | Liveness, network, IPFS backend |
| `GET` | `/docs` | — | Swagger UI |

### `POST /evidence`

`multipart/form-data` with one `manifest` field and one or more files:

```jsonc
// manifest
{ "deliveryId": "7", "itemsDelivered": 120, "regionCode": "ES-CM", "notes": "optional free text" }
```

Before anything is stored the service checks, **on-chain**:

1. the delivery exists and the caller is its field agent (`DeliveryManager.getDelivery`),
2. the caller is still bound to that NGO (`RoleRegistry.isFieldAgentOf`),
3. the delivery is still `Open`,
4. `regionCode` matches the need's region — the resolver rejects a mismatch anyway, so failing here saves an
   upload that could never be attested.

Then: image metadata is stripped, manifest + files are serialised into one bundle, the bundle is
envelope-encrypted under `ngo:<address>`, and the ciphertext is uploaded. `notes` stay inside the ciphertext and
are never written to the database — free text in the field is the most likely place for a name to appear.

## Metadata stripping

Pure JavaScript, no native dependencies, no re-encoding (`src/metadata.ts`):

- **JPEG** — drops every `APPn` segment except `APP0/JFIF`, and every `COM` segment. `APP1/Exif` (GPS, device
  serial, timestamp, embedded thumbnail) and `APP0/JFXX` (thumbnail) are therefore removed. Tables, the frame
  header and the entropy-coded scan are copied byte for byte.
- **PNG** — drops `tEXt`, `iTXt`, `zTXt`, `eXIf` and `tIME`. Everything else is copied untouched.
- Anything else passes through unchanged and is reported as `format: "unknown"`.

## Access control and key grants

Roles are never taken from the request. The session proves which address signed in; the chain decides the rest:

- **owning NGO** — `evidence.ngoAddress` and `RoleRegistry.isActiveNgo`
- **uploading field agent** — `evidence.uploader` and `RoleRegistry.isFieldAgentOf`
- **verifier** — `RoleRegistry.isIndependent(verifier, ngo)`

A verifier's first read creates a `KeyGrant`: the bundle's data key, re-wrapped for `grant:<verifier>`. Later
reads go through that grant, so every share of a key is a row someone can audit and, later, revoke.

Access is logged as one structured line per read (`audit: true`, actor, cid, role) — never the payload.

## IPFS

`PINATA_JWT` set → Pinata (`cidVersion: 1`). Unset → a local filesystem mock under `.data/ipfs/` that computes a
**real CIDv1** (raw codec, sha2-256) with `multiformats`, so a demo CID is a genuine content address.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `4001` | |
| `HOST` | `0.0.0.0` | |
| `LOG_LEVEL` | `info` | `silent` in tests |
| `DATABASE_URL` | — | Postgres; required |
| `POA_NETWORK` | `base-sepolia` (`anvil` when `CHAIN_ID=31337`) | Picks the entry in `deployments/` |
| `RPC_URL` | the chain's public RPC | |
| `SESSION_SECRET` | random per process | Unset ⇒ sessions die on restart, warned at boot |
| `SESSION_TTL_SECONDS` | `3600` | |
| `SIWE_DOMAIN` | `localhost:<port>` | Must match the domain the wallet signs |
| `CORS_ORIGIN` | `*` | Comma-separated list, or `*` |
| `NGO_KEK_PATH` | `./secrets/ngo-kek.key` | 32-byte hex master key, **created on first run** if missing |
| `PINATA_JWT` | — | Unset ⇒ local IPFS mock |
| `PINATA_GATEWAY` | `https://gateway.pinata.cloud` | |
| `IPFS_LOCAL_DIR` | `.data/ipfs` | |
| `MAX_FILE_BYTES` | `10485760` | Per file |
| `MAX_FILES` | `12` | Per upload |

The master key is shared with the pii-vault (same `NGO_KEK_PATH`, same named volume in Compose). Losing it makes
every stored record permanently unreadable — which is the same property that makes crypto-shredding work.

## Running

```bash
docker compose up -d postgres
pnpm --filter @poa/shared exec prisma db push     # first run only
pnpm --filter @poa/evidence dev                   # or: docker compose up -d --build evidence
```

Suggested root `package.json` scripts:

```jsonc
"services:up":   "docker compose up -d --build",
"services:down": "docker compose down",
"db:push":       "pnpm --filter @poa/shared exec prisma db push"
```

## Tests

```bash
pnpm --filter @poa/evidence test
```

- `test/metadata.test.ts` — hand-built JPEG/PNG files: the Exif marker is gone, the scan data is byte-identical.
- `test/bundle.test.ts` — bundle → seal → hash round trip, key contexts, the CIDv1 vector for `"hello world"`.
- `test/acceptance.test.ts` — the Phase 4 criterion: upload, attest `DeliveryEvidence` on the live chain as the
  field agent, and assert the attestation's `evidenceHash` equals the one the upload returned.

The chain and database suites skip with a message when Postgres or anvil is unreachable, so `pnpm test` never
fails just because the infrastructure is not up.
