import { type Context, ponder } from 'ponder:registry'
import schema from 'ponder:schema'
import { categoryLabel } from '@poa/shared'
import { and, eq, inArray } from 'ponder'
import type { Address, Hex } from 'viem'
import { type EventMeta, eventId, seconds } from './lib/timeline.js'

/**
 * Giving baskets and reward credit (v10). A basket gift reaches the vaults as ordinary donations through the factory
 * (`Ledger:DonatedVia`, written as CONVERTED rows by conversion.ts), and the factory's `BasketDonated`, emitted last
 * in the same transaction, says which of them were a basket's: those rows become BASKET, their timeline entries say
 * so, and the gift is recorded whole. Reward credit given away goes the same way, and `CommunityProofs:CreditGiven`,
 * emitted after it, then marks the rows REWARD and names the filer whose credit it was.
 *
 * A need's category is only in its creation event, so the contract cannot check that a basket's needs are of its
 * category; the indexer does. A part that went to a need of another category is still a donation, just not the
 * basket's: it counts for no basket.
 */

const NO_BASKET = `0x${'00'.repeat(32)}` as Hex

const partsOf = (needIds: readonly bigint[], amounts: readonly bigint[]) =>
  needIds.map((needId, i) => ({ needId: needId.toString(), amount: (amounts[i] ?? 0n).toString() }))

/** The donation rows the split wrote in this transaction for `donor`, one per need that took a part. */
const splitRows = async (context: Context, event: EventMeta, donor: Address, needIds: readonly bigint[]) =>
  context.db.sql
    .select()
    .from(schema.donation)
    .where(
      and(
        eq(schema.donation.txHash, event.transaction.hash),
        eq(schema.donation.donor, donor.toLowerCase() as Address),
        inArray(schema.donation.needId, [...needIds]),
      ),
    )

/** The basket a part counts for: the gift's basket when the need is of that category, else none. */
const basketFor = async (context: Context, needId: bigint, basket: Hex): Promise<Hex | null> => {
  if (basket === NO_BASKET) return null
  const need = await context.db.find(schema.need, { id: needId })
  return need?.category.toLowerCase() === basket.toLowerCase() ? basket : null
}

const isCommunityProofs = (context: Context, address: Address) =>
  address.toLowerCase() === (context.contracts.CommunityProofs.address as Address | undefined)?.toLowerCase()

ponder.on('DonationForwarderFactory:BasketDonated', async ({ event, context }) => {
  const { donor, basket, needIds, amounts, returned } = event.args
  for (const row of await splitRows(context, event, donor, needIds)) {
    if (row.kind !== 'CONVERTED' || row.tokenIn !== null) continue
    const counted = await basketFor(context, row.needId, basket)
    await context.db.update(schema.donation, { id: row.id }).set({ kind: 'BASKET', basket: counted })
    // The vault's donation took its place on the need's timeline under the same id; say what it was.
    await context.db.update(schema.timelineEvent, { id: row.id }).set((entry) => ({
      type: 'DonatedBasket',
      data: { ...(entry.data as Record<string, unknown>), basket: counted ? categoryLabel(counted) : null },
    }))
  }

  // Reward credit given away is recorded by `CreditGiven`, under the filer, not the contract.
  if (basket === NO_BASKET || isCommunityProofs(context, donor)) return
  await context.db.insert(schema.basketGift).values({
    id: eventId(event),
    basket,
    donor,
    fromCredit: false,
    total: amounts.reduce((sum, amount) => sum + amount, 0n) + returned,
    returned,
    parts: partsOf(needIds, amounts),
    txHash: event.transaction.hash,
    timestamp: seconds(event),
  })
})

ponder.on('CommunityProofs:CreditGiven', async ({ event, context }) => {
  const { validator, basket, needIds, amounts } = event.args
  const contract = context.contracts.CommunityProofs.address as Address
  for (const row of await splitRows(context, event, contract, needIds)) {
    if (row.kind !== 'BASKET') continue
    await context.db.update(schema.donation, { id: row.id }).set({ kind: 'REWARD', rewardFrom: validator })
    await context.db.update(schema.timelineEvent, { id: row.id }).set((entry) => ({
      type: 'DonatedReward',
      data: { ...(entry.data as Record<string, unknown>), rewardFrom: validator },
    }))
  }

  for (const [i, needId] of needIds.entries()) {
    const amount = amounts[i] ?? 0n
    if (amount === 0n) continue
    await context.db
      .insert(schema.creditGift)
      .values({
        id: `${needId}-${validator.toLowerCase()}`,
        needId,
        wallet: validator,
        given: amount,
        reclaimed: 0n,
        updatedAt: seconds(event),
      })
      .onConflictDoUpdate((row) => ({ given: row.given + amount, updatedAt: seconds(event) }))
  }

  if (basket === NO_BASKET) return
  await context.db.insert(schema.basketGift).values({
    id: eventId(event),
    basket,
    donor: validator,
    fromCredit: true,
    total: amounts.reduce((sum, amount) => sum + amount, 0n),
    // What no need could take stayed credit; it was never taken out of the wallet's balance.
    returned: 0n,
    parts: partsOf(needIds, amounts),
    txHash: event.transaction.hash,
    timestamp: seconds(event),
  })
})

ponder.on('CommunityProofs:CreditRefunded', async ({ event, context }) => {
  const { validator, needId, amount } = event.args
  const id = `${needId}-${validator.toLowerCase()}`
  if (await context.db.find(schema.creditGift, { id })) {
    await context.db
      .update(schema.creditGift, { id })
      .set((row) => ({ given: 0n, reclaimed: row.reclaimed + amount, updatedAt: seconds(event) }))
  }
  await context.db
    .insert(schema.timelineEvent)
    .values({
      id: eventId(event),
      needId,
      type: 'CreditReclaimed',
      data: { wallet: validator, amount: amount.toString() },
      attestationUID: null,
      txHash: event.transaction.hash,
      blockNumber: event.block.number,
      logIndex: event.log.logIndex,
      timestamp: seconds(event),
    })
    .onConflictDoNothing()
})
