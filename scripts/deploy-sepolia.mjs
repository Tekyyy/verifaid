#!/usr/bin/env node
/**
 * Deploys the whole system to Base Sepolia and seeds the demo data:
 *   Deploy.s.sol → RegisterSchemas.s.sol → SeedDemo.s.sol → VerifyDemoNeeds.s.sol → SeedLiquidity.s.sol
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
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
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

/**
 * The conversion path on Base Sepolia: Uniswap v3's own SwapRouter02, WETH and Chainlink's USDC/USD and ETH/USD
 * feeds. What Base Sepolia lacks is mocked by Deploy.s.sol: EUR/USD (no feed there, so a fixed mock whose answer
 * must not go stale — hence the one-year heartbeat), a MockUSDC for the vaults to hold (the mock on-ramp mints it),
 * a MockEURC for donations that have to be converted, and their pool, which SeedLiquidity.s.sol creates on Uniswap
 * at the oracle price. USDC donations need no pool at all: the vaults hold USDC, so nothing is swapped. No
 * sequencer uptime feed exists on testnets, and ETH donations stay off: there is no WETH liquidity against our
 * mocks.
 * Anything set in .env or the shell wins over these.
 */
const BASE_SEPOLIA_CONVERSION = {
  SWAP_ROUTER_ADDRESS: '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4',
  WETH_ADDRESS: '0x4200000000000000000000000000000000000006',
  USDC_USD_FEED: '0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165',
  ETH_USD_FEED: '0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1',
  EUR_USD_HEARTBEAT: String(365 * 24 * 3600),
  USDC_POOL_FEE: '100',
  ETH_ROUTE: 'false',
  MAX_SLIPPAGE_BPS: '100',
}

const nonEmpty = (record) => Object.fromEntries(Object.entries(record).filter(([, value]) => value?.trim?.()))
const env = { ...BASE_SEPOLIA_CONVERSION, ...nonEmpty(fileEnv), ...nonEmpty(process.env) }

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
console.log(
  '  cost             ~0.0005 ETH to deploy, plus up to 0.0035 ETH to top the demo role wallets up\n',
)

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

const deployment = join(root, 'deployments', 'base-sepolia.json')

// A new release gets new addresses. Keep the previous record, so links into the old deployment keep resolving.
if (wanted('deploy') && existsSync(deployment)) {
  const previous = JSON.parse(readFileSync(deployment, 'utf8'))
  const archive = join(root, 'deployments', `base-sepolia.v${previous.version ?? 1}.json`)
  if (!existsSync(archive)) {
    copyFileSync(deployment, archive)
    console.log(`  archived the previous deployment to deployments/${basename(archive)}`)
  }
}

if (wanted('deploy')) run('Deploy.s.sol', verify ? ['--verify'] : [])
if (wanted('schemas')) run('RegisterSchemas.s.sol')
if (wanted('seed')) run('SeedDemo.s.sol')
// Seeding registers the needs; this is what opens them for donations. Re-run alone: `pnpm deploy:sepolia verify`.
if (wanted('verify')) run('VerifyDemoNeeds.s.sol')
// Also a keeper: re-run `pnpm deploy:sepolia liquidity` to put the pool back at the oracle price.
if (wanted('liquidity')) run('SeedLiquidity.s.sol')

// The app's server cache outlives restarts, and its first render after one would show the previous release's needs.
if (wanted('deploy'))
  rmSync(join(root, 'app', '.next', 'cache', 'fetch-cache'), { recursive: true, force: true })

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
  console.log('         restart the indexer with indexer/.ponder/pglite deleted, and restart the app')
}
