#!/usr/bin/env node
/**
 * Deploys the whole system to a local anvil chain and seeds the demo data:
 *   Deploy.s.sol → RegisterSchemas.s.sol → SeedDemo.s.sol
 *
 * Uses anvil's first well-known account as deployer/admin. Since nothing on a fresh anvil has code, the deploy
 * script also brings up its own EAS, SchemaRegistry and Semaphore v4 instances.
 *
 *   pnpm chain          # in another terminal
 *   pnpm deploy:local
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const contracts = join(root, 'contracts')

// anvil's first account: publicly known, local chain only
const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const rpcUrl = process.env.ANVIL_RPC_URL ?? 'http://127.0.0.1:8545'

const env = {
  ...process.env,
  DEPLOYER_PRIVATE_KEY: process.env.DEPLOYER_PRIVATE_KEY ?? ANVIL_KEY,
  // Left empty on purpose: a fresh anvil has no EAS/Semaphore, so Deploy.s.sol deploys local instances.
  EAS_ADDRESS: process.env.EAS_ADDRESS ?? '',
  SCHEMA_REGISTRY_ADDRESS: process.env.SCHEMA_REGISTRY_ADDRESS ?? '',
  SEMAPHORE_ADDRESS: process.env.SEMAPHORE_ADDRESS ?? '',
  STABLECOIN_ADDRESS: process.env.STABLECOIN_ADDRESS ?? '',
}

const run = (script) => {
  console.log(`\n▸ forge script ${script}`)
  const result = spawnSync('forge', ['script', `script/${script}`, '--rpc-url', rpcUrl, '--broadcast'], {
    cwd: contracts,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    console.error(`\n${script} failed. Is anvil running at ${rpcUrl}? Start it with: pnpm chain`)
    process.exit(result.status ?? 1)
  }
}

run('Deploy.s.sol')
run('RegisterSchemas.s.sol')
run('SeedDemo.s.sol')

const deployment = join(root, 'deployments', 'anvil.json')
if (existsSync(deployment)) {
  const { contracts: addresses, schemas, startBlock } = JSON.parse(readFileSync(deployment, 'utf8'))
  console.log('\n✓ Local deployment ready')
  console.log(`  NeedsRegistry   ${addresses.NeedsRegistry}`)
  console.log(`  DeliveryManager ${addresses.DeliveryManager}`)
  console.log(`  NeedVerified    ${schemas.NeedVerified}`)
  console.log(`  start block     ${startBlock}`)
  console.log(`\n  addresses: deployments/anvil.json`)
}
