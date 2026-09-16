import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Group } from '@semaphore-protocol/group'
import { Identity } from '@semaphore-protocol/identity'

/**
 * The demo beneficiaries.
 *
 * Their identity secrets are derived from a public seed so this script can produce real Semaphore proofs for
 * the same commitments SeedDemo.s.sol enrolled on-chain. That is only acceptable because this is a testnet
 * demo: in production a beneficiary's secret is generated on their own device and never leaves it.
 */

export interface DemoIdentity {
  index: number
  identity: Identity
  commitment: bigint
}

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../contracts/script/fixtures/demo-identities.json',
)

export const loadDemoIdentities = (seed: string): DemoIdentity[] => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
    seed: string
    count: number
    commitments: string[]
  }
  if (fixture.seed !== seed) {
    throw new Error(
      `DEMO_IDENTITY_SEED "${seed}" does not match the seed the commitments were generated with ` +
        `("${fixture.seed}"). Regenerate with: pnpm --filter @poa/contracts fixture:demo`,
    )
  }

  return fixture.commitments.map((expected, index) => {
    const identity = new Identity(`${seed}:beneficiary:${index}`)
    if (identity.commitment !== BigInt(expected)) {
      throw new Error(`Identity ${index} does not reproduce the enrolled commitment; the seed changed.`)
    }
    return { index, identity, commitment: identity.commitment }
  })
}

/**
 * Rebuilds the Semaphore group exactly as the contract holds it: same members, same insertion order, hence the
 * same Merkle root the on-chain proofs are verified against.
 */
export const buildGroup = (identities: DemoIdentity[]): Group =>
  new Group(identities.map((entry) => entry.commitment))

// `pnpm --filter @poa/demo identities` prints the commitments for manual enrolment.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const seed = process.env.DEMO_IDENTITY_SEED ?? 'proof-of-aid-demo'
  const identities = loadDemoIdentities(seed)
  const group = buildGroup(identities)
  console.log(`seed: ${seed}`)
  console.log(`members: ${identities.length}, merkle root: ${group.root}, depth: ${group.depth}`)
  for (const entry of identities) console.log(`  [${entry.index}] ${entry.commitment}`)
}
