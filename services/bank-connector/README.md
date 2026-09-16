# bank-connector service

A mock SEPA integration. It turns a settled fiat transfer into a stablecoin deposit on a need's vault and then
attests it, so a bank-channel donation is traceable on the same timeline as a crypto one. Runs on **port 4003**;
OpenAPI at [`/docs`](http://localhost:4003/docs).

Nothing about the payer reaches the chain. The reference the bank uses becomes
`paymentRefHash = keccak256(abi.encode(salt, endToEndId))`, with a salt that never leaves this service — a donor
who holds their reference can prove the donation to anyone the partner shares the salt with, and nobody else can
go the other way.

## Endpoints

| Method | Path | Auth | What it does |
|---|---|---|---|
| `POST` | `/webhooks/sepa` | HMAC header | Deposits and attests one settled transfer |
| `GET` | `/donations/:endToEndId/proof` | — | Hashes, amount, vault, tx hashes, attestation UID, explorer links |
| `GET` | `/donations/:endToEndId/reference-hash` | — | Turns a reference the caller already holds into its on-chain hash |
| `GET` | `/health` | — | Liveness, partner address, whether it holds `BANK_PARTNER_ROLE` |
| `GET` | `/docs` | — | Swagger UI |

### `POST /webhooks/sepa`

```http
POST /webhooks/sepa
content-type: application/json
x-poa-signature: sha256=<hex hmac-sha256 of the raw body under BANK_WEBHOOK_SECRET>

{ "endToEndId": "SEPA-E2E-0001", "amountEurCents": 1234, "donorReference": "DONOR-42", "needId": "3" }
```

The signature is verified in a `preValidation` hook, over the **raw** bytes — an unsigned request never reaches
the schema, let alone the chain. If `BANK_WEBHOOK_SECRET` is unset the service logs a loud warning and accepts
unsigned webhooks; that is a development affordance and `/health` reports `webhookAuthenticated: false`.

Then, in order:

1. `paymentRefHash` and `donorRefHash` from the salt,
2. cents → 6-decimal base units (×10⁴),
3. mint `MockEURC` to the partner hot wallet if it is short and the token is mintable — **demo only**; with a
   real stablecoin the partner already holds the converted funds and a shortfall is an error,
4. approve the vault,
5. `AidVault.donateOnBehalf(amount, donorRefHash, paymentRefHash)`,
6. `FiatDonation` EAS attestation — recipient is the **vault**, never a person; non-revocable.

### Idempotency and resume

Two independent guards, because a bank may deliver the same webhook twice and a process may die mid-flow:

- the `FiatTransfer.status` column records how far the last run got
  (`RECEIVED → FUNDED → DONATED → ATTESTED`, or `FAILED` with the error), and
- every step re-checks the chain, which is the only authority: `AidVault.paymentRefUsed(paymentRefHash)` for the
  deposit and `FiatDonationResolver.attestationOf(paymentRefHash)` for the attestation.

A replay of a completed payment returns the stored record with `idempotent: true` and sends no transaction. A run
interrupted between the deposit and the attestation resumes at the attestation. Reusing an `endToEndId` for a
different amount or need is rejected with `REFERENCE_CONFLICT` rather than absorbed as a duplicate.

The vault also enforces this on-chain (`paymentRefUsed`, plus `AidVaultFactory.consumePaymentRef` so one
transfer cannot be replayed against a second need), so a bug here cannot produce a double deposit.

### `GET /donations/:endToEndId/proof`

Returns the need id, vault, amount, both reference hashes, the deposit and attestation transaction hashes, the
attestation UID and explorer links (`null` on a local chain that has no explorer). It **never** returns the salt
or either raw reference — including the one in the path, which the caller already has.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `4003` | |
| `HOST` | `0.0.0.0` | |
| `LOG_LEVEL` | `info` | |
| `DATABASE_URL` | — | Postgres; required |
| `POA_NETWORK` | `base-sepolia` (`anvil` when `CHAIN_ID=31337`) | Picks the entry in `deployments/` |
| `RPC_URL` | the chain's public RPC | |
| `CORS_ORIGIN` | `*` | |
| `BANK_PARTNER_PRIVATE_KEY` | demo mnemonic index 6 | Must hold `BANK_PARTNER_ROLE`; the default is warned about at boot |
| `BANK_REF_SALT` | a public development constant | A `0x`-prefixed 32-byte hex value is used as-is; anything else is keccak-hashed into one |
| `BANK_WEBHOOK_SECRET` | — | Unset ⇒ unsigned webhooks accepted, warned loudly |
| `DEMO_MNEMONIC` | anvil's default | Only used to derive the development partner key |

Changing `BANK_REF_SALT` changes every hash the service produces, so a donation attested under the old salt can
no longer be matched. Set it once, per partner, and keep it.

## Running

```bash
docker compose up -d postgres
pnpm --filter @poa/shared exec prisma db push     # first run only
pnpm --filter @poa/bank-connector dev             # or: docker compose up -d --build bank-connector
```

Suggested root `package.json` scripts:

```jsonc
"services:up":   "docker compose up -d --build",
"services:down": "docker compose down",
"db:push":       "pnpm --filter @poa/shared exec prisma db push"
```

## Tests

```bash
pnpm --filter @poa/bank-connector test
```

Against a live anvil chain: a webhook produces a `DonatedOnBehalf` event and a `FiatDonation` attestation that
decodes to the same amount and reference hashes; the same `endToEndId` twice leaves `totalDonated` unchanged; a
bad, missing or body-mismatched HMAC is rejected with no database row. Suites skip with a message when Postgres
or anvil is unreachable.
