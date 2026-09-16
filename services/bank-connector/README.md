# bank-connector service

A mock **payment provider**. It records fiat funding for a need — arriving as a SEPA webhook, through a card/bank
checkout sandbox or in a CSV file — as a `FundingRecorded` EAS attestation, and reports tranche payouts of
off-chain needs as `Settlement` attestations, so bank-channel money is traceable on the same timeline as a
crypto donation. Runs on **port 4003**; OpenAPI at [`/docs`](http://localhost:4003/docs).

Nothing about the payer reaches the chain. The reference the bank uses becomes
`paymentRefHash = keccak256(abi.encode(salt, endToEndId))`, with a salt that never leaves this service — a donor
who holds their reference can prove the donation to anyone the provider shares the salt with, and nobody else can
go the other way. The same hash is the donor's **tracking reference**.

The service signs everything with one hot wallet, which must hold `BANK_PARTNER_ROLE`. All amounts on-chain are
6-decimal stablecoin base units (1 EUR cent = 10⁴ base units).

## Endpoints

| Method | Path | Auth | What it does |
|---|---|---|---|
| `POST` | `/webhooks/sepa` | HMAC header | Records one settled transfer (deposit + attestation, or attestation only) |
| `POST` | `/checkout/sessions` | — (sandbox, rate-limited) | Mock card / bank checkout through the same pipeline |
| `POST` | `/imports/funding` | HMAC header | CSV import of settled transfers, one pipeline run per row |
| `POST` | `/settlements` | HMAC header | Reports the payout of a releasable tranche of an off-chain need |
| `GET` | `/donations/:endToEndId/proof` | — | Gross/fee/net, currency, custody, hashes, tx hashes, attestation UID, links |
| `GET` | `/donations/:endToEndId/reference-hash` | — | Turns a reference the caller already holds into its on-chain hash |
| `GET` | `/health` | — | Liveness, provider address, role, webhook auth and checkout flags |
| `GET` | `/docs` | — | Swagger UI |

Errors always look like `{ "error": "CODE", "message": "…" }`, sometimes with extra machine-readable fields
(`remaining`, `retryAfterSeconds`). Validation errors name the failing fields but never echo their values.

## The funding pipeline

Shared by the webhook, the checkout and the CSV import (`src/funding.ts`). For each payment:

1. `paymentRefHash` / `donorRefHash` from the salt; gross = what the donor paid.
2. The need must exist (404), be verified and open — `fundingTermsOf(needId).open` (409 `NEED_NOT_FUNDING`).
3. **Fee cap.** The resolver enforces, cumulatively for the need,
   `(fundingFees + settlementFees) × 10000 ≤ (ledger.totalDonated + fundingFees) × thirdPartyCostBps`.
   The provider never produces a fee that breaks it: the requested fee is lowered to the largest one that passes
   and the provider absorbs the rest (`src/fees.ts`). `net = gross − fee` must fit in what the need still has to
   raise (409 `EXCEEDS_REMAINING`, with `remaining` in base units).
4. By custody mode (`custodyModeOf(needId)`):
   - **OnChain** (AidVault): mint `MockEURC` to the hot wallet if it is short — **demo only**; with a real
     stablecoin a shortfall is an error — approve the vault, `AidVault.donateOnBehalf(net, donorRefHash,
     paymentRefHash)`, then attest. The resolver checks `fiatDepositMatches` against the deposit.
   - **OffChain** (NonCustodialLedger): no token moves. Only the attestation, and only if
     `custodianOf(needId)` is this provider (403 `NOT_CUSTODIAN`). The attestation is what counts the money
     toward the target.
5. `FundingRecorded(needId, gross, fee, net, currency, paymentRefHash, donorRefHash)`, recipient = the need's
   ledger (`vaultOf(needId)`), non-revocable. `currency` is the ISO 4217 code the donor paid in, packed into
   bytes32 like a region code.

### Idempotency and resume

Two independent guards, because a bank may deliver the same payment twice and a process may die mid-flow:

- the `FiatTransfer.status` column records how far the last run got
  (`RECEIVED → FUNDED → DONATED → ATTESTED`, or `FAILED` with the error), and
- every step re-checks the chain, which is the only authority. Replay guards are scoped per provider:
  `AidVaultFactory.isPaymentRefConsumed(provider, paymentRefHash)` for the deposit and
  `ProofOfAidResolver.fundingAttestationOf(provider, paymentRefHash)` for the attestation.

A replay of a completed payment returns the stored record with `idempotent: true` and sends no transaction. A run
interrupted between the deposit and the attestation resumes at the attestation (with the fee lowered if the cap
tightened meanwhile — the net amount is fixed by the deposit). An attestation found on-chain but missing from the
database is adopted from its decoded data. Reusing an `endToEndId` for a different amount, currency, donor or need
is rejected with `REFERENCE_CONFLICT` rather than absorbed as a duplicate. Writes from the hot wallet are
serialised in-process, so concurrent requests never race for a nonce.

## `POST /webhooks/sepa`

```http
POST /webhooks/sepa
content-type: application/json
x-poa-signature: sha256=<hex hmac-sha256 of the raw body under BANK_WEBHOOK_SECRET>

{ "endToEndId": "SEPA-E2E-0001", "amountEurCents": 1234, "feeEurCents": 20, "currency": "EUR",
  "donorReference": "DONOR-42", "needId": "3" }
```

`amountEurCents` is what the donor paid (gross). `feeEurCents` (default `0`) and `currency` (default `"EUR"`) are
optional. The signature is verified in a `preValidation` hook, over the **raw** bytes — an unsigned request never
reaches the schema, let alone the chain. If `BANK_WEBHOOK_SECRET` is unset the service logs a loud warning and
accepts unsigned requests on all three HMAC endpoints; that is a development affordance and `/health` reports
`webhookAuthenticated: false`. The response carries `grossBaseUnits`, `feeBaseUnits`, `netBaseUnits` (and
`amountBaseUnits`, the net amount under its v1 name), `currency`, `custodyMode`, `source`, both hashes, the
transaction hashes and the attestation UID. Persisted with `source = "SEPA"`.

## `POST /checkout/sessions` (gap plan A7)

```http
POST /checkout/sessions
content-type: application/json
Idempotency-Key: 6f0c…            (optional)

{ "needId": "3", "amount": "25.00", "method": "card", "donorReference": "optional" }
```

A sandbox standing in for a PSP. **It never accepts card data**: unknown fields are rejected, and card-like fields
(`cardNumber`, `cvv`, `expiry`…) get an explicit `400 CARD_DATA_REJECTED`. `amount` is decimal EUR, > 0, at most
two decimals. Mock pricing: **card = 1.4% + €0.25** (rounded half-up to the cent), **bank = €0**, then capped by
the disclosure as above. The "payment" succeeds at once and runs the pipeline with `source = "CARD" | "BANK"` and
an `endToEndId` of `CHK-<uuid>`.

`201` → `{ checkoutId, trackingRef, needId, method, currency: "EUR", gross, fee, net, status, custodyMode }`,
amounts as base-unit decimal strings; `trackingRef` is the `paymentRefHash`.

- **Idempotency:** with an `Idempotency-Key`, the checkout id is derived from the key (HMAC under the reference
  salt), so a retry lands on the same payment: same `201` body, `idempotent-replayed: true`, no transaction.
  Reusing a key for a different checkout (amount, method, need or donor reference) is `409 IDEMPOTENCY_KEY_REUSED`.
- **Errors:** `400` validation, `404` unknown need, `409 NEED_NOT_FUNDING`, `409 EXCEEDS_REMAINING` (with
  `remaining`), `429 RATE_LIMITED` (with `retry-after`).
- **Rate limit:** per client IP, `CHECKOUT_RATE_LIMIT_PER_MINUTE` (default 30), with `x-ratelimit-limit` and
  `x-ratelimit-remaining` on every response. In-process only; put a real limiter in front in production.
- **Disabled on Base mainnet by default** (`CHECKOUT_MOCK_ENABLED`): it records funding nobody paid.

## `POST /imports/funding` (gap plan C1)

```http
POST /imports/funding
content-type: text/csv
x-poa-signature: sha256=<hmac of the raw body>

end_to_end_id,need_id,amount_eur,fee_eur,currency,donor_reference
SEPA-0001,3,25.00,0.20,EUR,DONOR-42
SEPA-0002,3,10,,,DONOR-43
```

Header row required, columns in any order, no unknown columns. `fee_eur` and `currency` may be empty (0, EUR).
Structural problems (bad header, broken quoting, no rows, more than `IMPORT_MAX_ROWS`) reject the whole file;
otherwise every row is validated first, then valid rows are processed **in file order** through the pipeline with
`source = "CSV"`:

```json
{ "rows": [ { "line": 2, "endToEndId": "SEPA-0001", "status": "ATTESTED", "trackingRef": "0x…" },
            { "line": 3, "endToEndId": "SEPA-0002", "status": "INVALID", "error": "amount_eur must be …" } ],
  "summary": { "attested": 1, "duplicate": 0, "failed": 0, "invalid": 1 } }
```

`DUPLICATE` = already recorded (so a partly failed file can simply be uploaded again), `FAILED` = rejected by the
pipeline or the chain (with the error code), `INVALID` = the row itself is malformed. Row errors never echo cell
values. Limits: `IMPORT_MAX_BYTES` (1 MiB → `413`) and `IMPORT_MAX_ROWS` (5000 → `413 TOO_MANY_ROWS`).

## `POST /settlements` (Model A payouts)

```http
POST /settlements
content-type: application/json
x-poa-signature: sha256=<hmac of the raw body>

{ "needId": "3", "trancheIndex": 0, "feeEurCents": 50, "supplierReference": "INV-2026-001", "fxReference": "FX-42" }
```

Only for needs in **off-chain custody** whose custodian is this provider (`409 NOT_OFF_CHAIN_CUSTODY` for on-chain
needs, whose vault releases tranches and whose NGO reports settlements; `403 NOT_CUSTODIAN`), and only for a
**Releasable** tranche (`409 TRANCHE_NOT_RELEASABLE`). `gross` is the tranche amount from
`NonCustodialLedger.getTranches()`; the fee is capped like a funding fee; `supplierRefHash =
saltedRefHash(salt, supplierReference)`; `fxRef = keccak256(fxReference)` or zero. The
`Settlement(needId, trancheIndex, gross, fee, net, supplierRefHash, fxRef)` attestation releases the tranche on-chain
(tranche 0 moves the need to `InDelivery`, the last one to `Completed`).

`200` → `{ id, needId, trancheIndex, gross, fee, net, attestationUID, txHash, status, idempotent }`. Persisted in
`ProviderSettlement`, idempotent on `(needId, trancheIndex)` and re-checked against
`ProofOfAidResolver.settlementOf(needId, trancheIndex)`; a different supplier or FX reference for a tranche already
paid is `409 SETTLEMENT_CONFLICT`.

## `GET /donations/:endToEndId/proof`

Returns the need id, its ledger, `grossBaseUnits` / `feeBaseUnits` / `netBaseUnits`, the currency, the custody
mode, the source, both reference hashes, the deposit (null off-chain) and attestation transaction hashes, the
`FundingRecorded` attestation UID and explorer links (`null` on a local chain that has no explorer). Works for
SEPA, checkout (`CHK-…`) and CSV payments. It **never** returns the salt or either raw reference — including the
one in the path, which the caller already has.

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
| `BANK_PARTNER_PRIVATE_KEY` | demo mnemonic index 6 | Must hold `BANK_PARTNER_ROLE` (and be named custodian of off-chain needs); the default is warned about at boot |
| `BANK_REF_SALT` | a public development constant | A `0x`-prefixed 32-byte hex value is used as-is; anything else is keccak-hashed into one |
| `BANK_WEBHOOK_SECRET` | — | HMAC key for the webhook, CSV import and settlements. Unset ⇒ unsigned requests accepted, warned loudly |
| `DEMO_MNEMONIC` | anvil's default | Only used to derive the development provider key |
| `CHECKOUT_MOCK_ENABLED` | `true`, except `false` on `base` | Registers `/checkout/sessions` |
| `CHECKOUT_CARD_FEE_BPS` | `140` | Mock PSP card fee, basis points |
| `CHECKOUT_CARD_FEE_FIXED_CENTS` | `25` | Mock PSP card fee, fixed part |
| `CHECKOUT_RATE_LIMIT_PER_MINUTE` | `30` | Per client IP; `0` disables |
| `IMPORT_MAX_BYTES` | `1048576` | CSV body limit |
| `IMPORT_MAX_ROWS` | `5000` | CSV row limit |

Changing `BANK_REF_SALT` changes every hash the service produces (and every checkout id derived from an
Idempotency-Key), so a donation attested under the old salt can no longer be matched. Set it once, per provider,
and keep it.

## Running

```bash
docker compose up -d postgres
pnpm db:push                                      # first run, and after schema changes
pnpm --filter @poa/bank-connector dev             # or: docker compose up -d --build bank-connector
```

## Tests

```bash
pnpm --filter @poa/bank-connector test
```

Files run one at a time (`vitest.config.ts`): they share one chain and the provider's hot wallet. Against a live
anvil chain and Postgres, each suite creates its own needs and reads their ids from receipts:

- **webhook** — on-chain need: `DonatedOnBehalf` + `FundingRecorded` decoding to the same amounts and hashes, and
  an idempotent replay; off-chain need: no token moves, `totalDonated` grows, the ledger logs `FundingRecorded`,
  and a provider that is not the custodian gets `403`; resume after a deposit whose attestation never landed; bad,
  missing or body-mismatched HMAC rejected with no database row; proof and reference hash.
- **checkout** — card fee capped by a 1% disclosure (€0.60 PSP fee → €0.25), cumulative cap on a second payment,
  Idempotency-Key replay and reuse, `EXCEEDS_REMAINING` / `NEED_NOT_FUNDING`, validation, card data, rate limit.
- **imports** — a mixed file (attested, duplicate, invalid, failed) and its re-upload, HMAC, structural errors.
- **settlements** — releasing tranche 0 of an off-chain need with a capped fee, replay, non-releasable tranche,
  on-chain need refused, non-custodian refused, bad HMAC.
- **fees** — pure: amount parsing, card pricing, and a brute-force check that every cap is exactly the largest fee
  the resolver's inequality accepts; CSV parsing and validation.

Suites that need Postgres or anvil skip with a message when either is unreachable.
