import { ponder } from 'ponder:registry'
import schema from 'ponder:schema'
import { and, eq } from 'ponder'
import { zeroAddress } from 'viem'
import { appendTimeline, eventId, seconds } from './lib/timeline.js'

/**
 * One vault per need: donations in, tranches out. Indexed as `Ledger`. Amounts stay in token base units.
 */

const BPS_DENOMINATOR = 10_000n

ponder.on('Ledger:Donated', async ({ event, context }) => {
  const { needId, donor, amount, receiptId } = event.args
  const id = eventId(event)

  await context.db.insert(schema.donation).values({
    id,
    needId,
    kind: 'DIRECT',
    donor,
    donorRefHash: null,
    amount,
    withdrawn: 0n,
    receiptId,
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

/**
 * A donor took money back while the need was still raising. The donation row keeps what was given and what was
 * withdrawn — deleting it would erase a fact — and everything that reads "raised" uses `amount`, which is the
 * net. The receipt NFT states the same net, because it is a public claim about a donation that changed.
 */
ponder.on('Ledger:DonationWithdrawn', async ({ event, context }) => {
  const { needId, donor, receiptId, amount } = event.args

  const [row] = await context.db.sql
    .select({ id: schema.donation.id })
    .from(schema.donation)
    .where(and(eq(schema.donation.receiptId, receiptId), eq(schema.donation.needId, needId)))
    .limit(1)
  if (row) {
    await context.db.update(schema.donation, { id: row.id }).set((donation) => ({
      amount: donation.amount - amount,
      withdrawn: donation.withdrawn + amount,
    }))
  }

  await context.db
    .update(schema.receipt, { id: receiptId })
    .set((receipt) => ({ amount: receipt.amount - amount }))
  await context.db
    .update(schema.need, { id: needId })
    .set((need) => ({ totalDonated: need.totalDonated - amount }))

  await appendTimeline(context, event, {
    needId,
    type: 'DonationWithdrawn',
    data: { donor, amount: amount.toString(), receiptId: receiptId.toString() },
  })
})

/**
 * Funding closed: the tranche plan turns into amounts. This mirrors `TrancheLedger._closeFunding` exactly —
 * `bps` of the total per tranche, with the rounding dust assigned to the last one (DECISIONS §6).
 */
ponder.on('Ledger:FundingClosed', async ({ event, context }) => {
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

ponder.on('Ledger:TrancheReleasable', async ({ event, context }) => {
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

ponder.on('Ledger:TrancheReleased', async ({ event, context }) => {
  const { needId, index, amount, to } = event.args
  const trancheIndex = Number(index)

  await context.db.update(schema.tranche, { needId, index: trancheIndex }).set({
    status: 'Released',
    amount,
    releasedAt: seconds(event),
    // A vault pays the payment plan's payees (see payments.ts), so `to` is always zero.
    releasedTo: to === zeroAddress ? null : to,
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

ponder.on('Ledger:Refunded', async ({ event, context }) => {
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

ponder.on('Ledger:RefundedByRef', async ({ event, context }) => {
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
    // Only a deposit address that credited itself refunds by reference: nobody else writes a reference.
    data: { donorRefHash, to, amount: amount.toString(), kind: 'DEPOSIT' },
  })
})

// ─── idle capital ────────────────────────────────────────────────────────────

/**
 * Money a need cannot spend yet, waiting in an ERC-4626 venue. The vault keeps its books in assets at cost,
 * so `deployedPrincipal` is what went out and `yieldRealised` is only what actually came home — the dashboard
 * never shows a paper gain as if it were money the need has.
 */
ponder.on('Ledger:IdleDeployed', async ({ event, context }) => {
  const { needId, venue, assets } = event.args

  await context.db.update(schema.need, { id: needId }).set((need) => ({
    yieldVenue: venue,
    deployedPrincipal: need.deployedPrincipal + assets,
  }))

  await appendTimeline(context, event, {
    needId,
    type: 'IdleDeployed',
    data: { venue, amount: assets.toString() },
  })
})

ponder.on('Ledger:IdleUnwound', async ({ event, context }) => {
  const { needId, venue, assets } = event.args

  await context.db.update(schema.need, { id: needId }).set((need) => ({
    // Withdrawals count against principal first, exactly as the vault does it; the surplus arrives as a
    // YieldHarvested-shaped credit through the same event, so it is not added twice here.
    deployedPrincipal: need.deployedPrincipal > assets ? need.deployedPrincipal - assets : 0n,
    yieldRealised:
      need.deployedPrincipal > assets
        ? need.yieldRealised
        : need.yieldRealised + (assets - need.deployedPrincipal),
  }))

  await appendTimeline(context, event, {
    needId,
    type: 'IdleUnwound',
    data: { venue, amount: assets.toString() },
  })
})

ponder.on('Ledger:YieldHarvested', async ({ event, context }) => {
  const { needId, venue, assets } = event.args

  await context.db
    .update(schema.need, { id: needId })
    .set((need) => ({ yieldRealised: need.yieldRealised + assets }))

  await appendTimeline(context, event, {
    needId,
    type: 'YieldHarvested',
    data: { venue, amount: assets.toString() },
  })
})

ponder.on('Ledger:YieldPaid', async ({ event, context }) => {
  const { needId, to, assets } = event.args

  await context.db.update(schema.need, { id: needId }).set((need) => ({ yieldPaid: need.yieldPaid + assets }))

  await appendTimeline(context, event, {
    needId,
    type: 'YieldPaid',
    data: { to, amount: assets.toString() },
  })
})

/** Principal a venue did not return. Recorded on its own, because a need that lost money has to say so. */
ponder.on('Ledger:SleeveLoss', async ({ event, context }) => {
  const { needId, venue, shortfall } = event.args

  await context.db.update(schema.need, { id: needId }).set((need) => ({
    yieldLost: need.yieldLost + shortfall,
    deployedPrincipal: 0n,
    yieldVenue: null,
  }))

  await appendTimeline(context, event, {
    needId,
    type: 'SleeveLoss',
    data: { venue, amount: shortfall.toString() },
  })
})
