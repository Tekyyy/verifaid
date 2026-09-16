#!/usr/bin/env node
/**
 * Deploys the whole system to Base Sepolia and seeds the demo data:
 *   Deploy.s.sol → RegisterSchemas.s.sol → SeedDemo.s.sol
 *
 *   pnpm deploy:sepolia
 *
 * Reads the repo-root .env explicitly and passes it to forge, because Foundry looks for .env in the directory
 * you run it from — which would be contracts/, not the repo root.
 *
 * The private key is never printed, never passed on a command line, and never written anywhere: it is handed
 * to the child process through its environment only.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const contracts = join(root, 'contracts')
const isWindows = process.platform === 'win32'

const parseEnvFile = (path) => {
  if (!existsSync(path)) return {}
  const out = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    out[match[1]] = match[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}

const fileEnv = parseEnvFile(join(root, '.env'))
const env = { ...fileEnv, ...process.env }

const key = env.DEPLOYER_PRIVATE_KEY?.trim()
if (!key) {
  console.error(
    'DEPLOYER_PRIVATE_KEY is empty.\n\n' +
      'Put your funded Base Sepolia key in the .env file at the repo root:\n' +
      '  DEPLOYER_PRIVATE_KEY=0x<64 hex characters>\n\n' +
      'That file is git-ignored. That wallet becomes the platform admin.',
  )
  process.exit(1)
}
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.error(
    'DEPLOYER_PRIVATE_KEY does not look like a private key (expected 0x followed by 64 hex characters).\n' +
      'A seed phrase or an address will not work here — export the private key from your wallet.',
  )
  process.exit(1)
}

const verify = Boolean(env.BASESCAN_API_KEY?.trim())
if (!verify) {
  console.warn('BASESCAN_API_KEY is empty — deploying without source verification on Basescan.\n')
}
// forge's [etherscan] section reads ETHERSCAN_API_KEY/BASESCAN_API_KEY from the environment.
if (verify) env.ETHERSCAN_API_KEY = env.BASESCAN_API_KEY

const rpcUrl = env.BASE_SEPOLIA_RPC_URL?.trim() || 'https://sepolia.base.org'

console.log('Deploying Proof of Aid to Base Sepolia')
console.log(`  rpc              ${rpcUrl}`)
console.log(`  verify on scan   ${verify ? 'yes' : 'no'}`)
console.log(`  challenge period ${env.CHALLENGE_PERIOD_SECONDS ?? '600'}s`)
console.log('  cost             ~0.0003 ETH to deploy, plus ~0.018 ETH to fund the demo role wallets\n')

const run = (script, extra = []) => {
  console.log(`\n▸ ${script}`)
  const result = spawnSync(
    'forge',
    ['script', `script/${script}`, '--rpc-url', rpcUrl, '--broadcast', '--slow', ...extra],
    { cwd: contracts, env, stdio: 'inherit', shell: isWindows },
  )
  if (result.status !== 0) {
    console.error(
      `\n${script} failed.\n` +
        'If it says "insufficient funds", top the deployer up from a Base Sepolia faucet.\n' +
        'If verification failed but the deploy succeeded, re-run just the verification with:\n' +
        '  forge verify-contract <address> <Contract> --chain base-sepolia --watch',
    )
    process.exit(result.status ?? 1)
  }
}

// `pnpm deploy:sepolia seed` re-runs a single step, e.g. after topping the deployer up.
const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
const wanted = (step) => requested.length === 0 || requested.includes(step)

if (wanted('deploy')) run('Deploy.s.sol', verify ? ['--verify'] : [])
if (wanted('schemas')) run('RegisterSchemas.s.sol')
if (wanted('seed')) run('SeedDemo.s.sol')

const deployment = join(root, 'deployments', 'base-sepolia.json')
if (existsSync(deployment)) {
  const { contracts: addresses, schemas, startBlock } = JSON.parse(readFileSync(deployment, 'utf8'))
  console.log('\n✓ Live on Base Sepolia\n')
  for (const [name, address] of Object.entries(addresses)) {
    console.log(`  ${name.padEnd(26)} https://sepolia.basescan.org/address/${address}`)
  }
  console.log('')
  for (const [name, uid] of Object.entries(schemas)) {
    console.log(`  ${name.padEnd(26)} https://base-sepolia.easscan.org/schema/view/${uid}`)
  }
  console.log(`\n  indexed from block ${startBlock}; addresses in deployments/base-sepolia.json`)
  console.log(
    '\n  Next:  pnpm sync:deployments  &&  pnpm --filter @poa/shared build  &&  pnpm demo:run base-sepolia',
  )
}
