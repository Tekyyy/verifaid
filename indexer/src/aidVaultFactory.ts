import { ponder } from 'ponder:registry'
import schema from 'ponder:schema'

/**
 * The factory is also the source of the dynamic `AidVault` address set (see `factory()` in ponder.config.ts).
 *
 * `PaymentRefConsumed` is not indexed: it is the global replay guard for a bank reference, and the same
 * `paymentRefHash` is already recorded on the fiat `donation` row it guards.
 */
ponder.on('AidVaultFactory:VaultCreated', async ({ event, context }) => {
  await context.db.update(schema.need, { id: event.args.needId }).set({ vault: event.args.vault })
})
