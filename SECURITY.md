# Security

VerifAid was built for a hackathon. **The contracts have not been audited.** Run it on a testnet, or read
[docs/MAINNET.md](docs/MAINNET.md) and get an audit before any deployment that holds real money.

## Reporting a vulnerability

Please report it privately, not in a public issue: use **Security → Report a vulnerability** on this repository's
GitHub page. Include what is affected (contract, API route or service), how to reproduce it, and what an attacker
gains. You will get an answer as soon as the maintainers can look at it.

In scope: the contracts in `contracts/src`, the app's API routes in `app/src/app/api`, the indexer's API, and the
services in `services/`. The design's own security reasoning is in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Keys and settings

No secret is committed. `.env`, `app/.env.local` and `.env.mainnet` are ignored by git; start from `.env.example` and
`app/.env.example`. The local chain uses anvil's well-known public test keys, which hold nothing of value anywhere.
A key that has ever been pasted into a file others can see should be treated as public: move its funds and roles
to a new key.

## Dependencies

`pnpm audit --prod` reports no critical advisories. What remains, and why it is not reachable here:

| Package | Comes from | Why it does not apply |
|---|---|---|
| `kysely` 0.26, `drizzle-orm` 0.41 (SQL injection advisories) | pinned inside `ponder` 0.17.11, the latest release | The advisories need user input in SQL identifiers or JSON paths (or MySQL). The indexer API passes request input only as bound values against fixed columns, sorts in JavaScript, and GraphQL field names are checked against the schema. Upgrade with Ponder. |
| `vite` 5, `esbuild` 0.21 (dev-server advisories) | pinned inside `ponder` | Both concern their development HTTP servers; `ponder start` does not expose one. |
| `decode-uri-component` 0.2 (slow decoding of malformed input) | WalletConnect, through `wagmi` | Runs in the visitor's own browser on wallet links. The fixed release is ESM-only and breaks the `require()` WalletConnect uses. |

Transitive packages with a compatible fixed release are pinned to it in `pnpm-workspace.yaml` (`overrides`), and the
EAS package's unused `hardhat` dependency is dropped there too: Foundry only reads its Solidity files.
