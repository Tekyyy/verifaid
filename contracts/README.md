# Proof of Aid — contracts

Solidity 0.8.24, Foundry, OpenZeppelin v5. Dependencies come from npm (`pnpm install`), not git submodules.

```bash
pnpm install                # installs OpenZeppelin, EAS, Semaphore, forge-std
forge build
forge test                  # 322 tests: unit, fuzz, invariant, end-to-end, real Semaphore, review regressions
BASE_MAINNET_RPC_URL=https://mainnet.base.org forge test --match-path test/fork/*   # conversions on real Base
forge coverage --report summary --no-match-coverage "(script|test|mocks)"
```

## The map

| Contract | Responsibility |
|---|---|
| `access/RoleRegistry` | Who is an NGO, a verifier, a field agent, a payment provider (`BANK_PARTNER_ROLE`), and the global pause. One address holds at most one operational role, which is what makes "independent verifier" checkable on-chain. |
| `needs/NeedsRegistry` | The need (the proposal's *NeedClaim*): its terms, lifecycle and state machine. Records verifications forwarded by the resolver, clones the need's ledger when the threshold is reached, and applies deadlines through the permissionless `expire`. |
| `funds/TrancheLedger` | Funding and tranche rules shared by both custody modes: the minimum threshold, the tranche split of what was actually raised, releases in order, and the delivery gate. |
| `funds/AidVault` | On-chain custody (Model B). Escrow for stablecoin donations from wallets and payment providers; releases tranches to the NGO's payout Safe; refunds pro-rata if the need is cancelled or expires. **No admin withdrawal path exists.** |
| `funds/NonCustodialLedger` | Off-chain custody (Model A). No token ever touches it: the need's named custodian records funding and tranche payouts by attestation, under the same rules. |
| `funds/AidVaultFactory` | Clones one ledger per verified need, with the need id baked into the clone's code; also the system-wide registry of payment references, scoped per provider. |
| `funds/DonationReceipt` | Soulbound (ERC-5192) ERC-721 receipt with fully on-chain metadata. Evidence, not an asset, so it cannot be transferred or sold. |
| `identity/BeneficiaryGroups` | One Semaphore group per NGO programme. Beneficiaries exist here only as identity commitments. |
| `delivery/DeliveryManager` | Ties a delivery to a tranche: field evidence, anonymous beneficiary confirmations (single or batched), independent verifier sign-off, challenge window, finalize. |
| `resolvers/ProofOfAidResolver` | The EAS resolver for all six schemas. Decides who may attest what and forwards accepted attestations into the contracts above. Also keeps each need's cumulative fees (provider, settlement and conversion) under its cost cap. |
| `conversion/ConversionRouter` | v3. Swaps a donation in USDC or ETH into the vault token on Uniswap v3 over admin-set routes through fixed hubs, refusing any output below the Chainlink fair value minus the route's bound. Changes to anything money may be waiting on take two days. |
| `funds/DonationForwarderFactory` | v3. `donate`: a wallet gives USDC or ETH, only what the need can take is converted, and the wallet gets the receipt. Also deploys deposit addresses and registers the keepers that may sweep them. |
| `funds/DonationForwarder` | v3. A deposit address (CREATE2 clone committing to its need, receipt wallet, refund route and refund key) for money sent from an exchange. Swept by its donor or a keeper; refunds only where the intent says, or where the refund key signs for. |

## A need's terms

Everything an NGO commits to at creation, and what enforces it:

| Term | Enforcement |
|---|---|
| Custody mode, and the custodian for off-chain custody | Which ledger is cloned; only the named custodian may record funding or payouts |
| Funding deadline | No verification or donation after it; `expire` then closes funding or expires the need |
| Minimum funding (`minFundingBps`) | Funding closes early or at the deadline only at or above it; below it the need expires and refunds open. 10000 = all or nothing; lower = partial execution with every tranche scaled down |
| Execution deadline | After it (plus a 14-day grace period for work already in flight) anyone can expire the need and the unreleased balance is refundable |
| Third-party cost cap + disclosure hash | Funding, conversion and settlement fees together stay within the cap of what donors paid |
| Tranche plan, target, region, dossier hash | As in v1; the region is checked against delivery evidence and the dossier against verifications |
| Category, metadata URI, expected outcome hash | Committed in the `NeedCreated` event (nothing on-chain reads them, so they are not stored) |

## How money moves

```
verified need ──► ledger cloned ──► funding ──────────────────────────► funding closes ──► tranches fixed
                    │                 on-chain: wallet donations (EURC,    (target reached, or the NGO closes
                    │                   or USDC/ETH converted on the way     at/above its minimum, or the
                    │                   in) and provider deposits
                    │                 off-chain: the custodian's            deadline passes at/above it)
                    │                   FundingRecorded attestations               │
                    │                                                              │
                    │                 tranche 0 released as pre-financing ◄────────┘
                    │                    on-chain: anyone calls releaseTranche(0)
                    │                    off-chain: the custodian's Settlement attestation
                    │                                    │
                    │          ┌─────────────────────────┴─────────────────────────────────┐
                    │          │  for every later tranche, all three must be true:         │
                    │          │    1. evidence attested by the NGO's field agent          │
                    │          │    2. ≥ 70% of expected recipients confirmed anonymously  │
                    │          │    3. an independent verifier approved                    │
                    │          │  then a challenge window passes without a dispute         │
                    │          └─────────────────────────┬─────────────────────────────────┘
                    │                                    ▼
                    │                  tranche released (and a Settlement reconciles it)
                    │                                    │
                    │                 last tranche ──► need Completed ──► impact report
                    ▼
     below the minimum at the deadline, cancelled, or past the execution deadline ──► refunds (on-chain custody)
```

The invariant `balance + released + refunded == donated` is checked by fuzz tests and by a stateful invariant
test over 12,800 random call sequences that include the passage of time, partial execution and expiry.

## Why a beneficiary never appears on-chain

A beneficiary is a Semaphore identity commitment in a group, nothing more. To confirm a delivery they produce a
zero-knowledge proof that they belong to the programme's group, scoped to that delivery. The chain records a
nullifier and a counter. The same person confirming two different deliveries produces two unlinkable
nullifiers, and confirming the same delivery twice is impossible — Semaphore enforces that, not us.

Because proofs are relayed by a third party (one transaction can carry a whole batch), the beneficiary's wallet
never appears in a transaction either. A delivery with fewer than five expected recipients is refused, so a
confirmation count cannot point at one household. Regions are coarse ISO 3166-2 subdivisions; there is no GPS,
no photo, no name, and no unsalted hash of any of those anywhere in the system.

## Attestations

Six EAS schemas, one resolver, in the order a donor experiences them:

| Schema | Attester | Effect |
|---|---|---|
| `NeedVerified` | independent verifier | counts toward the need's verification threshold; revocable while nothing was raised |
| `FundingRecorded` | payment provider | on-chain custody: vouches for a deposit already in the vault; off-chain: *is* the funding record |
| `DeliveryEvidence` | the NGO's field agent | links encrypted evidence (hash + CID) to a delivery in the need's region |
| `DeliveryVerified` | independent verifier | sign-off that must reference the evidence it reviewed |
| `Settlement` | NGO (on-chain) / custodian (off-chain) | reconciles one tranche payout: gross, fee, net, supplier and FX references |
| `ImpactReport` | NGO | outcomes of a completed need, referencing the last verified delivery; revocable to correct |

The resolver derives every UID it accepts from its own address, exactly as the SchemaRegistry does, and rejects
everything else, so registering a look-alike schema against it achieves nothing. `refUID` chains the evidence
together, walkable in any EAS explorer.

## Tests

| Suite | What it covers |
|---|---|
| `test/unit/*` | Every function and revert path of every contract, including need terms, expiry, off-chain custody, batched confirmations and settlements |
| `test/fuzz/VaultMath.t.sol` | Tranche splitting, partial-execution rescaling, and refund arithmetic over random inputs |
| `test/invariant/AidVaultInvariant.t.sol` | The accounting identity under random sequences of donations, releases, time passing, expiry, cancellation and refunds |
| `test/e2e/Lifecycle.t.sol` | The full lifecycle, plus nullifier reuse, non-independent verifiers, challenge and dispute, cancellation and refunds |
| `test/integration/RealSemaphore.t.sol` | Real Semaphore v4 contracts with real Groth16 proofs from a committed fixture |
| `test/regression/V2ReviewFindings.t.sol` | Every finding of the adversarial review of v2, replayed against the fix (see `docs/DECISIONS.md` §12) |
| `test/unit/ConversionRouter.t.sol`, `test/unit/DonationForwarder.t.sol` | The oracle bound, stale prices and the sequencer check, the configuration delay and hubs, how much input fills a need (fuzzed), wallet donations, deposit addresses, sweeps and signed refunds |
| `test/regression/V3ReviewFindings.t.sol` | Every finding of the adversarial review of the conversions, replayed against the fix (see `docs/DECISIONS.md` §14) |
| `test/fork/BaseMainnetConversion.t.sol` | Real Circle USDC/EURC, Uniswap v3 pools and Chainlink feeds on a Base mainnet fork (runs when `BASE_MAINNET_RPC_URL` is set) |

The Semaphore fixture is regenerated with `pnpm fixture:semaphore` (downloads the official proving artifacts).

## Deploying

```bash
pnpm deploy:sepolia          # deploy + verify, register schemas, seed, create the test Uniswap pool; prints every link
pnpm deploy:sepolia liquidity   # later: put that pool back at the oracle price
```

or step by step:

```bash
forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --verify
forge script script/RegisterSchemas.s.sol --rpc-url base_sepolia --broadcast
forge script script/SeedDemo.s.sol --rpc-url base_sepolia --broadcast
forge script script/SeedLiquidity.s.sol --rpc-url base_sepolia --broadcast
```

`Deploy.s.sol` reuses the external contracts that already exist on the target chain and deploys local
stand-ins for whatever is missing, so the same script works on anvil and on Base Sepolia. Addresses and schema
UIDs are written to `deployments/<network>.json`, which every off-chain package reads; previous releases are
kept as `deployments/<network>.v1.json`.
