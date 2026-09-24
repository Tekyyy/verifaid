import type { Hex } from 'viem'
import { categoryHash } from './format.js'

/**
 * Giving baskets: every need of a category that is raising money, given to in one gift and split equally by
 * `DonationForwarderFactory.donateEqually`. A basket is named by its category's hash, the same bytes32 a need's
 * category is committed as, so a basket gift and the needs it went to line up on chain.
 */

/** Mirrors `DonationForwarderFactory.MAX_BASKET_NEEDS`. */
export const MAX_BASKET_NEEDS = 25

export const basketId = (category: string): Hex => categoryHash(category)

/**
 * The split the contract will make, for showing it before signing: the needs with the least room are served
 * first, each gets the lesser of its room and an equal part of what is left, and rounding dust goes to the need
 * with the most room. Must match `_equalShares` exactly; a need with no room gets nothing.
 */
export const equalSplit = (
  total: bigint,
  rooms: readonly bigint[],
): { amounts: bigint[]; returned: bigint } => {
  const amounts = rooms.map(() => 0n)
  const order = rooms
    .map((room, index) => ({ room, index }))
    .filter((entry) => entry.room > 0n)
    // Stable on ties, like the contract, which keeps the first of equal rooms.
    .sort((a, b) => (a.room === b.room ? a.index - b.index : a.room < b.room ? -1 : 1))
  let remaining = total
  let left = BigInt(order.length)
  for (const { room, index } of order) {
    let part = remaining / left
    if (part > room) part = room
    amounts[index] = part
    remaining -= part
    left -= 1n
  }
  return { amounts, returned: remaining }
}
