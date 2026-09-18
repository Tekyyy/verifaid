import { type Context, ponder } from 'ponder:registry'
import schema from 'ponder:schema'
import { eq } from 'ponder'
import type { Address, Hex } from 'viem'
import { appendTimeline, type EventMeta, eventId, seconds } from './lib/timeline.js'

/**
 * v4 payment plans. A vault pays each released tranche straight to the payees its need committed to; every payment
 * (or payment the token refused, held for its payee) is recorded against the plan, so a donor can see which
 * supplier their money reached. Supplier replacements are tracked from proposal to approval.
 */

type PayeeRow = typeof schema.payee.$inferSelect

/**
 * The plan entry an address is paid as: the supplier itself, or the NGO's own share when the address is the NGO's
 * payout Safe. Null when the address is in the plan no longer (a supplier replaced after its payment was held).
 */
const planEntryOf = async (
  context: Context,
  needId: bigint,
  account: Address,
): Promise<{ row: PayeeRow | undefined; toNgo: boolean }> => {
  const rows = await context.db.sql.select().from(schema.payee).where(eq(schema.payee.needId, needId))
  const supplierRow = rows.find((row) => row.account?.toLowerCase() === account.toLowerCase())
  if (supplierRow) return { row: supplierRow, toNgo: false }

  const need = await context.db.find(schema.need, { id: needId })
  const ngo = need ? await context.db.find(schema.ngo, { address: need.ngo as Address }) : null
  if (ngo && ngo.payout.toLowerCase() === account.toLowerCase()) {
    return { row: rows.find((row) => row.account === null), toNgo: true }
  }
  return { row: undefined, toNgo: false }
}

const recordPayment = async (
  context: Context,
  event: EventMeta,
  args: { needId: bigint; index: bigint; payee: Address; amount: bigint },
  held: boolean,
) => {
  const { needId, payee, amount } = args
  const trancheIndex = Number(args.index)
  const { row, toNgo } = await planEntryOf(context, needId, payee)

  await context.db.insert(schema.payeePayment).values({
    id: eventId(event),
    needId,
    trancheIndex,
    payee,
    payeeIndex: row?.index ?? null,
    toNgo,
    amount,
    held,
    txHash: event.transaction.hash,
    timestamp: seconds(event),
  })

  if (row) {
    await context.db
      .update(schema.payee, { needId, index: row.index })
      .set((current) =>
        held ? { held: current.held + amount } : { paid: current.paid + amount },
      )
  }
  if (!held && !toNgo) await creditSupplier(context, payee, amount)

  await appendTimeline(context, event, {
    needId,
    type: held ? 'PaymentHeld' : 'PayeePaid',
    data: {
      trancheIndex,
      payee,
      label: row?.label ?? null,
      toNgo,
      amount: amount.toString(),
    },
  })
}

const creditSupplier = async (context: Context, account: Address, amount: bigint) => {
  const existing = await context.db.find(schema.supplier, { address: account })
  if (!existing) return
  await context.db
    .update(schema.supplier, { address: account })
    .set((current) => ({ totalPaid: current.totalPaid + amount }))
}

ponder.on('Ledger:PayeePaid', async ({ event, context }) => {
  await recordPayment(context, event, event.args, false)
})

ponder.on('Ledger:PaymentHeld', async ({ event, context }) => {
  await recordPayment(context, event, event.args, true)
})

ponder.on('Ledger:HeldPaymentClaimed', async ({ event, context }) => {
  const { needId, payee, amount } = event.args
  const { row, toNgo } = await planEntryOf(context, needId, payee)
  if (row) {
    await context.db
      .update(schema.payee, { needId, index: row.index })
      .set((current) => ({ held: current.held - amount, paid: current.paid + amount }))
  }
  if (!toNgo) await creditSupplier(context, payee, amount)
  await appendTimeline(context, event, {
    needId,
    type: 'HeldPaymentClaimed',
    data: { payee, label: row?.label ?? null, amount: amount.toString() },
  })
})

// ─── supplier replacements ───────────────────────────────────────────────────

ponder.on('NeedsRegistry:PayeeChangeProposed', async ({ event, context }) => {
  const { needId, changeId, index, from, to, refHash, label } = event.args
  await context.db.insert(schema.payeeChange).values({
    changeId,
    needId,
    index: Number(index),
    from,
    to,
    label,
    refHash,
    approvals: 0,
    approvedBy: [],
    status: 'PENDING',
    proposedAt: seconds(event),
    resolvedAt: null,
  })
  await appendTimeline(context, event, {
    needId,
    type: 'PayeeChangeProposed',
    data: { changeId: changeId.toString(), index: Number(index), from, to, label },
  })
})

ponder.on('NeedsRegistry:PayeeChangeApproved', async ({ event, context }) => {
  const { needId, changeId, verifier, approvals } = event.args
  await context.db.update(schema.payeeChange, { changeId }).set((current) => ({
    approvals: Number(approvals),
    approvedBy: [...(current.approvedBy as Address[]), verifier],
  }))
  await appendTimeline(context, event, {
    needId,
    type: 'PayeeChangeApproved',
    data: { changeId: changeId.toString(), verifier, approvals: Number(approvals) },
  })
})

ponder.on('NeedsRegistry:PayeeChanged', async ({ event, context }) => {
  const { needId, changeId, index, from, to } = event.args
  const change = await context.db.find(schema.payeeChange, { changeId })
  await context.db.update(schema.payee, { needId, index: Number(index) }).set({
    account: to,
    ...(change ? { label: change.label, refHash: change.refHash as Hex } : {}),
  })
  await context.db
    .update(schema.payeeChange, { changeId })
    .set({ status: 'APPLIED', resolvedAt: seconds(event) })
  await appendTimeline(context, event, {
    needId,
    type: 'PayeeChanged',
    data: { changeId: changeId.toString(), index: Number(index), from, to, label: change?.label ?? null },
  })
})

ponder.on('NeedsRegistry:PayeeChangeCancelled', async ({ event, context }) => {
  const { needId, changeId } = event.args
  await context.db
    .update(schema.payeeChange, { changeId })
    .set({ status: 'CANCELLED', resolvedAt: seconds(event) })
  await appendTimeline(context, event, {
    needId,
    type: 'PayeeChangeCancelled',
    data: { changeId: changeId.toString() },
  })
})
