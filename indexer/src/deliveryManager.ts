import { ponder } from 'ponder:registry'
import schema from 'ponder:schema'
import { voiceName } from '@poa/shared'
import { appendTimeline, seconds } from './lib/timeline.js'

/**
 * A delivery is the NGO's account of a tranche it was paid, filed to unlock the next one. It is judged under the
 * need's release policy: donors vote with the weight of what they gave, independent verifiers count once each.
 * Enough approval makes the tranche releasable (`TrancheReleasable`, handled with the ledger); enough rejection
 * sends the NGO back, and past its retries cancels the need (`NeedStatusChanged`, handled with the registry).
 */

ponder.on('DeliveryManager:DeliverySubmitted', async ({ event, context }) => {
  const { deliveryId, needId, trancheIndex, submitter, evidenceHash, manifest } = event.args

  // The thresholds are fixed once funding closes, which it has by the time evidence can be filed.
  const rules = await context.client.readContract({
    address: context.contracts.DeliveryManager.address,
    abi: context.contracts.DeliveryManager.abi,
    functionName: 'rulesOf',
    args: [needId],
  })

  await context.db.insert(schema.delivery).values({
    id: deliveryId,
    needId,
    trancheIndex: Number(trancheIndex),
    submitter,
    status: 'Open',
    evidenceHash,
    manifest,
    approvedAmount: 0n,
    rejectedAmount: 0n,
    verifierApprovals: 0,
    verifierRejections: 0,
    requiredAmount: rules.donorApproval,
    rejectionAmount: rules.donorRejection,
    requiredVerifiers: Number(rules.verifierApproval),
    supersededBy: null,
    contested: false,
    cancelledNeed: false,
    submittedAt: seconds(event),
    decidedAt: null,
    txHash: event.transaction.hash,
  })

  await appendTimeline(context, event, {
    needId,
    type: 'DeliverySubmitted',
    data: { deliveryId: deliveryId.toString(), trancheIndex: Number(trancheIndex), evidenceHash },
  })
})

ponder.on('DeliveryManager:DeliverySuperseded', async ({ event, context }) => {
  const { deliveryId, replacedBy, contested, strikes } = event.args
  const record = await context.db.find(schema.delivery, { id: deliveryId })
  if (!record) return

  await context.db
    .update(schema.delivery, { id: deliveryId })
    .set({ status: 'Superseded', supersededBy: replacedBy, contested })
  await context.db.update(schema.need, { id: record.needId }).set({ strikes: Number(strikes) })

  await appendTimeline(context, event, {
    needId: record.needId,
    type: 'DeliverySuperseded',
    data: {
      deliveryId: deliveryId.toString(),
      replacedBy: replacedBy.toString(),
      contested,
      strikes: Number(strikes),
    },
  })
})

ponder.on('DeliveryManager:VoteCast', async ({ event, context }) => {
  const { deliveryId, voter, approve, weight } = event.args
  const voice = voiceName(Number(event.args.voice))
  const record = await context.db.find(schema.delivery, { id: deliveryId })
  if (!record) return

  await context.db.insert(schema.deliveryVote).values({
    id: `${deliveryId}-${voter.toLowerCase()}`,
    deliveryId,
    needId: record.needId,
    voter,
    voice,
    approve,
    weight,
    txHash: event.transaction.hash,
    timestamp: seconds(event),
  })
  await context.db
    .update(schema.delivery, { id: deliveryId })
    .set((row) =>
      voice === 'Verifier'
        ? approve
          ? { verifierApprovals: row.verifierApprovals + 1 }
          : { verifierRejections: row.verifierRejections + 1 }
        : approve
          ? { approvedAmount: row.approvedAmount + weight }
          : { rejectedAmount: row.rejectedAmount + weight },
    )

  await appendTimeline(context, event, {
    needId: record.needId,
    type: 'DeliveryVoteCast',
    data: { deliveryId: deliveryId.toString(), voter, voice, approve, weight: weight.toString() },
  })
})

ponder.on('DeliveryManager:DeliveryApproved', async ({ event, context }) => {
  const { deliveryId, needId, trancheIndex } = event.args

  await context.db
    .update(schema.delivery, { id: deliveryId })
    .set({ status: 'Approved', decidedAt: seconds(event) })

  await appendTimeline(context, event, {
    needId,
    type: 'DeliveryApproved',
    data: { deliveryId: deliveryId.toString(), trancheIndex: Number(trancheIndex) },
  })
})

ponder.on('DeliveryManager:DeliveryRejected', async ({ event, context }) => {
  const { deliveryId, needId, trancheIndex, strikes, needCancelled } = event.args

  await context.db
    .update(schema.delivery, { id: deliveryId })
    .set({ status: 'Rejected', decidedAt: seconds(event), cancelledNeed: needCancelled })
  await context.db.update(schema.need, { id: needId }).set({ strikes: Number(strikes) })

  await appendTimeline(context, event, {
    needId,
    type: 'DeliveryRejected',
    data: {
      deliveryId: deliveryId.toString(),
      trancheIndex: Number(trancheIndex),
      strikes: Number(strikes),
      needCancelled,
    },
  })
})
