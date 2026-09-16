import { type Context, ponder } from 'ponder:registry'
import schema from 'ponder:schema'
import { seconds } from './lib/timeline.js'

/**
 * Identity commitments are public on-chain and unlinkable (Poseidon commitments, spec §8.1). They are
 * indexed because the beneficiary page has to rebuild the exact Semaphore tree to produce a Merkle proof:
 * that needs every leaf, in insertion order, including the zeros left behind by a removal.
 *
 * Nothing else about a person is stored. Semaphore is a shared deployment on public chains, so every handler
 * first resolves the group to one of our programs and drops the event otherwise.
 */

const programOfGroup = async (context: Context, groupId: bigint): Promise<bigint | null> => {
  const link = await context.db.find(schema.semaphoreGroup, { groupId })
  return link?.programId ?? null
}

ponder.on('Semaphore:MemberAdded', async ({ event, context }) => {
  const programId = await programOfGroup(context, event.args.groupId)
  if (programId === null) return
  const leafIndex = Number(event.args.index)

  await context.db
    .insert(schema.programMember)
    .values({
      programId,
      leafIndex,
      commitment: event.args.identityCommitment,
      removed: false,
      addedAt: seconds(event),
    })
    .onConflictDoNothing()

  await context.db.update(schema.program, { id: programId }).set((row) => ({
    leafCount: Math.max(row.leafCount, leafIndex + 1),
    merkleTreeRoot: event.args.merkleTreeRoot,
  }))
})

ponder.on('Semaphore:MembersAdded', async ({ event, context }) => {
  const programId = await programOfGroup(context, event.args.groupId)
  if (programId === null) return
  const startIndex = Number(event.args.startIndex)
  const commitments = event.args.identityCommitments

  await context.db
    .insert(schema.programMember)
    .values(
      commitments.map((commitment, offset) => ({
        programId,
        leafIndex: startIndex + offset,
        commitment,
        removed: false,
        addedAt: seconds(event),
      })),
    )
    .onConflictDoNothing()

  await context.db.update(schema.program, { id: programId }).set((row) => ({
    leafCount: Math.max(row.leafCount, startIndex + commitments.length),
    merkleTreeRoot: event.args.merkleTreeRoot,
  }))
})

/** Right to erasure (spec §8.2): the leaf is zeroed on-chain but keeps its index, and so does this row. */
ponder.on('Semaphore:MemberRemoved', async ({ event, context }) => {
  const programId = await programOfGroup(context, event.args.groupId)
  if (programId === null) return

  await context.db
    .update(schema.programMember, { programId, leafIndex: Number(event.args.index) })
    .set({ commitment: 0n, removed: true })

  await context.db
    .update(schema.program, { id: programId })
    .set({ merkleTreeRoot: event.args.merkleTreeRoot })
})

ponder.on('Semaphore:MemberUpdated', async ({ event, context }) => {
  const programId = await programOfGroup(context, event.args.groupId)
  if (programId === null) return

  await context.db
    .update(schema.programMember, { programId, leafIndex: Number(event.args.index) })
    .set({ commitment: event.args.newIdentityCommitment, removed: false })

  await context.db
    .update(schema.program, { id: programId })
    .set({ merkleTreeRoot: event.args.merkleTreeRoot })
})
