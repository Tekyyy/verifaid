import { ponder } from 'ponder:registry'
import schema from 'ponder:schema'

/** The factory is also the source of the dynamic `Ledger` address set (see `factory()` in ponder.config.ts). */
ponder.on('AidVaultFactory:VaultCreated', async ({ event, context }) => {
  await context.db.update(schema.need, { id: event.args.needId }).set({ vault: event.args.vault })
})
