import { ponder } from 'ponder:registry'
import schema from 'ponder:schema'
import { appendTimeline, eventId, seconds } from './lib/timeline.js'

/** One vault per need: donations in, tranches out. Amounts stay in token base units everywhere. */

const BPS_DENOMINATOR = 10_000n

ponder.on('AidVault:Donated', async ({ event, context }) => {
  const { needId, donor, amount, receiptId } = event.args
  const id = eventId(event)

  await context.db.insert(schema.donation).values({
    id,
    needId,
    kind: 'DIRECT',
    donor,
    donorRefHash: null,
    paymentRefHash: null,
    partner: null,
    amount,
    receiptId,
    attestationUID: null,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: seconds(event),
  })

  // The receipt NFT is minted before this event, so its row usually already exists.
  await context.db
    .insert(schema.receipt)
    .values({
      id: receiptId,
      needId,
      owner: donor,
      amount,
      donationId: id,
      mintedAt: seconds(event),
      txHash: event.transaction.hash,
    })
    .onConflictDoUpdate({ needId, amount, donationId: id })

  await context.db
    .update(schema.need, { id: needId })
    .set((row) => ({ totalDonated: row.totalDonated + amount }))

  await appendTimeline(context, event, {
    needId,
    type: 'Donated',
    data: { donor, amount: amount.toString(), receiptId: receiptId.toString() },
  })
})

/** Fiat donation deposited by a bank partner. The donor exists only as a salted reference hash (spec §5.6). */
ponder.on('AidVault:DonatedOnBehalf', async ({ event, context }) => {
  const { needId, partner, amount, donorRefHash, paymentRefHash } = event.args

  await context.db.insert(schema.donation).values({
    id: eventId(event),
    needId,
    kind: 'FIAT',
    donor: null,
    donorRefHash,
    paymentRefHash,
    partner,
    amount,
    receiptId: null,
    attestationUID: null,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: seconds(event),
  })

  await context.db
    .update(schema.need, { id: needId })
    .set((row) => ({ totalDonated: row.totalDonated + amount }))

  await appendTimeline(context, event, {
    needId,
    type: 'DonatedOnBehalf',
    data: { partner, amount: amount.toString(), donorRefHash, paymentRefHash },
  })
})

/**
 * Funding closed: the tranche plan turns into amounts. This mirrors `AidVault._closeFunding` exactly —
 * `bps` of the total per tranche, with the rounding dust assigned to the last one (DECISIONS §6).
 */
ponder.on('AidVault:FundingClosed', async ({ event, context }) => {
  const { needId, totalDonated } = event.args

  const record = await context.db.find(schema.need, { id: needId })
  if (!record) return

  await context.db.update(schema.need, { id: needId }).set({ fundingClosedAt: seconds(event) })

  let allocated = 0n
  for (let index = 0; index < record.trancheCount; index++) {
    const row = await context.db.find(schema.tranche, { needId, index })
    if (!row) continue
    const amount =
      index === record.trancheCount - 1
        ? totalDonated - allocated
        : (totalDonated * BigInt(row.bps)) / BPS_DENOMINATOR
    allocated += amount
    await context.db.update(schema.tranche, { needId, index }).set({ amount })
  }

  await appendTimeline(context, event, {
    needId,
    type: 'FundingClosed',
    data: { totalDonated: totalDonated.toString(), tranches: record.trancheCount },
  })
})

ponder.on('AidVault:TrancheReleasable', async ({ event, context }) => {
  const { needId, index, deliveryId } = event.args
  const trancheIndex = Number(index)

  await context.db
    .update(schema.tranche, { needId, index: trancheIndex })
    .set({ status: 'Releasable', deliveryId: deliveryId === 0n ? null : deliveryId })

  await appendTimeline(context, event, {
    needId,
    type: 'TrancheReleasable',
    data: {
      index: trancheIndex,
      deliveryId: deliveryId === 0n ? null : deliveryId.toString(),
      // Tranche 0 is pre-financing: it unlocks on closeFunding, with no delivery behind it.
      preFinancing: trancheIndex === 0,
    },
  })
})

ponder.on('AidVault:TrancheReleased', async ({ event, context }) => {
  const { needId, index, amount, to } = event.args
  const trancheIndex = Number(index)

  await context.db.update(schema.tranche, { needId, index: trancheIndex }).set({
    status: 'Released',
    amount,
    releasedAt: seconds(event),
    releasedTo: to,
    releaseTxHash: event.transaction.hash,
  })

  await context.db
    .update(schema.need, { id: needId })
    .set((row) => ({ totalReleased: row.totalReleased + amount }))

  await appendTimeline(context, event, {
    needId,
    type: 'TrancheReleased',
    data: { index: trancheIndex, amount: amount.toString(), to },
  })
})

ponder.on('AidVault:Refunded', async ({ event, context }) => {
  const { needId, account, amount } = event.args

  await context.db.insert(schema.refund).values({
    id: eventId(event),
    needId,
    account,
    donorRefHash: null,
    amount,
    txHash: event.transaction.hash,
    timestamp: seconds(event),
  })

  await context.db
    .update(schema.need, { id: needId })
    .set((row) => ({ totalRefunded: row.totalRefunded + amount }))

  await appendTimeline(context, event, {
    needId,
    type: 'Refunded',
    data: { account, amount: amount.toString(), kind: 'DIRECT' },
  })
})

ponder.on('AidVault:RefundedByRef', async ({ event, context }) => {
  const { needId, donorRefHash, to, amount } = event.args

  await context.db.insert(schema.refund).values({
    id: eventId(event),
    needId,
    account: to,
    donorRefHash,
    amount,
    txHash: event.transaction.hash,
    timestamp: seconds(event),
  })

  await context.db
    .update(schema.need, { id: needId })
    .set((row) => ({ totalRefunded: row.totalRefunded + amount }))

  await appendTimeline(context, event, {
    needId,
    type: 'Refunded',
    data: { donorRefHash, to, amount: amount.toString(), kind: 'FIAT' },
  })
})
