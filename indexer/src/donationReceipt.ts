import { ponder } from 'ponder:registry'
import schema from 'ponder:schema'
import { zeroAddress } from 'viem'

/**
 * Receipts are soulbound (ERC-5192) and are minted only from a vault's `donate`, so the `receipt` row is
 * built from `AidVault:Donated`, which carries the need, the donor and the amount in one event.
 *
 * This handler exists to keep the ownership column honest: a transfer between two non-zero addresses is
 * supposed to be impossible, so if one ever appeared the dashboard would show it instead of silently lying.
 * `Locked`, `Approval` and `ApprovalForAll` are not indexed — the first is constant, the other two revert.
 */
ponder.on('DonationReceipt:Transfer', async ({ event, context }) => {
  const { from, to, tokenId } = event.args
  if (from === zeroAddress) return // mint; the row is written by AidVault:Donated in the same transaction

  const existing = await context.db.find(schema.receipt, { id: tokenId })
  if (!existing) return
  await context.db.update(schema.receipt, { id: tokenId }).set({ owner: to })
})
