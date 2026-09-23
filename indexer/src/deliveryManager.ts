import { ponder } from 'ponder:registry'
import schema from 'ponder:schema'
import { appendTimeline, seconds } from './lib/timeline.js'

/**
 * A delivery is the NGO's account of a tranche it was paid, filed to unlock the next one. Donors approve it with
 * the weight of what they gave; once enough of the raised amount has, the vault makes the tranche releasable
 * (`TrancheReleasable`, handled with the ledger).
 */

ponder.on('DeliveryManager:DeliverySubmitted', async ({ event, context }) => {
  const { deliveryId, needId, trancheIndex, submitter, evidenceHash, manifest } = event.args

  // The threshold is fixed once funding closes, which it has by the time evidence can be filed.
  const requiredAmount = await context.client.readContract({
    address: context.contracts.DeliveryManager.address,
    abi: context.contracts.DeliveryManager.abi,
    functionName: 'requiredApproval',
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
    requiredAmount,
    supersededBy: null,
    submittedAt: seconds(event),
    approvedAt: null,
    txHash: event.transaction.hash,
  })

  await appendTimeline(context, event, {
    needId,
    type: 'DeliverySubmitted',
    data: { deliveryId: deliveryId.toString(), trancheIndex: Number(trancheIndex), evidenceHash },
  })
})

ponder.on('DeliveryManager:DeliverySuperseded', async ({ event, context }) => {
  const { deliveryId, replacedBy } = event.args
  const record = await context.db.find(schema.delivery, { id: deliveryId })
  if (!record) return

  await context.db
    .update(schema.delivery, { id: deliveryId })
    .set({ status: 'Superseded', supersededBy: replacedBy })

  await appendTimeline(context, event, {
    needId: record.needId,
    type: 'DeliverySuperseded',
    data: { deliveryId: deliveryId.toString(), replacedBy: replacedBy.toString() },
  })
})

ponder.on('DeliveryManager:DeliveryApprovalAdded', async ({ event, context }) => {
  const { deliveryId, donor, weight, approvedAmount, requiredAmount } = event.args
  const record = await context.db.find(schema.delivery, { id: deliveryId })
  if (!record) return

  await context.db.insert(schema.deliveryApproval).values({
    id: `${deliveryId}-${donor.toLowerCase()}`,
    deliveryId,
    needId: record.needId,
    donor,
    weight,
    txHash: event.transaction.hash,
    timestamp: seconds(event),
  })
  await context.db.update(schema.delivery, { id: deliveryId }).set({ approvedAmount, requiredAmount })

  await appendTimeline(context, event, {
    needId: record.needId,
    type: 'DeliveryApprovalAdded',
    data: {
      deliveryId: deliveryId.toString(),
      donor,
      weight: weight.toString(),
      approvedAmount: approvedAmount.toString(),
      requiredAmount: requiredAmount.toString(),
    },
  })
})

ponder.on('DeliveryManager:DeliveryApproved', async ({ event, context }) => {
  const { deliveryId, needId, trancheIndex } = event.args

  await context.db
    .update(schema.delivery, { id: deliveryId })
    .set({ status: 'Approved', approvedAt: seconds(event) })

  await appendTimeline(context, event, {
    needId,
    type: 'DeliveryApproved',
    data: { deliveryId: deliveryId.toString(), trancheIndex: Number(trancheIndex) },
  })
})
