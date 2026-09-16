# pii-vault service

The only place in the system that holds a name. Beneficiary records and needs assessments are envelope-encrypted
under a per-NGO key; the chain sees an unlinkable Semaphore commitment and a ciphertext hash, and nothing else.
Runs on **port 4002**; OpenAPI at [`/docs`](http://localhost:4002/docs).

## Endpoints

| Method | Path | Auth | What it does |
|---|---|---|---|
| `POST` | `/auth/nonce` | — | Single-use nonce + the SIWE message to sign |
| `POST` | `/auth/verify` | — | Verifies the signature, returns a bearer session token |
| `POST` | `/beneficiaries` | session, owning NGO | Encrypts a profile, stores it with the identity commitment |
| `GET` | `/beneficiaries?programId=` | session, owning NGO | Ids, commitments, timestamps, shredded flag — **no personal data** |
| `GET` | `/beneficiaries/:id` | session, owning NGO | Decrypted profile |
| `DELETE` | `/beneficiaries/:id` | session, owning NGO | Crypto-shredding; returns the commitment |
| `POST` | `/dossiers` | session, NGO | Encrypts a needs assessment, returns `{ hash }` |
| `GET` | `/dossiers/:hash` | session, owning NGO or registered verifier | Decrypted assessment + recomputed ciphertext hash |
| `GET` | `/health` | — | Liveness, network |
| `GET` | `/docs` | — | Swagger UI |

## Right to erasure

`DELETE /beneficiaries/:id` performs **crypto-shredding**: `wrappedDek` is set to `NULL` and `shreddedAt` to now.
The row and its ciphertext stay — nothing that an on-chain hash refers to is deleted — but no key derived from
the master KEK can ever open the box again. A later `GET` returns **410** with
`"record was crypto-shredded"`.

The response carries the `commitment`, which is what the frontend passes to
`BeneficiaryGroups.removeMember(programId, commitment, merkleProofSiblings)` so the identity can no longer
confirm a delivery. Erasure works even if the NGO has been deactivated: the right to erasure is not the NGO's to
lose.

## Authorization

Every decision is a chain read, never a column:

- **enrolling / listing** — `RoleRegistry.isActiveNgo(caller)` **and** `BeneficiaryGroups.programNgo(programId) == caller`
- **reading a profile** — the record's NGO **and** still an active NGO
- **erasing** — the record's NGO
- **reading a dossier** — the owning NGO, or any address with `VERIFIER_ROLE`

`GET /dossiers/:hash` also returns `ciphertextHash`, recomputed from the stored bytes on every read, plus
`hashMatches`. A verifier compares it with the need's on-chain `dossierHash` before trusting what they just read
— the `NeedVerified` resolver refuses an attestation whose hash does not match the need.

Access is logged as one structured line per operation (`audit: true`, actor, record id, role). Record contents
are never logged.

## Keys

Envelope encryption from `@poa/shared`: a fresh AES-256-GCM data key per record, wrapped with
`deriveKey(master, "ngo:<address>")`. One master key file protects every record while no NGO's key can open
another's — `test/vault.test.ts` asserts exactly that.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `4002` | |
| `HOST` | `0.0.0.0` | |
| `LOG_LEVEL` | `info` | |
| `DATABASE_URL` | — | Postgres; required |
| `POA_NETWORK` | `base-sepolia` (`anvil` when `CHAIN_ID=31337`) | Picks the entry in `deployments/` |
| `RPC_URL` | the chain's public RPC | |
| `SESSION_SECRET` | random per process | Unset ⇒ sessions die on restart, warned at boot |
| `SESSION_TTL_SECONDS` | `3600` | |
| `SIWE_DOMAIN` | `localhost:<port>` | Must match the domain the wallet signs |
| `CORS_ORIGIN` | `*` | Comma-separated list, or `*` |
| `NGO_KEK_PATH` | `./secrets/ngo-kek.key` | 32-byte hex master key, **created on first run** if missing |

Generate the key yourself instead of letting the service do it:

```bash
mkdir -p secrets && openssl rand -hex 32 > secrets/ngo-kek.key
```

## Running

```bash
docker compose up -d postgres
pnpm --filter @poa/shared exec prisma db push     # first run only
pnpm --filter @poa/pii-vault dev                  # or: docker compose up -d --build pii-vault
```

Suggested root `package.json` scripts:

```jsonc
"services:up":   "docker compose up -d --build",
"services:down": "docker compose down",
"db:push":       "pnpm --filter @poa/shared exec prisma db push"
```

## Tests

```bash
pnpm --filter @poa/pii-vault test
```

Covers create → read → delete → read fails (410, and the stored ciphertext is asserted to be unreadable),
that the list endpoint never returns personal data, that a **second registered NGO** can neither read nor enrol
into the first one's program, and the dossier hash/verifier-access path. Suites skip with a message when
Postgres or anvil is unreachable.
