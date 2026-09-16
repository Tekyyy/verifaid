# notifier service

Donation alerts keyed by a public tracking reference (gap plan A6) and HMAC-signed outbound webhooks for
integrators (gap plan C1). Runs on **port 4004**; OpenAPI at [`/docs`](http://localhost:4004/docs).

One process, two halves:

- an **HTTP API** to subscribe and unsubscribe (no accounts) and, for operators, to register integrator webhooks;
- a **worker** that tails the indexer's `/timeline`, turns events into queued deliveries, and sends them with
  retries.

## Endpoints

| Method | Path | Auth | What it does |
|---|---|---|---|
| `POST` | `/subscriptions` | — | Subscribe an email or a webhook URL to a donation (tracking ref) or a whole need |
| `DELETE` | `/subscriptions/:id` | `Bearer <unsubscribeToken>` | Unsubscribe; destroys the stored address (204, idempotent) |
| `GET` | `/unsubscribe?id=&token=` | token in the link | Same, from an email link; answers a small HTML page |
| `POST` | `/webhooks` | `Bearer $NOTIFIER_ADMIN_TOKEN` | Register an integrator webhook; returns its signing `secret` once |
| `GET` | `/webhooks` | admin | `{ webhooks: [...] }` with pending / sent / failed counts |
| `DELETE` | `/webhooks/:id` | admin | Delete an endpoint, its sealed secret and its delivery history |
| `GET` | `/outbox?limit=50` | admin | `{ driver, deliveries: [...] }`: recent alert emails as rendered, for demos without an email provider |
| `GET` | `/health` | — | Wiring: indexer URL, worker on/off, email driver, admin API on/off |
| `GET` | `/docs` | — | Swagger UI |

Admin routes answer **503** when `NOTIFIER_ADMIN_TOKEN` is unset (off, not open) and **401** on a wrong token;
the check runs before the body is parsed. Errors are `{ error, message, fields? }`; validation errors name the
failing fields and never echo a value.

### `POST /subscriptions`

```http
POST /subscriptions
content-type: application/json

{ "trackingRef": "12", "channel": "email", "email": "donor@example.org" }
```

Exactly one of `trackingRef` (a receipt id such as `"12"`, or the `0x…` 32-byte payment reference a bank or card
donor received) and `needId`. `channel` is `email` (with `email`) or `webhook` (with `webhookUrl`).

```json
201 { "id": "8c0e…", "unsubscribeToken": "q3Jx…", "needId": "7", "trackingRef": "12", "channel": "email" }
```

- The reference is resolved through the indexer: unknown → **404** (`UNKNOWN_TRACKING_REF` / `UNKNOWN_NEED`),
  indexer down → **502** (`INDEXER_UNAVAILABLE`).
- Stages already reached are recorded as notified, so a new subscriber is not sent the history. An email
  subscription gets one "alerts are on" message naming the current stage.
- `unsubscribeToken` (32 random bytes, base64url) is returned **once**; only its sha256 is stored.
- Webhook subscriptions also get `webhookSecret`, returned once, to verify the alerts (below).

## What triggers an alert

The five donor stages from `DONOR_STAGES` (**Verified, Funded, Settled, Delivered, ImpactConfirmed**) and a
donation's final outcome (**Completed, Refundable, Refunded, Expired, Cancelled**). Each is sent at most once per
subscription.

A timeline event is only a trigger. For every need touched by a page of events, the worker re-reads the state of
the subscriptions on that need (`GET /donations/:ref`, or `GET /needs/:id` for need-level subscriptions, each
fetched once per poll), diffs the reached stages against `notifiedStages` (`src/stages.ts`, pure) and queues one
delivery per new milestone. A missed or reordered event can delay an alert but not lose or duplicate one.

Need-level subscriptions derive the same stages from the need: verification threshold met, funding closed, a
Settlement attestation, a finalized delivery, an unrevoked impact report. Refunds are per donation, so a need's
outcomes are Completed, Expired and Cancelled only.

## Privacy model

There are no accounts. What the database holds per subscription:

| Column | Content |
|---|---|
| `trackingRef` / `needId` | Public identifiers already visible on the tracking page |
| `emailCiphertext` | AES-256-GCM ciphertext of the address under a fresh data key, bound to the subscription id |
| `wrappedDek` | That data key, sealed with `HKDF(KEK, "notifier:email")` |
| `webhookUrl` | The subscriber's URL (webhook channel) |
| `tokenHash` | sha256 of the unsubscribe token |
| `notifiedStages` | Milestones already announced |

- **Encrypted at rest.** The address is decrypted only in memory, immediately before the email provider call, and
  is never logged. Nothing else in the service can read it.
- **Crypto-shredding on unsubscribe.** `DELETE /subscriptions/:id` and the email link null out `wrappedDek` *and*
  `emailCiphertext`, set `unsubscribedAt` and cancel queued alerts. Without the data key the address is
  unrecoverable, including from backups taken before the unsubscribe that lack the KEK.
- **Payloads never contain the address or a token.** `NotificationDelivery.payload` stores the rendered email with
  an `{{unsubscribe_url}}` placeholder; the dispatcher fills it in at send time. `/outbox` shows the link with
  `token=[redacted]`.
- **Logs** record ids, never bodies, addresses or tokens; the `token` query parameter is redacted from request logs.
- **Unsubscribe links in emails** carry a token derived as `HMAC(HKDF(KEK, "notifier:unsubscribe-link"),
  subscriptionId)`: recomputed at send time, so every email (not only the first) has a working one-click link
  without the token ever being stored. `DELETE` and `GET /unsubscribe` accept either this token or the
  subscriber's own `unsubscribeToken`. Each email also links to the tracking page's alerts section
  (`<APP_BASE_URL>/en/track/<ref>#alerts`).
- **Keys.** `NOTIFIER_KEK` (32-byte hex) or the key file at `NOTIFIER_KEK_PATH`, created on first run and announced
  in the log. Losing it makes every stored address unreadable, which is the same property that makes shredding
  work. It is separate from the PII vault's NGO key: this service has no reason to hold that one.

What webhooks contain:

- **Integrator webhooks:** the indexer's `TimelineEvent` exactly as `/timeline` returns it (public, on-chain data).
- **Alert webhooks:** `{ type: "alert.stage" | "alert.outcome", subscriptionId, trackingRef, needId, milestone,
  stage, currentStage, outcome, reachedAt, txHash, attestationUID, pending, trackUrl, need: { category, region,
  status, amounts… }, donation: { kind, amount, currency, receiptId } | null, createdAt }`. No donor address.

## Outbound webhooks

Every POST (integrator and alert) carries:

```http
content-type: application/json
user-agent: ProofOfAid-Notifier/1
x-poa-event: DonatedOnBehalf            # the timeline event type, or alert.stage / alert.outcome
x-poa-delivery: 3f5c…                   # delivery id, stable across retries
x-poa-timestamp: 1789560000             # unix seconds of this attempt
x-poa-signature: sha256=<hex HMAC-SHA256 of the raw body>
```

The secret is the endpoint's `secret` (from `POST /webhooks`, stored sealed with `HKDF(KEK,
"notifier:webhook-secret")`) or, for an alert subscription, its `webhookSecret` (derived as
`HMAC(HKDF(KEK, "notifier:alert-webhook"), subscriptionId)`, never stored). Only a 2xx response counts as
delivered; redirects are not followed.

### Verifying a signature (Node)

Compute the HMAC over the **raw** request body, before any JSON parsing:

```js
import { createHmac, timingSafeEqual } from 'node:crypto'
const expected = Buffer.from(`sha256=${createHmac('sha256', SECRET).update(rawBody).digest('hex')}`)
const received = Buffer.from(req.headers['x-poa-signature'] ?? '')
if (expected.length !== received.length || !timingSafeEqual(expected, received)) return res.writeHead(401).end()
const event = JSON.parse(rawBody)
```

`verifyWebhookSignature(secret, rawBody, header)` from `@poa/shared` does the same. The signature covers the body
only, not the timestamp header, so deduplicate on what the body identifies: `id` for timeline events,
`subscriptionId` + `milestone` for alerts. Delivery is at-least-once (a timeout after the receiver processed the
request is retried).

### Integrator filters

`POST /webhooks { url, needId?, eventTypes? }`: `needId` limits delivery to one need, `eventTypes` to a subset of
the indexer's `TimelineEventType` values (unknown types are rejected). An endpoint receives the events the worker
processes after it is registered.

### SSRF guard

Subscriber and integrator URLs are checked when registered and again before every send (`src/urls.ts`):

- https only; plain `http://localhost` / `http://127.0.0.1` is allowed when `NODE_ENV` is not `production`;
- no credentials in the URL; no redirects followed;
- in production, no `localhost`, and IP literals in private, loopback, link-local (`169.254.169.254`), CGNAT,
  multicast, documentation or IPv4-mapped forms of those are refused, including encodings such as
  `https://2130706433/`.

Not covered: a public hostname that resolves to a private address (DNS rebinding). Closing that needs
resolve-and-pin at connect time or an egress proxy; run the service behind an egress-restricted network in
production.

## Worker

Started by `server.ts` in the same process (`NOTIFIER_WORKER=off` disables it). Every `NOTIFIER_POLL_MS`
(10 s), and right after a subscription queues its confirmation email:

1. **Poll.** Read `/timeline?after=<cursor>&limit=200` from the `NotifierCursor` row `timeline` (from the start
   when there is none) and page until the cursor stops advancing (at most 50 pages per cycle). For each page, in
   one transaction: integrator deliveries (`WEBHOOK:<endpointId>:<eventId>`), alert deliveries
   (`<ALERT_EMAIL|ALERT_WEBHOOK>:<subscriptionId>:<milestone>`), the new `notifiedStages`, and the cursor. The
   cursor never passes events whose deliveries are not stored (at-least-once), and the unique `dedupeKey` turns a
   replay into a no-op (exactly-once). If the indexer fails mid-page, nothing is written and the next cycle retries.
2. **Dispatch.** Due `PENDING` rows are claimed with a compare-and-set on `nextAttemptAt` (safe with several
   instances), sent with a 10 s timeout, and marked `SENT`, or retried after **1 min, 5 min, 30 min, 2 h, 12 h**;
   the sixth failed attempt marks the row `FAILED` with `lastError`. Deliveries for a cancelled subscription or a
   disabled endpoint fail immediately without being sent.
3. **Shutdown.** SIGINT/SIGTERM stops the loop, waits for the in-flight cycle, then closes the server and Prisma.

### Email drivers

- **API** when `EMAIL_API_URL` and `EMAIL_API_KEY` are set: `POST { from, to, subject, text }` with
  `authorization: Bearer <key>` (Resend-compatible, e.g. `https://api.resend.com/emails`).
- **Outbox** otherwise: the delivery is marked `SENT` and nothing leaves the process; read the rendered emails at
  `GET /outbox`.

## Known limitations

- **No double opt-in.** Anyone can subscribe any address to one confirmation email per subscription. Put a rate
  limit in front of `POST /subscriptions` in production, or add a confirm step.
- **One-click GET unsubscribe.** Some corporate mail scanners fetch links, which would unsubscribe the recipient.
  A POST confirmation step (or RFC 8058 `List-Unsubscribe-Post`) would avoid that.
- **No RSS channel** yet (GAP_PLAN A6 mentions one); webhook and email only.
- The alert state is read at poll time, so several stages reached between two polls arrive as several emails at
  once, in stage order.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `PORT` / `HOST` | `4004` / `0.0.0.0` | |
| `LOG_LEVEL` | `info` | |
| `NODE_ENV` | — | `production` turns on the strict SSRF guard (the Docker image sets it) |
| `DATABASE_URL` | — | Postgres; required |
| `INDEXER_URL` | `http://localhost:42069` | Compose: `NOTIFIER_INDEXER_URL`, default `http://host.docker.internal:42069` |
| `INDEXER_TIMEOUT_MS` | `5000` | Per indexer request |
| `APP_BASE_URL` | `http://localhost:3000` | Tracking links: `<APP_BASE_URL>/en/track/<ref>`, `/en/needs/<id>` |
| `PUBLIC_BASE_URL` | `http://localhost:<PORT>` | Unsubscribe links; warned about in production when unset |
| `NOTIFIER_KEK` | — | 32-byte hex; takes precedence over the key file |
| `NOTIFIER_KEK_PATH` | `./secrets/notifier-kek.key` | Created on first run |
| `NOTIFIER_ADMIN_TOKEN` | — | ≥ 16 chars; unset ⇒ admin API disabled (503) |
| `NOTIFIER_WORKER` | `on` | `off` ⇒ API only |
| `NOTIFIER_POLL_MS` | `10000` | |
| `NOTIFIER_WEBHOOK_TIMEOUT_MS` | `10000` | Per webhook POST and email API call |
| `EMAIL_API_URL` / `EMAIL_API_KEY` | — | Both set ⇒ API driver, else outbox |
| `EMAIL_FROM` | `Proof of Aid <alerts@proof-of-aid.local>` | |
| `CORS_ORIGIN` | `*` | Comma-separated list, or `*` |

## Running

```bash
docker compose up -d postgres
pnpm db:push                                   # first run, or after a schema change
pnpm indexer:dev                               # the notifier tails it
NOTIFIER_ADMIN_TOKEN=dev-admin-token-please-change pnpm --filter @poa/notifier dev
# or: docker compose up -d --build notifier
```

## Tests

```bash
pnpm --filter @poa/notifier test
```

- `stages.test.ts`, `security.test.ts` (pure): stage and outcome diffing, need-level stages, backoff schedule,
  cursor parsing, signature format, SSRF guard, envelope encryption and AAD binding, token handling, rendered
  payloads carrying no address or token.
- `api.test.ts` (no database): admin 503/401, validation, SSRF rejections, unknown references, indexer down.
- `flow.test.ts` (Postgres, a fake indexer, fake webhook and email receivers): subscribe → poll (two pages, one
  indexer read per donation) → dispatch with verified signatures → outbox without addresses → unsubscribe by token
  and by email link with the address shredded; re-running the poller, even with a lost cursor, creates no
  duplicates; a 500 receiver is retried on the backoff schedule and then marked `FAILED`. It **resets the notifier
  tables** (and refuses to on a non-local `DATABASE_URL`), and skips with a message when Postgres is unreachable.
