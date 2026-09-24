import { ponder } from 'ponder:registry'
import schema from 'ponder:schema'
import { appendTimeline, seconds } from './lib/timeline.js'

/**
 * v10: needs a certified beneficiary posted themselves, and NGOs withdrawing a certification. Who an NGO certified
 * never reaches the chain; a wallet shows up here only when its owner posts a need, or when the NGO revokes it.
 */

ponder.on('BeneficiaryRegistry:BeneficiaryNeedPosted', async ({ event, context }) => {
  const { needId, beneficiary, ngo, programId, certifiedAt } = event.args
  // NeedsRegistry:NeedCreated comes first in the same transaction, so the row exists.
  await context.db.update(schema.need, { id: needId }).set({ beneficiary })
  await appendTimeline(context, event, {
    needId,
    type: 'BeneficiaryNeedPosted',
    data: { beneficiary, ngo, programId: programId.toString(), certifiedAt: Number(certifiedAt) },
  })
})

ponder.on('BeneficiaryRegistry:CertificationRevoked', async ({ event, context }) => {
  const { ngo, beneficiary } = event.args
  const revokedAt = seconds(event)
  await context.db
    .insert(schema.certificationRevocation)
    .values({ ngo, beneficiary, revokedAt, txHash: event.transaction.hash })
    .onConflictDoUpdate({ revokedAt, txHash: event.transaction.hash })
})
