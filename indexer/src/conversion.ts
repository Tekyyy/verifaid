import { type Context, ponder } from 'ponder:registry'
import schema from 'ponder:schema'
import { depositRefHash, getDeployment, resolveNetwork, tokenSymbolOf } from '@poa/shared'
import { and, eq, isNull } from 'ponder'
import { type Address, zeroAddress } from 'viem'
import { appendTimeline, type EventMeta, eventId, seconds } from './lib/timeline.js'

/**
 * v3 conversions. A converted donation shows up as two events in one transaction, always in this order:
 *
 *   1. `Ledger:DonatedVia` from the vault: what was deposited, who is credited, the conversion fee.
 *   2. `DonatedWithConversion` from the factory (a wallet gave USDC or ETH) or `Swept` from a deposit address:
 *      the token given, how much, what the swap produced and what Chainlink said it was worth.
 *
 * The first writes the donation row, moves the need's totals and takes the donation's place on the timeline (before
 * any FundingClosed it triggers); the second fills in what the swap did, on both rows.
 */

const deployment = getDeployment(resolveNetwork(process.env.PONDER_NETWORK ?? 'anvil'))
const factoryAddress = deployment.contracts.DonationForwarderFactory?.toLowerCase()

const orNull = (address: Address): Address | null => (address === zeroAddress ? null : address)

const logIndexOf = (id: string): number => Number(id.slice(id.lastIndexOf('-') + 1))

/**
 * The donation row step 1 wrote for the swap event being handled: same transaction, same wallet or deposit
 * address, not yet completed, and the closest one before this log (a batched wallet call can donate twice).
 */
const pendingConversion = async (context: Context, event: EventMeta, via: Address) => {
  const rows = await context.db.sql
    .select()
    .from(schema.donation)
    .where(
      and(
        eq(schema.donation.txHash, event.transaction.hash),
        eq(schema.donation.via, via.toLowerCase() as Address),
        eq(schema.donation.kind, 'CONVERTED'),
        isNull(schema.donation.tokenIn),
      ),
    )
  return rows
    .filter((row) => logIndexOf(row.id) < event.log.logIndex)
    .sort((a, b) => logIndexOf(b.id) - logIndexOf(a.id))[0]
}

ponder.on('Ledger:DonatedVia', async ({ event, context }) => {
  const { needId, forwarder, receiptTo, amount, conversionFee, receiptId } = event.args
  const id = eventId(event)
  // The factory credits the wallet that called it; a deposit address credits its receiptTo, or itself.
  const fromWallet = forwarder.toLowerCase() === factoryAddress
  const credited = receiptTo !== zeroAddress

  await context.db.insert(schema.donation).values({
    id,
    needId,
    kind: 'CONVERTED',
    donor: credited ? receiptTo : null,
    donorRefHash: credited ? null : depositRefHash(forwarder),
    paymentRefHash: null,
    partner: null,
    amount,
    gross: null,
    fee: null,
    currency: null,
    receiptId: credited ? receiptId : null,
    attestationUID: null,
    via: fromWallet ? receiptTo : forwarder,
    viaDepositAddress: !fromWallet,
    conversionFee,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: seconds(event),
  })

  if (credited) {
    await context.db
      .insert(schema.receipt)
      .values({
        id: receiptId,
        needId,
        owner: receiptTo,
        amount,
        donationId: id,
        mintedAt: seconds(event),
        txHash: event.transaction.hash,
      })
      .onConflictDoUpdate({ needId, amount, donationId: id })
  }

  // The resolver adds the conversion fee to the need's funding fees, against the disclosed cost cap.
  await context.db
    .update(schema.need, { id: needId })
    .set((row) => ({ totalDonated: row.totalDonated + amount, fundingFees: row.fundingFees + conversionFee }))

  await appendTimeline(context, event, {
    needId,
    type: 'DonatedConverted',
    data: conversionTimelineData({
      donor: credited ? receiptTo : null,
      depositAddress: fromWallet ? null : forwarder,
      amount,
      conversionFee,
      receiptId: credited ? receiptId : null,
    }),
  })
})

/** Timeline payload of a converted donation; the swap fields stay null until the swap event fills them in. */
const conversionTimelineData = (args: {
  donor: Address | null
  depositAddress: Address | null
  amount: bigint
  conversionFee: bigint
  receiptId: bigint | null
  swap?: { tokenIn: Address; amountIn: bigint; converted: bigint; fairValue: bigint }
}) => ({
  donor: args.donor,
  depositAddress: args.depositAddress,
  tokenIn: args.swap?.tokenIn ?? null,
  tokenInSymbol: args.swap ? tokenSymbolOf(deployment, args.swap.tokenIn) : null,
  amountIn: args.swap?.amountIn.toString() ?? null,
  converted: args.swap?.converted.toString() ?? null,
  fairValue: args.swap?.fairValue.toString() ?? null,
  amount: args.amount.toString(),
  conversionFee: args.conversionFee.toString(),
  receiptId: args.receiptId?.toString() ?? null,
})

const completeConversion = async (
  context: Context,
  event: EventMeta,
  args: {
    via: Address
    viaDepositAddress: boolean
    tokenIn: Address
    amountIn: bigint
    converted: bigint
    fairValue: bigint
  },
) => {
  const row = await pendingConversion(context, event, args.via)
  if (!row) return

  await context.db.update(schema.donation, { id: row.id }).set({
    tokenIn: args.tokenIn,
    amountIn: args.amountIn,
    converted: args.converted,
    fairValue: args.fairValue,
  })

  // Same id as the donation row: both were written from the vault's DonatedVia log.
  await context.db.update(schema.timelineEvent, { id: row.id }).set({
    data: conversionTimelineData({
      donor: (row.donor as Address | null) ?? null,
      depositAddress: args.viaDepositAddress ? args.via : null,
      amount: row.amount,
      conversionFee: row.conversionFee ?? 0n,
      receiptId: row.receiptId,
      swap: {
        tokenIn: args.tokenIn,
        amountIn: args.amountIn,
        converted: args.converted,
        fairValue: args.fairValue,
      },
    }),
  })
}

ponder.on('DonationForwarderFactory:DonatedWithConversion', async ({ event, context }) => {
  const { donor, tokenIn, amountIn, converted, fairValue } = event.args
  await completeConversion(context, event, {
    via: donor,
    viaDepositAddress: false,
    tokenIn,
    amountIn,
    converted,
    fairValue,
  })
})

ponder.on('DonationForwarderFactory:ForwarderDeployed', async ({ event, context }) => {
  const { forwarder, needId, receiptTo, refundTo, refundSigner, salt } = event.args
  await context.db
    .insert(schema.depositAddress)
    .values({
      address: forwarder,
      needId,
      receiptTo: orNull(receiptTo),
      refundTo: orNull(refundTo),
      refundSigner: orNull(refundSigner),
      salt,
      deployedAt: seconds(event),
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing()
})

ponder.on('DonationForwarder:Swept', async ({ event, context }) => {
  const { tokenIn, amountIn, converted, fairValue } = event.args
  await completeConversion(context, event, {
    via: event.log.address,
    viaDepositAddress: true,
    tokenIn,
    amountIn,
    converted,
    fairValue,
  })
})

ponder.on('DonationForwarder:LeftoverRefunded', async ({ event, context }) => {
  const { token, to, amount } = event.args
  await context.db.insert(schema.depositRefund).values({
    id: eventId(event),
    depositAddress: event.log.address,
    kind: 'LEFTOVER',
    token,
    to,
    amount,
    txHash: event.transaction.hash,
    timestamp: seconds(event),
  })
})

/** The vault's own `RefundedByRef` in the same transaction updates the need; this links it to the deposit address. */
ponder.on('DonationForwarder:VaultRefundClaimed', async ({ event, context }) => {
  const { to, amount } = event.args
  await context.db.insert(schema.depositRefund).values({
    id: eventId(event),
    depositAddress: event.log.address,
    kind: 'VAULT',
    token: deployment.external.Token,
    to,
    amount,
    txHash: event.transaction.hash,
    timestamp: seconds(event),
  })
})
