# Proof of Aid — contracts

Solidity 0.8.24, Foundry, OpenZeppelin v5. Dependencies come from npm (`pnpm install`), not git submodules.

```bash
pnpm install                # installs OpenZeppelin, EAS, Semaphore, forge-std
forge build
forge test                  # 216 tests: unit, fuzz, invariant, end-to-end, real-Semaphore integration
forge coverage --report summary --no-match-coverage "(script|test|mocks)"
```

## The map

| Contract | Responsibility |
|---|---|
| `access/RoleRegistry` | Who is an NGO, a verifier, a field agent, a bank partner — and the global pause. One address holds at most one operational role, which is what makes "independent verifier" checkable on-chain. |
| `needs/NeedsRegistry` | The need lifecycle and its state machine. Records verifications forwarded by the EAS resolver; deploys the vault when the verification threshold is reached. |
| `funds/AidVaultFactory` | One minimal-proxy `AidVault` per verified need; also the system-wide registry of fiat payment references, so one bank transfer cannot fund two needs. |
| `funds/AidVault` | Escrow. Accepts crypto and fiat-backed donations, splits the total into tranches when funding closes, releases them one at a time, and refunds pro-rata if the need is cancelled. **No admin withdrawal path exists.** |
| `funds/DonationReceipt` | Soulbound (ERC-5192) ERC-721 receipt with fully on-chain metadata. Evidence, not an asset — so it cannot be transferred or sold. |
| `identity/BeneficiaryGroups` | One Semaphore group per NGO programme. Beneficiaries exist here only as identity commitments. |
| `delivery/DeliveryManager` | Ties a delivery to a tranche: field evidence, anonymous beneficiary confirmations, independent verifier sign-off, challenge window, finalize. |
| `resolvers/*` | Five EAS schema resolvers. They decide who may attest what, and forward accepted attestations into the contracts above. |

## How money moves

```
verified need ──► vault ──► donations (crypto + fiat) ──► funding closes ──► tranche plan fixed
                                                                              │
                        tranche 0 released as pre-financing ◄─────────────────┘
                                   │
          ┌────────────────────────┴───────────────────────────────────┐
          │  for every later tranche, all three must be true:          │
          │    1. evidence attested by the NGO's field agent           │
          │    2. ≥ 70% of expected recipients confirmed anonymously   │
          │    3. an independent verifier approved                     │
          │  then a challenge window passes without a dispute          │
          └────────────────────────┬───────────────────────────────────┘
                                   ▼
                       tranche released to the NGO's payout Safe
                                   │
                    last tranche ──► need Completed ──► impact report
```

Cancel a need at any point before completion and every donor — crypto or fiat — can claim their pro-rata share
of whatever was not released yet. The invariant `balance + released + refunded == donated` is checked by a fuzz
test and by a stateful invariant test over 12,800 random call sequences.

## Why a beneficiary never appears on-chain

A beneficiary is a Semaphore identity commitment in a group, nothing more. To confirm a delivery they produce a
zero-knowledge proof that they belong to the programme's group, scoped to that delivery. The chain records a
nullifier and a counter. The same person confirming two different deliveries produces two unlinkable
nullifiers, and confirming the same delivery twice is impossible — Semaphore enforces that, not us.

Because the proof is relayed by a third party, the beneficiary's wallet never appears in a transaction either.
A delivery with fewer than five expected recipients is refused, so a confirmation count cannot point at one
household. Regions are coarse ISO 3166-2 subdivisions; there is no GPS, no photo, no name, and no unsalted hash
of any of those anywhere in the system.

## Attestations

Five EAS schemas (`NeedVerified`, `DeliveryEvidence`, `DeliveryVerified`, `FiatDonation`, `ImpactReport`).
Each resolver derives the UID of the one schema it serves from its own address, exactly as the SchemaRegistry
does, and rejects everything else — so registering a look-alike schema against our resolver achieves nothing.
`refUID` chains the evidence together: a sign-off must point at the evidence it reviewed, and an impact report
must point at the sign-off of the need's last verified delivery. That chain is walkable in any EAS explorer.

## Tests

| Suite | What it covers |
|---|---|
| `test/unit/*` | Every function and revert path of every contract |
| `test/fuzz/VaultMath.t.sol` | Tranche splitting and refund arithmetic over random inputs |
| `test/invariant/AidVaultInvariant.t.sol` | The accounting identity under random sequences of donations, releases, cancellation and refunds |
| `test/e2e/Lifecycle.t.sol` | The full spec §7 lifecycle, plus nullifier reuse, non-independent verifiers, challenge and dispute, cancellation and refunds |
| `test/integration/RealSemaphore.t.sol` | Real Semaphore v4 contracts with real Groth16 proofs from a committed fixture: threshold confirmations, replay, tampering, wrong scope, and post-erasure root expiry |

The Semaphore fixture is regenerated with `pnpm fixture:semaphore` (downloads the official proving artifacts).

## Deploying

```bash
forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --verify
forge script script/RegisterSchemas.s.sol --rpc-url base_sepolia --broadcast
forge script script/SeedDemo.s.sol --rpc-url base_sepolia --broadcast
```

`Deploy.s.sol` reuses the external contracts that already exist on the target chain and deploys local
stand-ins for whatever is missing, so the same script works on anvil and on Base Sepolia. Addresses and schema
UIDs are written to `deployments/<network>.json`, which every off-chain package reads.
