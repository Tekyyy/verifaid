import { ponder } from 'ponder:registry'
import schema from 'ponder:schema'
import { seconds } from './lib/timeline.js'

/**
 * Who is allowed to act, and whether the system is paused. Nothing here is need-scoped, so none of it writes
 * to the timeline. `RoleGranted`/`RoleRevoked`/`RoleAdminChanged` are deliberately not indexed: they are the
 * OpenZeppelin plumbing behind the registration events above, and would double-count every role change.
 */

ponder.on('RoleRegistry:NgoRegistered', async ({ event, context }) => {
  await context.db.insert(schema.ngo).values({
    address: event.args.ngo,
    payout: event.args.payoutAddress,
    credentialHash: event.args.credentialHash,
    metadataURI: event.args.metadataURI,
    active: true,
    registeredAt: seconds(event),
  })
})

ponder.on('RoleRegistry:NgoStatusChanged', async ({ event, context }) => {
  await context.db.update(schema.ngo, { address: event.args.ngo }).set({ active: event.args.active })
})

ponder.on('RoleRegistry:VerifierRegistered', async ({ event, context }) => {
  await context.db
    .insert(schema.roleAccount)
    .values({
      address: event.args.verifier,
      role: 'VERIFIER',
      ngo: null,
      active: true,
      registeredAt: seconds(event),
    })
    .onConflictDoUpdate({ active: true })
})

ponder.on('RoleRegistry:VerifierRemoved', async ({ event, context }) => {
  await context.db.update(schema.roleAccount, { address: event.args.verifier }).set({ active: false })
})

ponder.on('RoleRegistry:SupplierRegistered', async ({ event, context }) => {
  const { supplier, credentialHash, metadataURI } = event.args
  await context.db
    .insert(schema.supplier)
    .values({
      address: supplier,
      credentialHash,
      metadataURI,
      active: true,
      registeredAt: seconds(event),
      totalPaid: 0n,
    })
    .onConflictDoUpdate({ credentialHash, metadataURI, active: true })
  await context.db
    .insert(schema.roleAccount)
    .values({ address: supplier, role: 'SUPPLIER', ngo: null, active: true, registeredAt: seconds(event) })
    .onConflictDoUpdate({ active: true })
})

ponder.on('RoleRegistry:SupplierRemoved', async ({ event, context }) => {
  await context.db.update(schema.supplier, { address: event.args.supplier }).set({ active: false })
  await context.db.update(schema.roleAccount, { address: event.args.supplier }).set({ active: false })
})

ponder.on('RoleRegistry:Paused', async ({ event, context }) => {
  await context.db
    .insert(schema.systemState)
    .values({ chainId: context.chain.id, paused: true, updatedAt: seconds(event) })
    .onConflictDoUpdate({ paused: true, updatedAt: seconds(event) })
})

ponder.on('RoleRegistry:Unpaused', async ({ event, context }) => {
  await context.db
    .insert(schema.systemState)
    .values({ chainId: context.chain.id, paused: false, updatedAt: seconds(event) })
    .onConflictDoUpdate({ paused: false, updatedAt: seconds(event) })
})
