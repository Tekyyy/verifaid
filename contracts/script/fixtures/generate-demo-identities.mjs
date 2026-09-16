#!/usr/bin/env node
/**
 * Generates the demo beneficiary identity commitments enrolled by SeedDemo.s.sol.
 *
 * The identities are derived deterministically from DEMO_IDENTITY_SEED so the demo runner can regenerate the
 * same secrets later and produce real Semaphore proofs, without any secret ever being committed. The seed is
 * public on purpose: this is demo material on a testnet, never a production enrollment.
 *
 *   pnpm --filter @poa/contracts fixture:demo
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Identity } from '@semaphore-protocol/identity'

const SEED = process.env.DEMO_IDENTITY_SEED ?? 'proof-of-aid-demo'
const COUNT = Number(process.env.DEMO_IDENTITY_COUNT ?? 12)

const hex = (value) => `0x${BigInt(value).toString(16).padStart(64, '0')}`
const commitments = Array.from({ length: COUNT }, (_, i) => hex(new Identity(`${SEED}:beneficiary:${i}`).commitment))

const outPath = join(dirname(fileURLToPath(import.meta.url)), 'demo-identities.json')
writeFileSync(
  outPath,
  `${JSON.stringify(
    {
      _comment:
        'Demo beneficiary identity commitments. Derived from a PUBLIC seed — testnet demo only, never production.',
      seed: SEED,
      count: COUNT,
      commitments,
    },
    null,
    2,
  )}\n`,
)
console.log(`wrote ${COUNT} commitments to ${outPath}`)
