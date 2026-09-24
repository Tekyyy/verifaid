#!/usr/bin/env node
/**
 * A full dress rehearsal of the Base mainnet deployment, on a local fork of Base mainnet. It costs nothing and
 * touches nothing real, and it runs against the real dependencies the release will use: Circle's USDC and EURC,
 * Uniswap v3's pools, Chainlink's feeds, the EAS predeploy and Safe's factory.
 *
 *   1. forks Base mainnet with anvil (port 8546);
 *   2. runs scripts/deploy-mainnet.mjs against the fork, exactly as it would run for real: a 2-of-3 Safe of fresh
 *      owners, a two-day timelock and a separate guardian;
 *   3. does the first admin work the real admin would, through the timelock: schedules the demo NGO, verifiers,
 *      suppliers and keeper from the Safe, checks that executing early is refused, lets two days pass, executes;
 *   4. gives the demo wallets real USDC, EURC and ETH on the fork, and runs the demo scenarios through it;
 *   5. checks the guardian can pause at once;
 *   6. cleans up: the fork's deployment record and broadcast logs move to deployments/rehearsal/ (git-ignored), so
 *      nothing of it can be mistaken for a mainnet deployment, and the shared bundle is rebuilt without it.
 *
 *   pnpm rehearse:mainnet                      everything
 *   pnpm rehearse:mainnet onchain baskets      only these demo scenarios (conversion runs first when named)
 *
 * BASE_MAINNET_RPC_URL picks the node the fork reads from (default: Base's public endpoint).
 */
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const isWindows = process.platform === 'win32'
const require = createRequire(join(root, 'demo', 'package.json'))
const viem = require('viem')
const { mnemonicToAccount } = require('viem/accounts')
const { base } = require('viem/chains')

const PORT = 8546
const FORK_RPC = `http://127.0.0.1:${PORT}`
const UPSTREAM = process.env.BASE_MAINNET_RPC_URL?.trim() || 'https://mainnet.base.org'
const MNEMONIC = 'test test test test test test test test test test test junk'
const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const at = (index) => mnemonicToAccount(MNEMONIC, { addressIndex: index }).address
// The demo's parts (demo/src/config.ts), and four wallets no demo part uses: the Safe's owners and the guardian.
const ROLES = { ngo: 1, ngoPayout: 2, verifier1: 4, verifier2: 5, donor1: 7, donor2: 8, relayer: 9 }
const SUPPLIERS = [10, 11, 12]
const OWNERS = [16, 17, 18].map(at)
const GUARDIAN = at(19)
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const EURC = '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42'
const DELAY = 2 * 24 * 3600

const ALL_SCENARIOS = ['conversion', 'onchain', 'expiry', 'rejection', 'beneficiary', 'baskets']
const requested = process.argv.slice(2).filter((arg) => ALL_SCENARIOS.includes(arg))
const scenarios = requested.length > 0 ? requested : ALL_SCENARIOS

const step = (title) => console.log(`\n━━ ${title}`)
const fail = (message) => {
  throw new Error(message)
}

const deploymentFile = join(root, 'deployments', 'base.json')
const broadcastDirs = () =>
  readdirSync(join(root, 'contracts', 'broadcast'))
    .map((script) => join(root, 'contracts', 'broadcast', script, '8453'))
    .filter((dir) => existsSync(dir))
if (existsSync(deploymentFile)) {
  console.error(
    'deployments/base.json exists: a real mainnet deployment is recorded here. Not rehearsing over it.',
  )
  process.exit(1)
}
if (broadcastDirs().length > 0) {
  console.error('contracts/broadcast/*/8453 exists: move those records aside before rehearsing.')
  process.exit(1)
}

const run = (command, args, env = {}) => {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    shell: isWindows,
  })
  if (result.status !== 0) fail(`${command} ${args.join(' ')} failed`)
}

const transport = viem.http(FORK_RPC)
const client = viem.createPublicClient({ chain: base, transport })
const rpc = (method, params = []) => client.request({ method, params })
const walletFor = (address) => viem.createWalletClient({ account: address, chain: base, transport })
const send = async (from, request) => {
  const hash = await walletFor(from).writeContract(request)
  const receipt = await client.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') fail(`${request.functionName} reverted`)
  return receipt
}

let anvil
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
let ok = false

try {
  // ── 1. the fork ────────────────────────────────────────────────────────────
  step(`Forking Base mainnet from ${UPSTREAM}`)
  anvil = spawn('anvil', ['--fork-url', UPSTREAM, '--port', String(PORT), '--silent'], {
    stdio: 'ignore',
    shell: isWindows,
  })
  for (let tries = 0; ; tries++) {
    try {
      const id = Number(await rpc('eth_chainId'))
      console.log(`  chain ${id}, forked at block ${await client.getBlockNumber()}`)
      if (id !== 8453) fail(`the fork reports chain ${id}`)
      break
    } catch (error) {
      if (tries > 60) throw error
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
  for (let index = 0; index < 20; index++) {
    await rpc('anvil_setBalance', [at(index), viem.toHex(viem.parseEther('100'))])
  }

  // ── 2. the deployment, as it would run for real ───────────────────────────
  step('Deploying with scripts/deploy-mainnet.mjs')
  run('node', ['scripts/deploy-mainnet.mjs', '--fork', FORK_RPC, '--yes'], {
    DEPLOYER_PRIVATE_KEY: ANVIL_KEY,
    ADMIN_SAFE_OWNERS: OWNERS.join(','),
    ADMIN_SAFE_THRESHOLD: '2',
    ADMIN_TIMELOCK_DELAY: String(DELAY),
    GUARDIAN_ADDRESS: GUARDIAN,
    ADMIN_SAFE_ADDRESS: '',
    EXTRA_NGOS: '',
  })
  const deployment = JSON.parse(readFileSync(deploymentFile, 'utf8'))
  const { contracts, governance } = deployment

  step('Checking governance')
  const timelockAbi = viem.parseAbi([
    'function getMinDelay() view returns (uint256)',
    'function scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay)',
    'function executeBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt) payable',
  ])
  const safeAbi = viem.parseAbi([
    'function getOwners() view returns (address[])',
    'function getThreshold() view returns (uint256)',
  ])
  const rolesAbi = viem.parseAbi([
    'function isAdmin(address) view returns (bool)',
    'function hasRole(bytes32 role, address account) view returns (bool)',
    'function GUARDIAN_ROLE() view returns (bytes32)',
    'function registerNgo(address ngo, address payout, bytes32 credentialHash, string metadataURI)',
    'function registerVerifier(address verifier)',
    'function registerSupplier(address supplier, bytes32 credentialHash, string metadataURI)',
    'function pause()',
    'function paused() view returns (bool)',
  ])
  const read = (address, abi, functionName, args = []) =>
    client.readContract({ address, abi, functionName, args })
  const minDelay = await read(governance.Timelock, timelockAbi, 'getMinDelay')
  const safeOwners = await read(governance.Safe, safeAbi, 'getOwners')
  const threshold = await read(governance.Safe, safeAbi, 'getThreshold')
  const deployerIsAdmin = await read(contracts.RoleRegistry, rolesAbi, 'isAdmin', [at(0)])
  const timelockIsAdmin = await read(contracts.RoleRegistry, rolesAbi, 'isAdmin', [governance.Timelock])
  const guardianRole = await read(contracts.RoleRegistry, rolesAbi, 'GUARDIAN_ROLE')
  const guardianOk = await read(contracts.RoleRegistry, rolesAbi, 'hasRole', [guardianRole, GUARDIAN])
  console.log(
    `  timelock delay ${minDelay}s, Safe ${threshold}-of-${safeOwners.length}, guardian ${guardianOk}`,
  )
  console.log(`  admin: timelock ${timelockIsAdmin}, deployer ${deployerIsAdmin}`)
  if (minDelay !== BigInt(DELAY) || threshold !== 2n || safeOwners.length !== 3)
    fail('governance is not what was asked')
  if (!timelockIsAdmin || deployerIsAdmin || !guardianOk)
    fail('the handover did not take the admin role away')

  // ── 3. the first admin work, through the timelock ─────────────────────────
  step('Registering the demo organisations through the Safe and the two-day timelock')
  const calls = [
    [
      contracts.RoleRegistry,
      'registerNgo',
      [
        at(ROLES.ngo),
        at(ROLES.ngoPayout),
        viem.keccak256(viem.toHex('rehearsal-ngo')),
        'ipfs://rehearsal-ngo',
      ],
    ],
    [contracts.RoleRegistry, 'registerVerifier', [at(ROLES.verifier1)]],
    [contracts.RoleRegistry, 'registerVerifier', [at(ROLES.verifier2)]],
    ...SUPPLIERS.map((index) => [
      contracts.RoleRegistry,
      'registerSupplier',
      [
        at(index),
        viem.keccak256(viem.toHex(`rehearsal-supplier-${index}`)),
        `ipfs://rehearsal-supplier-${index}`,
      ],
    ]),
  ]
  const keeperAbi = viem.parseAbi(['function setKeeper(address keeper, bool active)'])
  const targets = [...calls.map(([target]) => target), contracts.DonationForwarderFactory]
  const payloads = [
    ...calls.map(([, functionName, args]) => viem.encodeFunctionData({ abi: rolesAbi, functionName, args })),
    viem.encodeFunctionData({ abi: keeperAbi, functionName: 'setKeeper', args: [at(ROLES.relayer), true] }),
  ]
  const values = targets.map(() => 0n)
  const salt = viem.keccak256(viem.toHex(`rehearsal-${stamp}`))
  const zero = `0x${'00'.repeat(32)}`
  // The Safe's owners would sign this in the Safe app; on the fork the Safe itself is impersonated.
  await rpc('anvil_impersonateAccount', [governance.Safe])
  await rpc('anvil_setBalance', [governance.Safe, viem.toHex(viem.parseEther('1'))])
  await send(governance.Safe, {
    address: governance.Timelock,
    abi: timelockAbi,
    functionName: 'scheduleBatch',
    args: [targets, values, payloads, zero, salt, BigInt(DELAY)],
  })
  console.log(`  scheduled ${targets.length} calls`)
  let early = false
  try {
    await send(at(3), {
      address: governance.Timelock,
      abi: timelockAbi,
      functionName: 'executeBatch',
      args: [targets, values, payloads, zero, salt],
    })
    early = true
  } catch {
    console.log('  executing before the delay is refused ✓')
  }
  if (early) fail('the timelock executed before its delay')
  await rpc('evm_increaseTime', [DELAY + 1])
  await rpc('evm_mine', [])
  await send(at(3), {
    address: governance.Timelock,
    abi: timelockAbi,
    functionName: 'executeBatch',
    args: [targets, values, payloads, zero, salt],
  })
  console.log('  two days later: executed by an ordinary account ✓')

  // The fork's clock just moved two days, and a fork's Chainlink feeds never update, so every price would now be
  // refused as stale. On mainnet they keep updating; here each feed's code is swapped for a settable one that
  // republishes its own last real answer at the fork's current time.
  step('Keeping the Chainlink feeds live on the fork')
  const feedAbi = viem.parseAbi([
    'function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)',
    'function updateRoundData(int256 answer, uint256 startedAt, uint256 updatedAt)',
  ])
  const mockFeed = JSON.parse(
    readFileSync(join(root, 'contracts', 'out', 'MockV3Aggregator.sol', 'MockV3Aggregator.json'), 'utf8'),
  )
  const { external } = deployment
  const now = (await client.getBlock()).timestamp
  for (const [name, feed] of [
    ['EUR / USD', external.EurUsdFeed],
    ['USDC / USD', external.UsdcUsdFeed],
    ['ETH / USD', external.EthUsdFeed],
  ]) {
    const [, answer] = await read(feed, feedAbi, 'latestRoundData')
    const hash = await walletFor(at(3)).deployContract({
      abi: mockFeed.abi,
      bytecode: mockFeed.bytecode.object,
      args: [8, answer, name],
    })
    const { contractAddress } = await client.waitForTransactionReceipt({ hash })
    await rpc('anvil_setCode', [feed, await client.getCode({ address: contractAddress })])
    await send(at(3), { address: feed, abi: feedAbi, functionName: 'updateRoundData', args: [answer, now, now] })
    console.log(`  ${name.padEnd(10)} ${answer} (its last real answer), current again`)
  }

  step('The NGO sets up its programme')
  const programsAbi = viem.parseAbi([
    'function createProgram(bytes32 eligibilityHash, string uri) returns (uint256)',
  ])
  await send(at(ROLES.ngo), {
    address: contracts.ProgramRegistry,
    abi: programsAbi,
    functionName: 'createProgram',
    args: [viem.keccak256(viem.toHex('rehearsal-eligibility')), 'ipfs://rehearsal-program'],
  })

  // ── 4. real tokens for the demo wallets ───────────────────────────────────
  step('Giving the demo wallets real USDC and EURC on the fork')
  // Circle's tokens pack each balance with a blacklist flag, so anvil cannot find the slot to set. They are minted
  // the way Circle mints them instead: their master minter, impersonated, authorises a minter, which mints.
  const fiatTokenAbi = viem.parseAbi([
    'function balanceOf(address) view returns (uint256)',
    'function masterMinter() view returns (address)',
    'function configureMinter(address minter, uint256 minterAllowedAmount) returns (bool)',
    'function mint(address to, uint256 amount) returns (bool)',
  ])
  const minter = at(3)
  const authorised = new Set()
  const deal = async (token, to, amount) => {
    if (!authorised.has(token)) {
      const master = await read(token, fiatTokenAbi, 'masterMinter')
      await rpc('anvil_impersonateAccount', [master])
      await rpc('anvil_setBalance', [master, viem.toHex(viem.parseEther('1'))])
      await send(master, {
        address: token,
        abi: fiatTokenAbi,
        functionName: 'configureMinter',
        args: [minter, 10n ** 15n],
      })
      authorised.add(token)
    }
    await send(minter, { address: token, abi: fiatTokenAbi, functionName: 'mint', args: [to, amount] })
    const balance = await read(token, fiatTokenAbi, 'balanceOf', [to])
    if (balance < amount) fail(`could not give ${to} tokens of ${token}`)
  }
  for (const role of ['donor1', 'donor2']) {
    await deal(USDC, at(ROLES[role]), 100_000n * 10n ** 6n)
    await deal(EURC, at(ROLES[role]), 20_000n * 10n ** 6n)
  }
  await deal(USDC, at(ROLES.ngo), 1_000n * 10n ** 6n)
  console.log('  donors: 100,000 USDC and 20,000 EURC each; the NGO: 1,000 USDC for reward pots')

  // ── 5. the demo, through real USDC, Uniswap, Chainlink and EAS ────────────
  step('Building the shared bundle with the fork deployment')
  run('node', ['scripts/sync-deployments.mjs'])
  run('pnpm', ['--filter', '@poa/shared', 'build'])
  const demoEnv = { DEMO_FORK: '1', DEMO_RPC_URL: FORK_RPC, DEMO_MNEMONIC: '', DEPLOYER_PRIVATE_KEY: '' }
  // Conversions first and on their own: later scenarios move the clock, and real Chainlink feeds do not follow a
  // fork's clock, so their prices would be refused as stale.
  const runs = []
  if (scenarios.includes('conversion')) runs.push(['conversion'])
  const rest = scenarios.filter((name) => name !== 'conversion')
  if (rest.length > 0) runs.push(rest)
  for (const names of runs) {
    step(`Demo: ${names.join(', ')}`)
    run('pnpm', ['demo:run', 'base', ...names], demoEnv)
  }

  // ── 6. the guardian ───────────────────────────────────────────────────────
  step('The guardian pauses at once')
  // anvil unlocks only its first ten accounts; the guardian is the twentieth.
  await rpc('anvil_impersonateAccount', [GUARDIAN])
  await send(GUARDIAN, { address: contracts.RoleRegistry, abi: rolesAbi, functionName: 'pause' })
  if (!(await read(contracts.RoleRegistry, rolesAbi, 'paused'))) fail('pause did not take')
  console.log('  paused ✓ (unpausing is an admin action, through the timelock)')

  ok = true
} catch (error) {
  console.error(`\n✗ Rehearsal failed: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  // ── cleanup: nothing of the fork may look like a mainnet deployment ────────
  anvil?.kill()
  if (isWindows && anvil?.pid)
    spawnSync('taskkill', ['/pid', String(anvil.pid), '/t', '/f'], { stdio: 'ignore' })
  const keep = join(root, 'deployments', 'rehearsal', stamp)
  mkdirSync(keep, { recursive: true })
  if (existsSync(deploymentFile)) renameSync(deploymentFile, join(keep, 'base.json'))
  for (const dir of broadcastDirs()) {
    const script = dirname(dir).split(/[\\/]/).at(-1)
    cpSync(dir, join(keep, 'broadcast', script), { recursive: true })
    rmSync(dir, { recursive: true, force: true })
  }
  spawnSync('node', ['scripts/sync-deployments.mjs'], { cwd: root, stdio: 'ignore', shell: isWindows })
  spawnSync('pnpm', ['--filter', '@poa/shared', 'build'], { cwd: root, stdio: 'ignore', shell: isWindows })
  console.log(
    `\n${ok ? '✓ Rehearsal passed' : '✗ Rehearsal did not pass'}. Its records are in deployments/rehearsal/${stamp}/.\n`,
  )
  process.exit(ok ? 0 : 1)
}
