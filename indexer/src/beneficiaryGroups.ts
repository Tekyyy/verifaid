import { ponder } from 'ponder:registry'
import schema from 'ponder:schema'
import { seconds } from './lib/timeline.js'

/**
 * Programs own a Semaphore group each. This contract never emits individual commitments (spec §5.8); those
 * come from Semaphore itself, indexed in `semaphore.ts`. Here we keep the program record and the live member
 * count that `DeliveryManager.openDelivery` bounds `expectedRecipients` against.
 */

ponder.on('BeneficiaryGroups:ProgramCreated', async ({ event, context }) => {
  const { programId, ngo, semaphoreGroupId, enrollmentPolicyHash, metadataURI } = event.args

  await context.db.insert(schema.program).values({
    id: programId,
    ngo,
    groupId: semaphoreGroupId,
    enrollmentPolicyHash,
    metadataURI,
    memberCount: 0,
    leafCount: 0,
    merkleTreeRoot: null,
    active: true,
    createdAt: seconds(event),
  })

  await context.db
    .insert(schema.semaphoreGroup)
    .values({ groupId: semaphoreGroupId, programId })
    .onConflictDoUpdate({ programId })
})

ponder.on('BeneficiaryGroups:MembersAdded', async ({ event, context }) => {
  const count = Number(event.args.count)
  await context.db
    .update(schema.program, { id: event.args.programId })
    .set((row) => ({ memberCount: row.memberCount + count }))
})

ponder.on('BeneficiaryGroups:MemberRemoved', async ({ event, context }) => {
  await context.db
    .update(schema.program, { id: event.args.programId })
    .set((row) => ({ memberCount: row.memberCount - 1 }))
})

ponder.on('BeneficiaryGroups:ProgramStatusChanged', async ({ event, context }) => {
  await context.db.update(schema.program, { id: event.args.programId }).set({ active: event.args.active })
})
