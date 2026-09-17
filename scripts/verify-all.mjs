#!/usr/bin/env node
/**
 * Runs every check the CI pipeline runs, in the same order, and prints one summary table.
 *
 *   pnpm verify
 *
 * Assumes `pnpm install` has been run. Steps that need a chain or a database are skipped with a reason rather
 * than failing, so the output distinguishes "broken" from "not set up here".
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const contracts = join(root, 'contracts')
const isWindows = process.platform === 'win32'

const run = (command, args, cwd) =>
  spawnSync(command, args, { cwd, stdio: 'inherit', shell: isWindows, env: process.env })

const reachable = (url) => {
  const probe = spawnSync(
    'node',
    ['-e', `fetch(${JSON.stringify(url)}).then(()=>process.exit(0),()=>process.exit(1))`],
    {
      shell: isWindows,
    },
  )
  return probe.status === 0
}

const chainUp = reachable(process.env.ANVIL_RPC_URL ?? 'http://127.0.0.1:8545')
const haveDeployment = existsSync(join(root, 'deployments', 'anvil.json'))
const haveDatabase = Boolean(process.env.DATABASE_URL)

const steps = [
  { name: 'forge fmt --check', cwd: contracts, cmd: ['forge', ['fmt', '--check']] },
  { name: 'forge build', cwd: contracts, cmd: ['forge', ['build']] },
  { name: 'forge test', cwd: contracts, cmd: ['forge', ['test']] },
  {
    name: 'coverage floor (90% lines)',
    cwd: contracts,
    cmd: ['forge', ['coverage', '--report', 'lcov', '--no-match-coverage', '(script|test|mocks)']],
    andThen: {
      cwd: contracts,
      cmd: [
        'node',
        [
          '../scripts/check-coverage.mjs',
          'lcov.info',
          '90',
          'src/access/RoleRegistry.sol',
          'src/needs/NeedsRegistry.sol',
          'src/funds/AidVault.sol',
          'src/funds/AidVaultFactory.sol',
          'src/funds/TrancheLedger.sol',
          'src/funds/NonCustodialLedger.sol',
          'src/resolvers/ProofOfAidResolver.sol',
          'src/conversion/ConversionRouter.sol',
          'src/funds/DonationForwarder.sol',
          'src/funds/DonationForwarderFactory.sol',
          'src/funds/DonationConversion.sol',
          'src/funds/DonationReceipt.sol',
          'src/delivery/DeliveryManager.sol',
          'src/identity/BeneficiaryGroups.sol',
        ],
      ],
    },
  },
  { name: 'biome lint', cwd: root, cmd: ['pnpm', ['lint']] },
  {
    name: 'typecheck',
    cwd: root,
    cmd: ['pnpm', ['typecheck']],
    skip: haveDeployment ? null : 'no deployments/anvil.json — run `pnpm deploy:local` first',
  },
  {
    name: 'build',
    cwd: root,
    cmd: ['pnpm', ['-r', 'build']],
    skip: haveDeployment ? null : 'no deployments/anvil.json — run `pnpm deploy:local` first',
  },
  {
    name: 'tests (all packages)',
    cwd: root,
    cmd: ['pnpm', ['-r', 'test']],
    skip: !chainUp
      ? 'no chain at the anvil RPC — run `pnpm chain` and `pnpm deploy:local`'
      : haveDatabase
        ? null
        : 'DATABASE_URL is not set — service tests need Postgres',
  },
]

const results = []
for (const step of steps) {
  if (step.skip) {
    console.log(`\n--- SKIP ${step.name}: ${step.skip}\n`)
    results.push({ name: step.name, status: 'skipped', detail: step.skip })
    continue
  }
  console.log(`\n--- ${step.name}\n`)
  const started = Date.now()
  let result = run(step.cmd[0], step.cmd[1], step.cwd)
  if (result.status === 0 && step.andThen) {
    result = run(step.andThen.cmd[0], step.andThen.cmd[1], step.andThen.cwd)
  }
  results.push({
    name: step.name,
    status: result.status === 0 ? 'pass' : 'FAIL',
    detail: `${((Date.now() - started) / 1000).toFixed(1)}s`,
  })
}

console.log(`\n${'='.repeat(64)}`)
for (const { name, status, detail } of results) {
  console.log(`  ${status.padEnd(8)} ${name.padEnd(30)} ${detail}`)
}
console.log('='.repeat(64))

const failed = results.filter((r) => r.status === 'FAIL')
if (failed.length > 0) {
  console.error(`\n${failed.length} check(s) failed.`)
  process.exit(1)
}
console.log('\nAll checks that could run passed.')
