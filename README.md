# Proof of Aid

**The public chain holds flows and proofs. It never holds people.**

A blockchain-native system to register verified needs, trace donations end to end, prove that aid was actually
delivered, protect beneficiaries' data, and publish impact anyone can recompute. Built for Base Sepolia.

| Requirement | Where it lives |
|---|---|
| R1 — register previously verified needs | `NeedsRegistry` + `NeedVerified` EAS attestations |
| R2 — track the path of donations | `AidVault`, soulbound `DonationReceipt`, `FiatDonation` attestations |
| R3 — evidence of aid delivery | `DeliveryManager`, `DeliveryEvidence` + `DeliveryVerified` attestations, Semaphore receipt proofs |
| R4 — protect beneficiaries' data | off-chain PII vault, Semaphore identities, encrypted evidence |
| R5 — verifiable impact | `ImpactReport` attestations, Ponder indexer, public dashboard |

## How it works

```
NGO registers ─► verifier attests the need ─► vault deploys ─► donors fund it (crypto or fiat via a bank partner)
      │                                                                    │
      │                                                    tranche 0 releases as pre-financing
      ▼                                                                    ▼
field agent delivers aid, uploads encrypted evidence ─► beneficiaries confirm anonymously (Semaphore)
      │                                                                    │
      └──► independent verifier signs off ─► challenge window ─► next tranche unlocks ─► impact report
```

Money only moves forward when three independent signals agree: field evidence, anonymous beneficiary
confirmations above a threshold, and an approving verifier who is provably unrelated to the NGO.

## Live on Base Sepolia

The system is deployed, source-verified on Basescan, and has run the full lifecycle end to end. Need #5 is the
one to look at: funded with crypto **and** a fiat transfer through a bank partner, two deliveries confirmed by
real zero-knowledge proofs, every tranche released, and an impact report chained to the last verified delivery.

| | |
|---|---|
| `NeedsRegistry` | [`0x3664a0fb745452a3fC7ed75ed221D2132fde471E`](https://sepolia.basescan.org/address/0x3664a0fb745452a3fC7ed75ed221D2132fde471E) |
| `DeliveryManager` | [`0xfd4108300Df609043Ba263307179Cc987531f2f5`](https://sepolia.basescan.org/address/0xfd4108300Df609043Ba263307179Cc987531f2f5) |
| `RoleRegistry` | [`0xC71df0E329f8b304447644a2496Fe6D3b920242e`](https://sepolia.basescan.org/address/0xC71df0E329f8b304447644a2496Fe6D3b920242e) |
| `AidVaultFactory` | [`0xe4970edD5FB64908a69a3B1a17e608C6402644DA`](https://sepolia.basescan.org/address/0xe4970edD5FB64908a69a3B1a17e608C6402644DA) |
| `BeneficiaryGroups` | [`0xA4AcaC78d404783349E58061f7E0EC227d89Fd42`](https://sepolia.basescan.org/address/0xA4AcaC78d404783349E58061f7E0EC227d89Fd42) |
| `DonationReceipt` | [`0x1025Cd8Ba38F95FAE1F4672B7fF379Ab4161fFDB`](https://sepolia.basescan.org/address/0x1025Cd8Ba38F95FAE1F4672B7fF379Ab4161fFDB) |
| test token (mEURC) | [`0xdF3430bCF730A1D065d04FD70d11Aa93dd990e71`](https://sepolia.basescan.org/address/0xdF3430bCF730A1D065d04FD70d11Aa93dd990e71) |

Every address, resolver and schema UID is in [`deployments/base-sepolia.json`](deployments/base-sepolia.json);
the five schemas are browsable on the [Base Sepolia EAS explorer](https://base-sepolia.easscan.org). EAS and
Semaphore v4 are the ones already deployed on Base Sepolia — this project deploys neither.

## Repository layout

```
contracts/    Foundry project: registry, vaults, deliveries, Semaphore groups, five EAS resolvers
services/     evidence (encrypt + IPFS), pii-vault (envelope-encrypted records), bank-connector (mock SEPA)
indexer/      Ponder: events → tables → the API the dashboard reads
app/          Next.js dashboard (public, donor, NGO, verifier, field agent, beneficiary)
deployments/  addresses + schema UIDs per network, written by the deploy scripts
docs/         DECISIONS.md, THREAT_MODEL.md, DEMO_SCRIPT.md
```

## Quick start

Requires Node 22+, pnpm 12+ and [Foundry](https://getfoundry.sh).

```bash
pnpm install
cp .env.example .env
```

Build and test the contracts:

```bash
cd contracts && forge build && forge test
```

Run the whole lifecycle against a local chain:

```bash
pnpm chain          # anvil
pnpm deploy:local   # deploy + register schemas + seed demo data
pnpm demo:run       # execute the full lifecycle and print explorer links
```

Deploy to Base Sepolia (needs `DEPLOYER_PRIVATE_KEY` and `BASESCAN_API_KEY` in `.env`). A dry run against live
Base Sepolia state estimates **~0.0003 ETH** for the whole system, and the script reuses the EAS and Semaphore
contracts already deployed there rather than deploying its own:

```bash
cd contracts
forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --verify
forge script script/RegisterSchemas.s.sol --rpc-url base_sepolia --broadcast
forge script script/SeedDemo.s.sol --rpc-url base_sepolia --broadcast
```

## Privacy

No name, ID number, phone number, exact location, photo, or unsalted hash of any of these ever reaches the
chain. Beneficiaries appear only as Semaphore identity commitments; a delivery confirmation reveals a nullifier
and nothing else, and confirmations are relayed so the beneficiary's own wallet never appears in a transaction.
Deliveries below five expected recipients are refused so a count cannot identify a person. Right to erasure is
handled by destroying the record's data key (crypto-shredding) and removing the identity commitment from the
group. See `docs/THREAT_MODEL.md` for what this does **not** protect against.

## Documentation

- [`docs/DECISIONS.md`](docs/DECISIONS.md) — every open choice in the spec and how it was resolved
- [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) — threats, mitigations and residual risk
- [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md) — the five-minute walkthrough
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — what the MVP deliberately leaves out, and what it would take
- [`contracts/README.md`](contracts/README.md) — contract map, money flow and test suites

## License

MIT
