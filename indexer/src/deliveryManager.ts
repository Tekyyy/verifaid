import { ponder } from 'ponder:registry'
import schema from 'ponder:schema'
import { appendTimeline, eventId, seconds } from './lib/timeline.js'

/**
 * A delivery unlocks one tranche once three independent signals agree: field evidence, anonymous beneficiary
 * confirmations and an independent verifier's sign-off, followed by a challenge window.
 *
 * Only the deliveryId is indexed on most of these events, so the need is resolved from the delivery row that
 * `DeliveryOpened` wrote.
 */

ponder.on('DeliveryManager:DeliveryOpened', async ({ event, context }) => {
  const { deliveryId, needId, trancheIndex, fieldAgent, expectedRecipients } = event.args

  await context.db.insert(schema.delivery).values({
    id: deliveryId,
    needId,
    trancheIndex: Number(trancheIndex),
    fieldAgent,
    expectedRecipients,
    confirmations: 0,
    status: 'Open',
    evidenceUID: null,
    evidenceCID: null,
    evidenceHash: null,
    itemsDelivered: null,
    verifierUID: null,
    verifier: null,
    challengeDeadline: null,
    activeChallengeId: null,
    openedAt: seconds(event),
    finalizedAt: null,
  })

  await appendTimeline(context, event, {
    needId,
    type: 'DeliveryOpened',
    data: {
      deliveryId: deliveryId.toString(),
      trancheIndex: Number(trancheIndex),
      fieldAgent,
      expectedRecipients,
    },
  })
})

ponder.on('DeliveryManager:DeliveryEvidenceLinked', async ({ event, context }) => {
  const { deliveryId, attestationUID } = event.args
  const record = await context.db.find(schema.delivery, { id: deliveryId })
  if (!record) return

  await context.db.update(schema.delivery, { id: deliveryId }).set({ evidenceUID: attestationUID })

  await appendTimeline(context, event, {
    needId: record.needId,
    type: 'DeliveryEvidenceLinked',
    // The CID and hash come from the attestation payload, decoded in the EAS handler.
    data: { deliveryId: deliveryId.toString(), evidenceCID: record.evidenceCID },
    attestationUID,
  })
})

/**
 * An anonymous confirmation. The nullifier is public on-chain, scoped to this one delivery, and cannot be
 * linked to an identity or across deliveries — it is the only thing recorded, alongside the running count.
 */
ponder.on('DeliveryManager:ReceiptConfirmed', async ({ event, context }) => {
  const { deliveryId, nullifier, confirmations } = event.args
  const record = await context.db.find(schema.delivery, { id: deliveryId })
  if (!record) return

  await context.db.insert(schema.confirmation).values({
    id: `${deliveryId}-${nullifier}`,
    deliveryId,
    needId: record.needId,
    nullifier,
    sequence: confirmations,
    txHash: event.transaction.hash,
    timestamp: seconds(event),
  })

  await context.db.update(schema.delivery, { id: deliveryId }).set({ confirmations })

  await appendTimeline(context, event, {
    needId: record.needId,
    type: 'ReceiptConfirmed',
    data: {
      deliveryId: deliveryId.toString(),
      confirmations,
      expectedRecipients: record.expectedRecipients,
      nullifier: nullifier.toString(),
    },
  })
})

ponder.on('DeliveryManager:DeliveryVerifiedLinked', async ({ event, context }) => {
  const { deliveryId, attestationUID, verifier, approved } = event.args
  const record = await context.db.find(schema.delivery, { id: deliveryId })
  if (!record) return

  await context.db.update(schema.delivery, { id: deliveryId }).set({ verifierUID: attestationUID, verifier })

  await appendTimeline(context, event, {
    needId: record.needId,
    type: 'DeliveryVerifiedLinked',
    data: { deliveryId: deliveryId.toString(), verifier, approved },
    attestationUID,
  })
})

ponder.on('DeliveryManager:DeliveryChallengeable', async ({ event, context }) => {
  const { deliveryId, challengeDeadline } = event.args
  const record = await context.db.find(schema.delivery, { id: deliveryId })
  if (!record) return

  await context.db
    .update(schema.delivery, { id: deliveryId })
    .set({ status: 'Challengeable', challengeDeadline: Number(challengeDeadline) })

  await appendTimeline(context, event, {
    needId: record.needId,
    type: 'DeliveryChallengeable',
    data: { deliveryId: deliveryId.toString(), challengeDeadline: Number(challengeDeadline) },
  })
})

ponder.on('DeliveryManager:DeliveryChallenged', async ({ event, context }) => {
  const { deliveryId, challenger, reasonHash } = event.args
  const record = await context.db.find(schema.delivery, { id: deliveryId })
  if (!record) return
  const id = eventId(event)

  await context.db.insert(schema.challenge).values({
    id,
    deliveryId,
    needId: record.needId,
    challenger,
    reasonHash,
    upheld: null,
    resolvedAt: null,
    timestamp: seconds(event),
  })

  await context.db
    .update(schema.delivery, { id: deliveryId })
    .set({ status: 'Disputed', activeChallengeId: id })

  await appendTimeline(context, event, {
    needId: record.needId,
    type: 'DeliveryChallenged',
    data: { deliveryId: deliveryId.toString(), challenger, reasonHash },
  })
})

/** `upheld = true` rejects the delivery; `false` sends it back to Challengeable with a fresh deadline. */
ponder.on('DeliveryManager:DisputeResolved', async ({ event, context }) => {
  const { deliveryId, upheld } = event.args
  const record = await context.db.find(schema.delivery, { id: deliveryId })
  if (!record) return

  if (record.activeChallengeId) {
    await context.db
      .update(schema.challenge, { id: record.activeChallengeId })
      .set({ upheld, resolvedAt: seconds(event) })
    await context.db.update(schema.delivery, { id: deliveryId }).set({ activeChallengeId: null })
  }

  await appendTimeline(context, event, {
    needId: record.needId,
    type: 'DisputeResolved',
    data: { deliveryId: deliveryId.toString(), upheld },
  })
})

ponder.on('DeliveryManager:DeliveryFinalized', async ({ event, context }) => {
  const { deliveryId, needId, trancheIndex } = event.args

  await context.db
    .update(schema.delivery, { id: deliveryId })
    .set({ status: 'Finalized', finalizedAt: seconds(event) })

  await appendTimeline(context, event, {
    needId,
    type: 'DeliveryFinalized',
    data: { deliveryId: deliveryId.toString(), trancheIndex: Number(trancheIndex) },
  })
})

ponder.on('DeliveryManager:DeliveryRejected', async ({ event, context }) => {
  const { deliveryId, needId, trancheIndex } = event.args

  await context.db.update(schema.delivery, { id: deliveryId }).set({ status: 'Rejected' })

  await appendTimeline(context, event, {
    needId,
    type: 'DeliveryRejected',
    data: { deliveryId: deliveryId.toString(), trancheIndex: Number(trancheIndex) },
  })
})
