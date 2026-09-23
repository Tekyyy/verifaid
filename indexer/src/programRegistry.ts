import { ponder } from 'ponder:registry'
import schema from 'ponder:schema'
import { seconds } from './lib/timeline.js'

/**
 * Programmes are labels an NGO's needs point to: who they serve, and a hash of the published eligibility rules.
 * Nobody is enrolled on chain; the NGO keeps its beneficiaries in its own encrypted records.
 */

ponder.on('ProgramRegistry:ProgramCreated', async ({ event, context }) => {
  const { programId, ngo, eligibilityHash, metadataURI } = event.args
  await context.db.insert(schema.program).values({
    id: programId,
    ngo,
    eligibilityHash,
    metadataURI,
    active: true,
    createdAt: seconds(event),
  })
})

ponder.on('ProgramRegistry:ProgramStatusChanged', async ({ event, context }) => {
  await context.db.update(schema.program, { id: event.args.programId }).set({ active: event.args.active })
})
