#!/usr/bin/env node
/**
 * Deploys VerifAid to Base mainnet:
 *   Deploy → RegisterSchemas → RegisterCommunitySchemas → RegisterNgos (EXTRA_NGOS)
 *   → RegisterRoles (EXTRA_VERIFIERS, EXTRA_SUPPLIERS, KEEPERS) → Handover
 *
 * No demo needs, no mocks, no test liquidity: SystemDeployer refuses to deploy a mock anywhere but anvil and Base
 * Sepolia, and this script never runs the seeding steps.
 *
 *   pnpm deploy:mainnet                     checks everything and prints the plan; deploys nothing
 *   pnpm deploy:mainnet --yes               deploys, with source verification on Basescan
 *   pnpm deploy:mainnet --fork <rpc> --yes  the same against a local fork of Base mainnet (rehearse-mainnet.mjs)
 *
 * Secrets and settings come from `.env.mainnet` at the repo root (git-ignored, like every .env.* file) and the shell
 * (with --fork, from the shell only),
 * never from the testnet `.env`: real money needs keys that were never in git. The script refuses to go on if the
 * deployer is the testnet deployer, if the Safe owners are not independent of it, if the timelock is shorter than
 * ten minutes or if there is no separate guardian. The private key is never printed and never put on a command line.
 *
 * The timelock defaults to ten minutes, the hackathon setting: admin changes (a new NGO or verifier) land the same
 * day. A deployment that handles serious money should set ADMIN_TIMELOCK_DELAY=172800 (two days), so donors can see
 * a change coming and leave before it applies.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const contracts = join(root, 'contracts')
const isWindows = process.platform === 'win32'
const require = createRequire(join(root, 'demo', 'package.json'))
const { privateKeyToAccount } = require('viem/accounts')
const { getAddress, isAddress } = require('viem')

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}
const forkRpc = option('--fork')
const fork = Boolean(forkRpc)
const confirmed = flag('--yes')

const fail = (message) => {
  console.error(`\n✗ ${message}\n`)
  process.exit(1)
}

const parseEnvFile = (path) => {
  if (!existsSync(path)) return {}
  const out = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (match) out[match[1]] = match[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}
const nonEmpty = (record) => Object.fromEntries(Object.entries(record).filter(([, value]) => value?.trim?.()))

/**
 * Base mainnet dependencies, each checked on chain on 2026-09-25 (symbol, description, router factory, pool depth).
 * Anything set in .env.mainnet or the shell wins over these.
 */
const BASE_MAINNET = {
  STABLECOIN_ADDRESS: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Circle USDC: the vault currency
  USDC_ADDRESS: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  EURC_ADDRESS: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42', // Circle EURC: converted on the way in
  WETH_ADDRESS: '0x4200000000000000000000000000000000000006',
  SWAP_ROUTER_ADDRESS: '0x2626664c2603336E57B271c5C0b26F421741e481', // Uniswap v3 SwapRouter02
  EUR_USD_FEED: '0xc91D87E81faB8f93699ECf7Ee9B44D11e1D53F0F', // Chainlink EUR / USD
  USDC_USD_FEED: '0x7e860098F58bBFC8648a4311b374B1D669a2bc6B', // Chainlink USDC / USD
  ETH_USD_FEED: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70', // Chainlink ETH / USD
  SEQUENCER_UPTIME_FEED: '0xBCF85224fc0756B9Fa45aA7892530B47e10b6433', // Chainlink L2 sequencer uptime
  EAS_ADDRESS: '0x4200000000000000000000000000000000000021', // OP Stack predeploys
  SCHEMA_REGISTRY_ADDRESS: '0x4200000000000000000000000000000000000020',
  // EURC ↔ USDC: the 0.05% pool is the deepest on Base (≈ 20k USDC + 46k EURC when checked). WETH ↔ USDC 0.05%.
  USDC_POOL_FEE: '500',
  WETH_POOL_FEE: '500',
  ETH_ROUTE: 'true',
  MAX_SLIPPAGE_BPS: '100',
  ETH_MAX_SLIPPAGE_BPS: '150',
  // Chainlink's own heartbeats on Base, with room: USDC/USD and EUR/USD daily (EUR pauses over forex weekends), ETH/USD
  // every 20 minutes.
  USDC_USD_HEARTBEAT: String(24 * 3600 + 3600),
  EUR_USD_HEARTBEAT: String(3 * 24 * 3600),
  ETH_USD_HEARTBEAT: String(3600),
  DASHBOARD_BASE_URI: 'https://www.verifaid.org/needs/',
  ADMIN_TIMELOCK_DELAY: String(10 * 60),
  ADMIN_SAFE_THRESHOLD: '2',
}

const settingsFile = join(root, '.env.mainnet')
// A rehearsal on a fork takes its settings from the shell only, so it can never pick up the real Safe or keys.
const fileSettings = fork ? {} : parseEnvFile(settingsFile)
const env = { ...BASE_MAINNET, ...nonEmpty(fileSettings), ...nonEmpty(process.env) }
// The testnet's settings must not leak in through the shell either.
for (const name of ['DEMO_MNEMONIC', 'YIELD_VENUE_ADDRESS']) if (!fileSettings[name]) delete env[name]
const rpcUrl = forkRpc ?? env.BASE_MAINNET_RPC_URL?.trim() ?? 'https://mainnet.base.org'

// ── checks ──────────────────────────────────────────────────────────────────

const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const key = env.DEPLOYER_PRIVATE_KEY?.trim()
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
  fail(`DEPLOYER_PRIVATE_KEY is missing or malformed. Put a fresh key in ${settingsFile} (never in git).`)
}
const deployer = privateKeyToAccount(key).address
const testnetKey = parseEnvFile(join(root, '.env')).DEPLOYER_PRIVATE_KEY
if (
  testnetKey &&
  /^0x[0-9a-fA-F]{64}$/.test(testnetKey) &&
  privateKeyToAccount(testnetKey).address === deployer
) {
  fail('The deployer is the testnet deployer, whose key has been in git. Use a key that never was.')
}
if (!fork && key.toLowerCase() === ANVIL_KEY) fail('That is anvil’s public development key.')

const addressList = (value) =>
  (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
const owners = addressList(env.ADMIN_SAFE_OWNERS)
const existingSafe = env.ADMIN_SAFE_ADDRESS?.trim()
if (existingSafe) {
  if (!isAddress(existingSafe)) fail('ADMIN_SAFE_ADDRESS is not an address.')
} else {
  if (owners.length < 3) fail('ADMIN_SAFE_OWNERS needs at least three owners, each with a key of their own.')
  if (owners.some((owner) => !isAddress(owner)))
    fail('ADMIN_SAFE_OWNERS holds something that is not an address.')
  if (new Set(owners.map((owner) => owner.toLowerCase())).size !== owners.length)
    fail('ADMIN_SAFE_OWNERS repeats an owner.')
  if (owners.some((owner) => getAddress(owner) === deployer)) {
    fail('The deployer is one of the Safe owners: the owners must be independent of the key that deploys.')
  }
  const threshold = Number(env.ADMIN_SAFE_THRESHOLD)
  if (!Number.isInteger(threshold) || threshold < 2 || threshold > owners.length) {
    fail('ADMIN_SAFE_THRESHOLD must be at least 2 and at most the number of owners.')
  }
}
const guardian = env.GUARDIAN_ADDRESS?.trim()
if (!guardian || !isAddress(guardian))
  fail('GUARDIAN_ADDRESS (the key that may pause, and only pause) is required.')
if (getAddress(guardian) === deployer)
  fail('The guardian must not be the deployer: after the handover it keeps nothing.')
const delay = Number(env.ADMIN_TIMELOCK_DELAY)
if (!Number.isInteger(delay) || delay < 10 * 60)
  fail('ADMIN_TIMELOCK_DELAY must be at least ten minutes (600).')
const verify = !fork && Boolean(env.BASESCAN_API_KEY?.trim())
if (!fork && !verify)
  fail('BASESCAN_API_KEY is required: every contract is source-verified as it is deployed.')
if (verify) env.ETHERSCAN_API_KEY = env.BASESCAN_API_KEY
// Registered before the handover, so a launch does not wait out the timelock for its first verifier.
const roleLists = {
  EXTRA_NGOS: addressList(env.EXTRA_NGOS),
  EXTRA_VERIFIERS: addressList(env.EXTRA_VERIFIERS),
  EXTRA_SUPPLIERS: addressList(env.EXTRA_SUPPLIERS),
  KEEPERS: addressList(env.KEEPERS),
}
for (const [name, list] of Object.entries(roleLists))
  for (const address of list) if (!isAddress(address)) fail(`${name}: ${address} is not an address.`)
// One address, one role: RoleRegistry would revert halfway through the registrations, after the deployment.
const holder = new Map()
for (const name of ['EXTRA_NGOS', 'EXTRA_VERIFIERS', 'EXTRA_SUPPLIERS'])
  for (const address of roleLists[name]) {
    const seen = holder.get(getAddress(address))
    if (seen) fail(`${address} is in both ${seen} and ${name}: an address may hold one role only.`)
    holder.set(getAddress(address), name)
  }
const needsRoles = roleLists.EXTRA_VERIFIERS.length + roleLists.EXTRA_SUPPLIERS.length + roleLists.KEEPERS.length > 0
if (existsSync(join(root, 'deployments', 'base.json'))) {
  fail(
    'deployments/base.json exists: Base mainnet is already deployed. Archive it first if this is a new release.',
  )
}

const rpc = async (method, params = []) => {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = await response.json()
  if (body.error) throw new Error(body.error.message)
  return body.result
}
const chainId = Number(await rpc('eth_chainId'))
if (chainId !== 8453) fail(`The RPC is chain ${chainId}, not Base mainnet (8453).`)
const balance = BigInt(await rpc('eth_getBalance', [deployer, 'latest']))

// ── plan ────────────────────────────────────────────────────────────────────

const eth = (wei) => (Number(wei) / 1e18).toFixed(5)
console.log(`\nVerifAid → Base mainnet${fork ? ' (LOCAL FORK)' : ''}`)
console.log(`  rpc                ${rpcUrl}`)
console.log(`  deployer           ${deployer}  (${eth(balance)} ETH)`)
console.log(`  vault currency     USDC ${env.STABLECOIN_ADDRESS}`)
console.log(`  conversions        EURC and ETH through Uniswap v3, bounded by Chainlink; sequencer feed on`)
console.log(`  receipts link to   ${env.DASHBOARD_BASE_URI}`)
console.log(
  `  donors             ${Number(env.DONOR_APPROVAL_BPS ?? 3000) / 100}% approve, ${Number(env.DONOR_REJECTION_BPS ?? 5000) / 100}% reject`,
)
console.log(`  idle capital       ${env.YIELD_VENUE_ADDRESS ? env.YIELD_VENUE_ADDRESS : 'off (no venue)'}`)
console.log(
  `  admin after        ${existingSafe ? `the Safe ${existingSafe}` : `a ${env.ADMIN_SAFE_THRESHOLD}-of-${owners.length} Safe: ${owners.join(', ')}`}`,
)
const delayText = delay % 3600 === 0 ? `${delay / 3600} hours` : `${Math.round(delay / 60)} minutes`
console.log(`                     through a timelock of ${delayText}; guardian ${guardian}`)
const listed = (list) => list.join(', ') || 'none now (the admin registers them later)'
console.log(`  NGOs registered    ${listed(roleLists.EXTRA_NGOS)}`)
console.log(`  verifiers          ${listed(roleLists.EXTRA_VERIFIERS)}`)
console.log(`  suppliers          ${listed(roleLists.EXTRA_SUPPLIERS)}`)
console.log(`  keepers            ${listed(roleLists.KEEPERS)}`)
if (roleLists.EXTRA_VERIFIERS.length === 0)
  console.warn('\n  ⚠ No verifier: no need can be verified, so none can take money, until the Safe registers one.')
console.log(`  verification       ${verify ? 'Basescan' : 'none (fork)'}`)
if (balance < 3n * 10n ** 15n)
  console.warn('\n  ⚠ Less than 0.003 ETH: enough at today’s gas prices, not on a busy day.')

if (!confirmed) {
  console.log('\nChecks passed. Nothing was deployed. Re-run with --yes to deploy.\n')
  process.exit(0)
}

// ── deploy ──────────────────────────────────────────────────────────────────

const run = (script, extra = []) => {
  console.log(`\n▸ ${script}`)
  const result = spawnSync(
    'forge',
    ['script', `script/${script}`, '--rpc-url', rpcUrl, '--broadcast', '--slow', ...extra],
    {
      cwd: contracts,
      env,
      stdio: 'inherit',
      shell: isWindows,
    },
  )
  if (result.status !== 0) fail(`${script} failed. Nothing after it ran; see the output above.`)
}

run('Deploy.s.sol', verify ? ['--verify'] : [])
run('RegisterSchemas.s.sol')
run('RegisterCommunitySchemas.s.sol')
if (roleLists.EXTRA_NGOS.length > 0) run('RegisterNgos.s.sol')
if (needsRoles) run('RegisterRoles.s.sol')
run('Handover.s.sol')

const deployment = JSON.parse(readFileSync(join(root, 'deployments', 'base.json'), 'utf8'))
console.log('\n✓ Deployed to Base mainnet\n')
for (const [name, address] of Object.entries(deployment.contracts))
  console.log(`  ${name.padEnd(32)} ${address}`)
console.log(`\n  admin (timelock)  ${deployment.governance?.Timelock}`)
console.log(`  Safe              ${deployment.governance?.Safe}`)
console.log(`  start block       ${deployment.startBlock}`)
if (!fork) {
  console.log(
    '\n  Next: verify the timelock on Basescan (see docs/MAINNET.md), commit deployments/base.json and the',
  )
  console.log('  contracts/broadcast/*/8453 records, then point a mainnet indexer and the site at it.')
}
