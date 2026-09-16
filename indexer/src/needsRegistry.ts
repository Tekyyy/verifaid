import { ponder } from 'ponder:registry'
import schema from 'ponder:schema'
import { needStatusName } from '@poa/shared'
import { appendTimeline, seconds } from './lib/timeline.js'

/** The need lifecycle: Pending → Verified → Funding → Funded → InDelivery → Completed, or Cancelled. */

ponder.on('NeedsRegistry:NeedCreated', async ({ event, context }) => {
  const { needId, trancheBps } = event.args

  await context.db.insert(schema.need).values({
    id: needId,
    ngo: event.args.ngo,
    programId: event.args.programId,
    category: event.args.category,
    regionCode: event.args.regionCode,
    dossierHash: event.args.dossierHash,
    metadataURI: event.args.metadataURI,
    targetAmount: event.args.targetAmount,
    verificationsRequired: event.args.verificationsRequired,
    verificationCount: 0,
    status: 'Pending',
    vault: null,
    totalDonated: 0n,
    totalReleased: 0n,
    totalRefunded: 0n,
    trancheCount: trancheBps.length,
    createdAt: seconds(event),
    createdTxHash: event.transaction.hash,
    fundingClosedAt: null,
    completedAt: null,
    cancelledAt: null,
  })

  // The plan is fixed at creation; the amounts are only known when funding closes.
  await context.db.insert(schema.tranche).values(
    trancheBps.map((bps, index) => ({
      needId,
      index,
      bps,
      amount: 0n,
      status: 'Locked',
      deliveryId: null,
      releasedAt: null,
      releasedTo: null,
      releaseTxHash: null,
    })),
  )

  await appendTimeline(context, event, {
    needId,
    type: 'NeedCreated',
    data: {
      ngo: event.args.ngo,
      programId: event.args.programId.toString(),
      category: event.args.category,
      regionCode: event.args.regionCode,
      targetAmount: event.args.targetAmount.toString(),
      verificationsRequired: event.args.verificationsRequired,
      trancheCount: trancheBps.length,
      metadataURI: event.args.metadataURI,
    },
  })
})

ponder.on('NeedsRegistry:NeedVerificationRecorded', async ({ event, context }) => {
  const { needId, verifier, approved, attestationUID, verificationCount } = event.args

  await context.db.update(schema.need, { id: needId }).set({ verificationCount })

  await appendTimeline(context, event, {
    needId,
    type: 'NeedVerificationRecorded',
    data: { verifier, approved, verificationCount },
    attestationUID,
  })
})

ponder.on('NeedsRegistry:NeedVerified', async ({ event, context }) => {
  await context.db.update(schema.need, { id: event.args.needId }).set({ vault: event.args.vault })

  await appendTimeline(context, event, {
    needId: event.args.needId,
    type: 'NeedVerified',
    data: { vault: event.args.vault },
  })
})

ponder.on('NeedsRegistry:NeedStatusChanged', async ({ event, context }) => {
  const { needId } = event.args
  const from = needStatusName(event.args.from)
  const to = needStatusName(event.args.to)

  await context.db.update(schema.need, { id: needId }).set({
    status: to,
    ...(to === 'Completed' ? { completedAt: seconds(event) } : {}),
    ...(to === 'Cancelled' ? { cancelledAt: seconds(event) } : {}),
  })

  await appendTimeline(context, event, { needId, type: 'NeedStatusChanged', data: { from, to } })
})

ponder.on('NeedsRegistry:NeedCancelled', async ({ event, context }) => {
  await appendTimeline(context, event, {
    needId: event.args.needId,
    type: 'NeedCancelled',
    data: { by: event.args.by },
  })
})

ponder.on('NeedsRegistry:NeedVerificationRevoked', async ({ event, context }) => {
  const { needId, verifier, attestationUID, verificationCount } = event.args

  await context.db.update(schema.need, { id: needId }).set({ verificationCount })

  await appendTimeline(context, event, {
    needId,
    type: 'VerificationRevoked',
    data: { verifier, verificationCount, honored: true },
    attestationUID,
  })
})

/** Revoking after money moved does not change state; it opens the off-chain dispute process (spec §5.2). */
ponder.on('NeedsRegistry:VerificationRevokedAfterFunding', async ({ event, context }) => {
  await appendTimeline(context, event, {
    needId: event.args.needId,
    type: 'VerificationRevoked',
    data: { verifier: event.args.verifier, honored: false },
    attestationUID: event.args.attestationUID,
  })
})
