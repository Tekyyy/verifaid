#!/usr/bin/env node
/**
 * Deploys the whole system to a local anvil chain and seeds the demo data:
 *   Deploy.s.sol → RegisterSchemas.s.sol → RegisterCommunitySchemas.s.sol → SeedDemo.s.sol → VerifyDemoNeeds.s.sol
 *
 * Uses anvil's first well-known account as deployer/admin. Since nothing on a fresh anvil has code, the deploy
 * script also brings up its own EAS and SchemaRegistry instances.
 *
 *   pnpm chain          # in another terminal
 *   pnpm deploy:local
 *   pnpm deploy:local --handover   # also hand the admin role to a timelock, as a public deployment does
 *
 * Locally there is no Safe, so with --handover the timelock's proposer is anvil account #6 standing in for one,
 * and the delay is a minute: enough to exercise scripts/admin.mjs end to end.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const contracts = join(root, 'contracts')

// anvil's first account: publicly known, local chain only
const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const rpcUrl = process.env.ANVIL_RPC_URL ?? 'http://127.0.0.1:8545'
// anvil account #6 (the council member on public chains), the stand-in for the admin Safe locally
const ANVIL_COUNCIL = '0x976EA74026E726554dB657fA54763abd0C3a0aa9'
const handover = process.argv.includes('--handover')

const env = {
  ...process.env,
  DEPLOYER_PRIVATE_KEY: process.env.DEPLOYER_PRIVATE_KEY ?? ANVIL_KEY,
  // Always anvil's well-known mnemonic locally, even when .env carries a private one for a public testnet:
  // the service test suites derive their role wallets from it, so the local seed has to match.
  DEMO_MNEMONIC: '',
  // Left empty on purpose: a fresh anvil has no EAS, so Deploy.s.sol deploys a local instance.
  EAS_ADDRESS: process.env.EAS_ADDRESS ?? '',
  SCHEMA_REGISTRY_ADDRESS: process.env.SCHEMA_REGISTRY_ADDRESS ?? '',
  STABLECOIN_ADDRESS: process.env.STABLECOIN_ADDRESS ?? '',
  // Every conversion address unset → mock swap router, tokens and feeds. The mock feeds never update, so their
  // answers must stay fresh for as long as a local chain lives (the demo also moves time forward).
  SWAP_ROUTER_ADDRESS: '',
  EUR_USD_HEARTBEAT: String(365 * 24 * 3600),
  USDC_USD_HEARTBEAT: String(365 * 24 * 3600),
  ETH_USD_HEARTBEAT: String(365 * 24 * 3600),
  ADMIN_SAFE_ADDRESS: ANVIL_COUNCIL,
  ADMIN_TIMELOCK_DELAY: '60',
}

const run = (script) => {
  console.log(`\n▸ forge script ${script}`)
  // --slow: one transaction at a time, each confirmed before the next. Without it anvil can silently drop the
  // tail of a long batch, leaving a half-wired deployment behind.
  const result = spawnSync(
    'forge',
    ['script', `script/${script}`, '--rpc-url', rpcUrl, '--broadcast', '--slow'],
    {
      cwd: contracts,
      env,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    },
  )
  if (result.status !== 0) {
    console.error(`\n${script} failed. Is anvil running at ${rpcUrl}? Start it with: pnpm chain`)
    process.exit(result.status ?? 1)
  }
}

run('Deploy.s.sol')
run('RegisterSchemas.s.sol')
// Presentations, work photos, tax status, acknowledgments and supplier applications: without these the app's
// panels for them revert with InvalidSchema on a local chain, as they would on a public one.
run('RegisterCommunitySchemas.s.sol')
run('SeedDemo.s.sol')
run('VerifyDemoNeeds.s.sol')
if (handover) run('Handover.s.sol')

// Addresses on a fresh anvil are deterministic, so a stale bundle does not fail loudly — it silently points the
// demo and the app at the *previous* deployment's token wiring. Rebuild it here, where the deployment just changed.
const sync = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['--filter', '@poa/shared', 'build'],
  {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  },
)
if (sync.status !== 0) {
  console.error(
    '\nCould not rebuild @poa/shared with the new addresses. Run: pnpm --filter @poa/shared build',
  )
  process.exit(sync.status ?? 1)
}

// Same addresses, different chain state: the app's server cache would render the previous run's needs once.
rmSync(join(root, 'app', '.next', 'cache', 'fetch-cache'), { recursive: true, force: true })

const deployment = join(root, 'deployments', 'anvil.json')
if (existsSync(deployment)) {
  const { contracts: addresses, schemas, startBlock } = JSON.parse(readFileSync(deployment, 'utf8'))
  console.log('\n✓ Local deployment ready')
  console.log(`  NeedsRegistry   ${addresses.NeedsRegistry}`)
  console.log(`  DeliveryManager ${addresses.DeliveryManager}`)
  console.log(`  Resolver        ${addresses.ProofOfAidResolver}`)
  console.log(`  NeedVerified    ${schemas.NeedVerified}`)
  console.log(`  start block     ${startBlock}`)
  console.log(`\n  addresses: deployments/anvil.json`)
}
