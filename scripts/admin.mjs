#!/usr/bin/env node
/**
 * Admin actions after the handover. The admin is a TimelockController whose only proposer is a Safe multisig, so
 * every admin action takes two steps:
 *
 *   1. schedule — the Safe's owners sign `timelock.schedule(call)`, and the Safe sends it;
 *   2. execute  — once the delay has passed, anyone sends `timelock.execute(call)`.
 *
 * This script signs with the two owner keys it has (the deployer and demo account #6, the "council"), which is a
 * 2-of-3 threshold on the testnet. The third owner can also sign in the Safe app instead. It never prints a key.
 *
 *   pnpm admin base-sepolia status
 *   pnpm admin base-sepolia run RoleRegistry "registerNgo(address,address,bytes32,string)" 0xNGO 0xNGO 0x…32 ipfs://ngo
 *   pnpm admin base-sepolia schedule RoleRegistry "registerVerifier(address)" 0xVERIFIER
 *   pnpm admin base-sepolia execute  RoleRegistry "registerVerifier(address)" 0xVERIFIER --salt 0x…
 *   pnpm admin base-sepolia register-ngo 0xNGO            # shortcut: pays out to itself
 *   pnpm admin base-sepolia pause                         # the guardian, at once, no timelock
 *
 * `run` schedules, waits out the delay and executes. On anvil (`pnpm deploy:local --handover`) the proposer is an
 * ordinary account standing in for the Safe, and the script schedules from it directly.
 *
 * On Base mainnet no owner key is on this machine: each owner signs in the Safe app. `prepare` writes the two
 * transactions as Safe Transaction Builder files — schedule now, execute once the delay is over — to import there:
 *
 *   pnpm admin base status
 *   pnpm admin base prepare RoleRegistry "registerVerifier(address)" 0xVERIFIER
 *   pnpm admin base execute RoleRegistry "registerVerifier(address)" 0xVERIFIER --salt 0x…   # any funded key
 *
 * Its settings (BASE_MAINNET_RPC_URL, and DEPLOYER_PRIVATE_KEY or GUARDIAN_PRIVATE_KEY for the steps that need a
 * sender) come from .env.mainnet, never from the testnet .env.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// viem lives in the workspace packages, not at the root.
const require = createRequire(join(root, 'demo', 'package.json'))
const viem = require('viem')
const { privateKeyToAccount, mnemonicToAccount } = require('viem/accounts')
const { base, baseSepolia, foundry } = require('viem/chains')

const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk'
const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

const parseEnvFile = (path) => {
  if (!existsSync(path)) return {}
  const out = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (match) out[match[1]] = match[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}

const fail = (message) => {
  console.error(`\n✗ ${message}`)
  process.exit(1)
}

const [network = 'base-sepolia', command = 'status', ...rest] = process.argv.slice(2)
if (network !== 'base-sepolia' && network !== 'anvil' && network !== 'base') {
  fail(`unknown network "${network}" (base, base-sepolia or anvil)`)
}
const local = network === 'anvil'
const mainnet = network === 'base'
const env = { ...parseEnvFile(join(root, mainnet ? '.env.mainnet' : '.env')), ...process.env }
const deploymentPath = join(root, 'deployments', `${network}.json`)
if (!existsSync(deploymentPath)) fail(`no deployments/${network}.json`)
const deployment = JSON.parse(readFileSync(deploymentPath, 'utf8'))
const governance = deployment.governance ?? {}
if (!governance.Timelock || /^0x0{40}$/i.test(governance.Timelock)) {
  fail('this deployment was never handed over: the deployer is still the admin (run Handover.s.sol).')
}

const chain = local ? foundry : mainnet ? base : baseSepolia
const rpcUrl = local
  ? (env.ANVIL_RPC_URL ?? 'http://127.0.0.1:8545')
  : mainnet
    ? env.BASE_MAINNET_RPC_URL || 'https://mainnet.base.org'
    : env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org'
const transport = viem.http(rpcUrl)
const client = viem.createPublicClient({ chain, transport })
const keyOf = (value) =>
  value && /^0x[0-9a-fA-F]{64}$/.test(value.trim()) ? privateKeyToAccount(value.trim()) : null
/** Pays for the steps anyone may take (execute). On mainnet it owns nothing: it is only a sender. */
const deployer = local ? privateKeyToAccount(ANVIL_KEY) : keyOf(env.DEPLOYER_PRIVATE_KEY)
/** The testnet's second Safe owner; mainnet owners sign in the Safe app instead. */
const council = mainnet
  ? null
  : mnemonicToAccount(local ? ANVIL_MNEMONIC : env.DEMO_MNEMONIC, { addressIndex: 6 })
const guardianKey = mainnet ? keyOf(env.GUARDIAN_PRIVATE_KEY) : deployer
const requireSender = (account, what) =>
  account ??
  fail(`${what} needs a funded key: set it in ${mainnet ? '.env.mainnet' : '.env'} (it is never printed).`)
const walletOf = (account) => viem.createWalletClient({ account, chain, transport })

const timelockAbi = viem.parseAbi([
  'function getMinDelay() view returns (uint256)',
  'function hashOperation(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt) view returns (bytes32)',
  'function isOperationReady(bytes32 id) view returns (bool)',
  'function isOperationDone(bytes32 id) view returns (bool)',
  'function getTimestamp(bytes32 id) view returns (uint256)',
  'function schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)',
  'function execute(address target, uint256 value, bytes payload, bytes32 predecessor, bytes32 salt) payable',
])
const safeAbi = viem.parseAbi([
  'function nonce() view returns (uint256)',
  'function getThreshold() view returns (uint256)',
  'function getOwners() view returns (address[])',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
])
const rolesAbi = viem.parseAbi(['function pause()', 'function paused() view returns (bool)'])

const ZERO = viem.zeroAddress
const ZERO_HASH = viem.zeroHash
const explorer = (hash) =>
  local ? hash : mainnet ? `https://basescan.org/tx/${hash}` : `https://sepolia.basescan.org/tx/${hash}`

const waitFor = async (hash) => {
  const receipt = await client.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') fail(`transaction reverted: ${explorer(hash)}`)
  return receipt
}

/** `contract` is a name in the deployment ("RoleRegistry") or a 0x address; `signature` e.g. "pause()". */
const encodeCall = (contract, signature, args) => {
  const target = /^0x[0-9a-fA-F]{40}$/.test(contract) ? contract : deployment.contracts[contract]
  if (!target) fail(`no contract "${contract}" in deployments/${network}.json`)
  const item = viem.parseAbiItem(`function ${signature}`)
  const typed = item.inputs.map((input, i) => {
    const raw = args[i]
    if (raw === undefined) fail(`${signature} takes ${item.inputs.length} argument(s)`)
    if (/^u?int/.test(input.type)) return BigInt(raw)
    if (input.type === 'bool') return raw === 'true'
    return raw
  })
  return { target: viem.getAddress(target), data: viem.encodeFunctionData({ abi: [item], args: typed }) }
}

/** Has the Safe send `data` to `to`, signed by the two owner keys this script holds. */
const safeSend = async (to, data) => {
  if (mainnet)
    fail('on mainnet the Safe owners sign in the Safe app: use `prepare`, then import its files there.')
  const safe = governance.Safe
  if ((await client.getCode({ address: safe })) === undefined) {
    // Local: the proposer is a plain account standing in for the Safe.
    return waitFor(await walletOf(council).sendTransaction({ to, data }))
  }
  const [nonce, threshold, owners] = await Promise.all([
    client.readContract({ address: safe, abi: safeAbi, functionName: 'nonce' }),
    client.readContract({ address: safe, abi: safeAbi, functionName: 'getThreshold' }),
    client.readContract({ address: safe, abi: safeAbi, functionName: 'getOwners' }),
  ])
  const signers = [deployer, council].filter(
    (account) => account && owners.some((owner) => owner.toLowerCase() === account.address.toLowerCase()),
  )
  if (BigInt(signers.length) < threshold) {
    fail(`the Safe needs ${threshold} signatures and this script holds ${signers.length} owner key(s)`)
  }
  const txArgs = [to, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO]
  const hash = await client.readContract({
    address: safe,
    abi: safeAbi,
    functionName: 'getTransactionHash',
    args: [...txArgs, nonce],
  })
  // Safe wants the signatures ordered by owner address, each a plain ECDSA signature over the Safe tx hash.
  const ordered = [...signers].sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1))
  const signatures = viem.concat(await Promise.all(ordered.map((account) => account.sign({ hash }))))
  const sent = await walletOf(requireSender(deployer, 'Sending the Safe transaction')).writeContract({
    address: safe,
    abi: safeAbi,
    functionName: 'execTransaction',
    args: [...txArgs, signatures],
  })
  return waitFor(sent)
}

const schedule = async (target, data, salt) => {
  const delay = await client.readContract({
    address: governance.Timelock,
    abi: timelockAbi,
    functionName: 'getMinDelay',
  })
  const call = viem.encodeFunctionData({
    abi: timelockAbi,
    functionName: 'schedule',
    args: [target, 0n, data, ZERO_HASH, salt, delay],
  })
  const receipt = await safeSend(governance.Timelock, call)
  const id = await client.readContract({
    address: governance.Timelock,
    abi: timelockAbi,
    functionName: 'hashOperation',
    args: [target, 0n, data, ZERO_HASH, salt],
  })
  // A load-balanced public RPC can answer from a node that has not seen the schedule yet: wait until it has.
  let readyAt = 0n
  for (let attempt = 0; attempt < 30 && readyAt === 0n; attempt++) {
    readyAt = await client.readContract({
      address: governance.Timelock,
      abi: timelockAbi,
      functionName: 'getTimestamp',
      args: [id],
    })
    if (readyAt === 0n) await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  if (readyAt === 0n) fail(`scheduled, but the RPC does not show it yet; execute later with --salt ${salt}`)
  console.log(`  scheduled     ${explorer(receipt.transactionHash)}`)
  console.log(`  operation     ${id}`)
  console.log(`  salt          ${salt}`)
  console.log(`  executable at ${new Date(Number(readyAt) * 1000).toISOString()} (in ${delay}s)`)
  return { id, readyAt }
}

const execute = async (target, data, salt) => {
  const hash = await walletOf(requireSender(deployer, 'Executing')).writeContract({
    address: governance.Timelock,
    abi: timelockAbi,
    functionName: 'execute',
    args: [target, 0n, data, ZERO_HASH, salt],
  })
  await waitFor(hash)
  console.log(`  executed      ${explorer(hash)}`)
}

/** One Safe Transaction Builder batch (Safe app → Apps → Transaction Builder → drag the file in). */
const builderFile = (name, description, to, data) => ({
  version: '1.0',
  chainId: String(chain.id),
  createdAt: Date.now(),
  meta: { name, description, txBuilderVersion: '1.17.1', createdFromSafeAddress: governance.Safe },
  transactions: [{ to, value: '0', data, contractMethod: null, contractInputsValues: null }],
})

const prepare = async (contract, signature, target, data, salt) => {
  const delay = await client.readContract({
    address: governance.Timelock,
    abi: timelockAbi,
    functionName: 'getMinDelay',
  })
  const operation = await client.readContract({
    address: governance.Timelock,
    abi: timelockAbi,
    functionName: 'hashOperation',
    args: [target, 0n, data, ZERO_HASH, salt],
  })
  const scheduleData = viem.encodeFunctionData({
    abi: timelockAbi,
    functionName: 'schedule',
    args: [target, 0n, data, ZERO_HASH, salt, delay],
  })
  const executeData = viem.encodeFunctionData({
    abi: timelockAbi,
    functionName: 'execute',
    args: [target, 0n, data, ZERO_HASH, salt],
  })
  const dir = join(root, 'admin-proposals')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const fn = signature.split('(')[0]
  const what = `${contract}.${signature}`
  const first = join(dir, `${stamp}-${fn}-1-schedule.json`)
  const second = join(dir, `${stamp}-${fn}-2-execute.json`)
  writeFileSync(
    first,
    `${JSON.stringify(builderFile(`Schedule ${fn}`, `Timelock: schedule ${what}`, governance.Timelock, scheduleData), null, 2)}\n`,
  )
  writeFileSync(
    second,
    `${JSON.stringify(builderFile(`Execute ${fn}`, `Timelock: execute ${what}`, governance.Timelock, executeData), null, 2)}\n`,
  )
  console.log(`  operation     ${operation}`)
  console.log(`  salt          ${salt}`)
  console.log(`  delay         ${delay}s once scheduled`)
  console.log(`\n  1. Safe app (${governance.Safe}) → Apps → Transaction Builder → drag in`)
  console.log(`       ${first}`)
  console.log(
    '     Create the batch; the owners sign; the last signer executes it. That only schedules the call.',
  )
  const wait = Number(delay) % 3600 === 0 ? `${Number(delay) / 3600} hours` : `${Math.round(Number(delay) / 60)} minutes`
  console.log(`  2. After ${wait}, the same with`)
  console.log(`       ${second}`)
  console.log(
    `     or from any funded key: pnpm admin ${network} execute ${contract} "${signature}" … --salt ${salt}`,
  )
  console.log('  Until step 2 the Safe can still cancel it: nobody is surprised by an admin change.')
}

const saltArg = () => {
  const index = rest.indexOf('--salt')
  if (index === -1) return null
  const salt = rest[index + 1]
  rest.splice(index, 2)
  return salt
}

const scheduleAndWait = async (target, data) => {
  const salt = viem.keccak256(viem.toHex(`${data}:${Date.now()}`))
  const { id, readyAt } = await schedule(target, data, salt)
  for (;;) {
    const block = await client.getBlock()
    if (block.timestamp >= readyAt) break
    const left = Number(readyAt - block.timestamp)
    process.stdout.write(`\r  waiting out the timelock… ${left}s   `)
    if (local) await client.request({ method: 'evm_mine', params: [] }).catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, Math.min(15, Math.max(1, left)) * 1000))
  }
  process.stdout.write('\n')
  let ready = false
  for (let attempt = 0; attempt < 15 && !ready; attempt++) {
    ready = await client.readContract({
      address: governance.Timelock,
      abi: timelockAbi,
      functionName: 'isOperationReady',
      args: [id],
    })
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 4000))
  }
  if (!ready) fail(`the operation is not ready: was it cancelled? (salt ${salt})`)
  await execute(target, data, salt)
}

switch (command) {
  case 'status': {
    const [delay, paused] = await Promise.all([
      client.readContract({ address: governance.Timelock, abi: timelockAbi, functionName: 'getMinDelay' }),
      client.readContract({
        address: deployment.contracts.RoleRegistry,
        abi: rolesAbi,
        functionName: 'paused',
      }),
    ])
    console.log(`network       ${network}`)
    console.log(`admin         ${governance.Timelock} (TimelockController, ${delay}s delay)`)
    console.log(`proposer      ${governance.Safe}`)
    if ((await client.getCode({ address: governance.Safe })) !== undefined) {
      const [threshold, owners] = await Promise.all([
        client.readContract({ address: governance.Safe, abi: safeAbi, functionName: 'getThreshold' }),
        client.readContract({ address: governance.Safe, abi: safeAbi, functionName: 'getOwners' }),
      ])
      console.log(`              a ${threshold}-of-${owners.length} Safe: ${owners.join(', ')}`)
    }
    console.log(`guardian      ${governance.Guardian} (may pause at once)`)
    console.log(`paused        ${paused}`)
    break
  }
  case 'prepare': {
    const salt = saltArg()
    const [contract, signature, ...args] = rest
    if (!contract || !signature) fail('usage: prepare <Contract|0xaddress> "<fn(types)>" [args…]')
    const { target, data } = encodeCall(contract, signature, args)
    console.log(`▸ prepare ${contract}.${signature}`)
    await prepare(
      contract,
      signature,
      target,
      data,
      salt ?? viem.keccak256(viem.toHex(`${data}:${Date.now()}`)),
    )
    break
  }
  case 'schedule':
  case 'execute':
  case 'run': {
    const salt = saltArg()
    const [contract, signature, ...args] = rest
    if (!contract || !signature) fail(`usage: ${command} <Contract|0xaddress> "<fn(types)>" [args…]`)
    const { target, data } = encodeCall(contract, signature, args)
    console.log(`▸ ${command} ${contract}.${signature}`)
    if (command === 'schedule')
      await schedule(target, data, salt ?? viem.keccak256(viem.toHex(`${data}:${Date.now()}`)))
    else if (command === 'execute') {
      if (!salt) fail('execute needs the --salt printed when the call was scheduled')
      await execute(target, data, salt)
    } else await scheduleAndWait(target, data)
    break
  }
  case 'register-ngo': {
    const [ngo, payout = ngo] = rest
    if (!ngo || !viem.isAddress(ngo)) fail('usage: register-ngo <ngo address> [payout address]')
    const { target, data } = encodeCall('RoleRegistry', 'registerNgo(address,address,bytes32,string)', [
      ngo,
      payout,
      viem.keccak256(viem.toHex(`ngo-credential:${ngo.toLowerCase()}`)),
      'ipfs://ngo',
    ])
    console.log(`▸ register ${ngo} as an NGO (payout ${payout})`)
    await scheduleAndWait(target, data)
    break
  }
  case 'pause': {
    // The guardian acts alone and at once: stopping must never wait for signatures or a delay.
    if (!guardianKey) {
      fail(
        `pause is the guardian's: call pause() on RoleRegistry ${deployment.contracts.RoleRegistry} from the guardian wallet (Basescan → Write contract), or set GUARDIAN_PRIVATE_KEY.`,
      )
    }
    const hash = await walletOf(guardianKey).writeContract({
      address: deployment.contracts.RoleRegistry,
      abi: rolesAbi,
      functionName: 'pause',
    })
    await waitFor(hash)
    console.log(`▸ paused  ${explorer(hash)}  (unpausing is an admin action: run RoleRegistry "unpause()")`)
    break
  }
  default:
    fail(`unknown command "${command}" (status, prepare, schedule, execute, run, register-ngo, pause)`)
}
