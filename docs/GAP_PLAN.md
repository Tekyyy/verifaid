# Gap-closing plan: aligning with the Proof of Aid proposal

Source of the gaps: https://proof-of-aid.lovable.app (the public proposal), compared against this repository on
2026-09-16.

**Status (2026-09-16): implemented.** Every item below shipped in the v2 release; C3 is documented as deferred in
`docs/ROADMAP.md` §7, as planned. Where each item lives:

| Item | Where |
|---|---|
| A1 | `README.md`, `docs/DEMO_SCRIPT.md` (both custody models side by side) |
| A2, A3 | indexer `GET /donations/:ref` (`indexer/src/api/track.ts`), app `/track/[ref]` |
| A4 | app `/embed/track/[ref]` and its iframe snippet |
| A5 | indexer `GET /needs?country=&custody=&open=&sort=urgency|gap|newest`, app needs filters |
| A6 | `services/notifier` (email, webhook) and indexer RSS feeds (`/needs/:id/feed.rss`, `/donations/:ref/feed.rss`) |
| A7 | bank connector `POST /checkout/sessions` (sandbox), app card and bank giving panel |
| A8 | app `useTx` with `NEXT_PUBLIC_PAYMASTER_URL` (EIP-5792 paymaster capability) |
| B1, B2, B4 | `NeedsRegistry` terms and `expire`, `TrancheLedger`, `NonCustodialLedger` |
| B3 | `Settlement` schema in `ProofOfAidResolver`, indexer `settlement` table and Settled stage |
| B5 | single resolver, clones with immutable args, packed storage, `confirmReceiptBatch`, transient guard |
| B6 | `deployments/base-sepolia.json` (v2), `deployments/base-sepolia.v1.json` (archived) |
| C1 | bank connector `POST /imports/funding` (CSV), notifier HMAC-signed webhooks |
| C2 | app `GET /api/reports/[needId]` (PDF) |
| C3 | `docs/ROADMAP.md` §7 |

The design choices and the adversarial review of the v2 contracts are in `docs/DECISIONS.md` §12–13.

## Organizing principle: redeploy or not

Every contract change produces new addresses on Base Sepolia, so the plan has two lanes:

- **Lane A: no redeploy.** App, indexer and service work that ships against the *live* deployment. The need #5
  demo keeps working the whole time.
- **Lane B: one contract release (v2).** Every contract change is batched into a **single** redeploy. That
  includes the optimizations from the earlier review, because this is the one moment they cost nothing extra.

Sizes are relative: **S** under half a day, **M** about a day, **L** two to three days.

---

## Lane A: no redeploy (do first, all demoable immediately)

| # | Gap in the proposal | Work | Size |
|---|---|---|---|
| A1 | Pitch mismatch: we built Model B, the proposal leads with Model A | README + DEMO_SCRIPT map this repo to the proposal's Phase 4 / Model B, and say plainly what v1 of the proposal recommends | S |
| A2 | Per-donation public tracking link (`/c/8421`) | Indexer `GET /donations/:ref` where ref = receipt id (direct donors) or `paymentRefHash` (fiat donors, which the bank connector already returns). App route `/track/[ref]`, no login | M |
| A3 | Five-stage donor status (Verified, Funded, Settled, Delivered, Impact confirmed) | Map existing events: Verified = `NeedVerified`, Funded = `FundingClosed`, Settled = tranche released (upgraded by B3), Delivered = delivery finalized, Impact = `ImpactReport`. Shown on `/track` | S |
| A4 | Embeddable "Track this donation" widget | `/embed/track/[ref]`: chrome-less page plus a copy-paste iframe snippet | S |
| A5 | Filters: country, funding gap, urgency | Country = ISO 3166-2 prefix of `regionCode`; funding gap = target minus donated. **Urgency depends on B1's deadline**; until then, sort by gap and age | S |
| A6 | Funded / settled / delivered / impact alerts | Subscription keyed by tracking ref, no account. Email stored with the existing envelope encryption and shreddable on unsubscribe. Worker tails `timeline_event`. Webhook or RSS channel needs no provider | M |
| A7 | Card and bank giving in one flow | Donor-facing "give by card / bank" form that posts to a checkout **mock**, which calls the bank connector: `donateOnBehalf` + `FiatDonation`, reusing what already works | M |
| A8 | No wallet needed for NGOs and verifiers, sponsored gas | Coinbase Smart Wallet is already the default connector. Wire `NEXT_PUBLIC_PAYMASTER_URL` to a CDP paymaster for passkey login with sponsored gas. **No contract change**: smart accounts keep `msg.sender` role checks intact, which an ERC-2771 forwarder would not | M |

## Lane B: contract v2 (one redeploy)

| # | Gap in the proposal | Work | Size |
|---|---|---|---|
| B1 | NeedClaim fields: funding deadline, minimum threshold, partial-execution rules, expected outcome, expiry | New fields on the need. Permissionless `expire(needId)` after the deadline: if raised ≥ threshold, close with tranches **rescaled** to what was raised (partial execution); if below, go to `Expired` with refunds open. `expectedOutcomeHash` is committed at creation. Fuzz the rescaling; the §5.4 accounting invariant must still hold | L |
| B2 | Third-party cost disclosure | `thirdPartyCostBps` plus a disclosure hash on the need, and a fee field on funding attestations (B4) | S |
| B3 | "Settled" stage and reconciliation | New EAS schema `Settlement(needId, trancheIndex, gross, fee, net, supplierRefHash, fxRef)` attested after a release. The indexer's Settled stage becomes real, replacing A3's approximation | M |
| B4 | Model A: non-custodial path | Need-level `custodyMode`: **OnChain** (today's vault) or **OffChain**. In OffChain mode there is no vault: a generalized `FundingRecorded(needId, gross, fee, net, currency, paymentRefHash)` attestation from a registered provider drives funding progress, and milestones advance on attestations. Makes the protocol provider-neutral. `FiatDonation` is most of this already | L |
| B5 | *(optimizations, bundled because the redeploy is happening anyway)* | One resolver for all seven schemas; display-only fields (`metadataURI`, `category`) moved to events; struct packing; `confirmReceiptBatch`; cache `programId`/`ngo` on the delivery; transient reentrancy guard. Measured earlier: roughly −30 KB bytecode, −45% `createNeed`, −35% per delivery's confirmations | M |
| B6 | Ship v2 | Deploy, verify, register schemas, seed, re-run `demo:run` on Base Sepolia. Indexer schema migration and deployment sync. Keep the v1 addresses in `deployments/base-sepolia.v1.json` so the existing demo links keep resolving | M |

## Lane C: integrations and reporting (after A, independent of B)

| # | Gap in the proposal | Work | Size |
|---|---|---|---|
| C1 | Integration levels 2–3: CSV import, API, outbound webhooks | CSV import for funding and delivery records. HMAC-signed outbound webhooks on timeline events, reusing `@poa/shared` auth | M |
| C2 | Donor, funder and audit reports as PDF | Server route rendering a need's timeline, attestations and amounts to PDF | M |
| C3 | OfferBook, ProtocolTreasury, multichain | Deferred: the proposal itself marks these "later". Add to `docs/ROADMAP.md` | S |

---

## Dependencies

```
A1 A2 A4 A7 A8 C1 C2      independent, start any time
A2 ──► A3, A4, A6         the tracking ref is the key everything hangs off
B1 ──► A5 (urgency)       deadline has to exist before it can be sorted on
B3 ──► A3 (real Settled)  A3 ships with an approximation first
B1..B5 ──► B6             must land together: one redeploy, not five
```

## Suggested order

1. **A1, A2, A3.** Pitch alignment plus the donor tracking link: the most visible gap for the least risk.
2. **A5 (partial), A4, A8.** Filters, the widget, and wallet-less NGO onboarding.
3. **B1–B6 as one release.** Protocol fields, settlement, Model A, and optimizations, then redeploy.
4. **A6, A7, C1, C2.** Alerts, card flow, integrations, reports.

## Decisions needed before Lane B

1. **Redeploy:** v2 means new addresses. Keep v1 live alongside it for the existing demo links?
2. **Model A (B4):** build the non-custodial path (largest item), or only reframe the pitch (A1)?
3. **Card payments (A7):** mock only, or a real payment-provider sandbox (needs an account and API key)?
4. **Alerts (A6):** email (needs a mail provider key) or webhook/RSS only?
