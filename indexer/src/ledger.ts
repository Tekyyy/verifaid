import { ponder } from 'ponder:registry'
import schema from 'ponder:schema'
import { currencyLabel } from '@poa/shared'
import { and, eq } from 'ponder'
import type { Hex } from 'viem'
import { appendTimeline, eventId, seconds } from './lib/timeline.js'

/**
 * One ledger per need: donations in, tranches out. The custodial AidVault and the NonCustodialLedger emit the
 * same funding and tranche events, so both are indexed as `Ledger`. Amounts stay in token base units.
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
    paymentRefHash: null,
    partner: null,
    amount,
    gross: amount,
    fee: 0n,
    currency: null,
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
ponder.on('Ledger:DonatedOnBehalf', async ({ event, context }) => {
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
    // gross, fee and currency arrive with the provider's FundingRecorded attestation (see eas.ts)
    gross: null,
    fee: null,
    currency: null,
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
 * Off-chain custody (Model A): the custodian's FundingRecorded attestation counted a payment toward the target.
 * No token moved; the attestation that caused this event is in the same transaction, with a lower log index.
 */
ponder.on('Ledger:FundingRecorded', async ({ event, context }) => {
  const { needId, provider, gross, fee, net, currency, paymentRefHash, donorRefHash } = event.args

  const [attestationRow] = await context.db.sql
    .select({ uid: schema.attestation.uid })
    .from(schema.attestation)
    .where(
      and(
        eq(schema.attestation.txHash, event.transaction.hash),
        eq(schema.attestation.schemaName, 'FundingRecorded'),
      ),
    )
    .limit(1)

  await context.db.insert(schema.donation).values({
    id: eventId(event),
    needId,
    kind: 'OFFCHAIN',
    donor: null,
    donorRefHash,
    paymentRefHash,
    partner: provider,
    amount: net,
    gross,
    fee,
    currency: currencyLabel(currency as Hex),
    receiptId: null,
    attestationUID: attestationRow?.uid ?? null,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: seconds(event),
  })

  await context.db
    .update(schema.need, { id: needId })
    .set((row) => ({ totalDonated: row.totalDonated + net, fundingFees: row.fundingFees + fee }))

  await appendTimeline(context, event, {
    needId,
    type: 'FundingRecorded',
    data: {
      provider,
      gross: gross.toString(),
      fee: fee.toString(),
      net: net.toString(),
      currency: currencyLabel(currency as Hex),
      paymentRefHash,
      donorRefHash,
    },
    attestationUID: attestationRow?.uid ?? null,
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
    data: { donorRefHash, to, amount: amount.toString(), kind: 'FIAT' },
  })
})
