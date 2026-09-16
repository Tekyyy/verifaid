# @poa/indexer

Ponder indexer for Proof of Aid. It turns the contract events of §5 and the EAS attestations of §6 into the
tables the dashboard reads, and serves them over a small REST API plus GraphQL.

Everything it stores is already public on-chain. Beneficiaries appear only as Semaphore identity commitments
(unlinkable, and needed by the beneficiary page to rebuild the Merkle tree) and as confirmation counts and
nullifiers. No name, contact, location or evidence content is ever indexed.

---

## Running it

Addresses, schema UIDs and the start block are read from `deployments/<network>.json` through `@poa/shared`,
so the indexer never has its own copy of a contract address.

### Against the local anvil chain

```bash
pnpm chain            # anvil, chain id 31337          (repo root, separate terminal)
pnpm deploy:local     # deploy + register schemas + seed demo data
pnpm --filter @poa/indexer dev
```

`PONDER_NETWORK` defaults to `anvil` and the RPC defaults to `http://127.0.0.1:8545`. The API comes up on
<http://localhost:42069>. `dev` hot-reloads on file changes and uses PGlite, so there is nothing to install.

### Against Base Sepolia

```bash
PONDER_NETWORK=base-sepolia \
PONDER_RPC_URL=https://base-sepolia.g.alchemy.com/v2/<key> \
DATABASE_URL=postgresql://poa:poa@localhost:5432/poa \
pnpm --filter @poa/indexer start --schema poa
```

| Variable | Default | Notes |
|---|---|---|
| `PONDER_NETWORK` | `anvil` | `anvil` \| `base-sepolia` \| `base`; must exist in `deployments/` |
| `PONDER_RPC_URL` | the chain's public RPC | Use a private RPC on Base Sepolia — the public one rate-limits the backfill |
| `DATABASE_URL` | PGlite in `.ponder/` | Postgres is required for `ponder start` in production |
| `PORT` | `42069` | |

`ponder start` also needs a database schema (`--schema poa` or `DATABASE_SCHEMA=poa`); `ponder dev` picks one
automatically. Put any of these in `indexer/.env.local` instead of the command line if you prefer.

On a public chain the Semaphore contract is shared with every other project on it. The indexer subscribes to
all of its member events and drops the ones whose group was not created by our `BeneficiaryGroups`.

---

## Endpoints

All responses are the types exported by `@poa/shared` (`services/shared/src/api.ts`). Amounts are decimal
strings in token base units (6 decimals) because JSON has no bigint; timestamps are unix seconds. CORS is
open, since every byte served is already public on-chain.

| Route | Returns | What it is |
|---|---|---|
| `GET /needs?status=&category=&region=` | `NeedSummary[]` | The public needs list. `status` is a `NeedStatus` name (`Funding`, `InDelivery`, …); `category` and `region` accept either the label (`FOOD`, `ES-CM`) or the raw bytes32. |
| `GET /needs/:id` | `NeedDetail` | A need plus its tranches, deliveries, donations and live impact report. |
| `GET /needs/:id/timeline` | `TimelineEvent[]` | The full lifecycle of one need, ordered by block number then log index — one row per state change, from `NeedCreated` to `ImpactReportPublished`. |
| `GET /donors/:address/trace` | `DonorTrace` | "Follow my money": per receipt, the need, the donor's share of its funding in bps, their pro-rata slice of every tranche, and the deliveries behind the releases. |
| `GET /impact/summary` | `ImpactSummary` | Totals plus buckets by category and by region. `beneficiariesServed` counts live (non-revoked) `ImpactReport` attestations only. |
| `GET /programs/:id/members` | `ProgramMembersResponse` | Identity commitments in insertion order, so `/confirm/[deliveryId]` can rebuild the Semaphore group and produce a proof with the right root. |
| `GET /deliveries?status=` | `DeliveryView[]` | The verifier queue. `?status=Open` is what needs a sign-off, `?status=Challengeable` what can still be disputed. |
| `/graphql` | — | The generated GraphQL API over every table, with the relations declared in `ponder.schema.ts`. |

Two details worth knowing:

- In `DonorTrace`, `tranches[].amount` is **the donor's pro-rata slice** of that tranche, not the tranche
  total (`releasedToNgo` is the sum of those slices over released tranches). Everywhere else a tranche amount
  is the full amount.
- `/programs/:id/members` returns every Semaphore leaf, including a `"0"` where a member was removed under the
  right-to-erasure path. Dropping those would shift every later index and produce an invalid Merkle root.
  `memberCount` is the count of live members, which is the number `DeliveryManager` bounds
  `expectedRecipients` against.

---

## Tables

`ponder.schema.ts`, following spec §10.

| Table | Written by | Holds |
|---|---|---|
| `ngo`, `role_account` | `RoleRegistry` | NGO profiles; verifiers, bank partners and field agents |
| `system_state` | `RoleRegistry` | The global pause flag |
| `program`, `program_member`, `semaphore_group` | `BeneficiaryGroups`, `Semaphore` | Programs, their Semaphore group and every leaf in insertion order |
| `need`, `tranche` | `NeedsRegistry`, `AidVaultFactory`, `AidVault` | The need record and its tranche plan, with running totals |
| `donation`, `receipt`, `refund` | `AidVault`, `DonationReceipt` | Direct and fiat donations, soulbound receipts, pro-rata refunds |
| `delivery`, `confirmation`, `challenge` | `DeliveryManager` | Deliveries, anonymous confirmations (nullifier + count), disputes |
| `attestation`, `impact_report` | `EAS` | The five schemas, decoded, linked to their need or delivery |
| `timeline_event` | all of the above | One denormalized row per state change — what `/needs/:id/timeline` reads |

EAS emits `Attested` *before* it calls the resolver, so the core-contract events an attestation triggers
always land at a higher log index in the same transaction. The `Attested` handler reads the payload back with
`getAttestation` and decodes it with the same `@poa/shared` schema definitions the attesting code used.

### Deliberately not indexed

- `RoleGranted` / `RoleRevoked` / `RoleAdminChanged` — the OpenZeppelin plumbing behind `NgoRegistered`,
  `VerifierRegistered` and friends. Indexing both would double-count every role change.
- `Wired` on every contract — one-time deployment wiring, already recorded in `deployments/<network>.json`.
- `DonationReceipt`'s `Locked` (constant for every receipt), `Approval` and `ApprovalForAll` (they revert —
  receipts are soulbound). `Transfer` *is* indexed, so a transfer that should be impossible would show up
  rather than silently desync the owner column.
- `AidVaultFactory.PaymentRefConsumed` — the global replay guard for a bank reference; the same
  `paymentRefHash` is on the fiat `donation` row it guards.
- Semaphore's `GroupCreated` and `ProofValidated` — the first is covered by `ProgramCreated`, the second
  duplicates `ReceiptConfirmed`.
