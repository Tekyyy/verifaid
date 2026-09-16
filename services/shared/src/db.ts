// Node-only entry point: `import { prisma } from '@poa/shared/db'`.
// Kept out of the root barrel so browser bundles (the Next.js app) never pull Prisma in.
import { PrismaClient } from '../generated/prisma/index.js'

export * from '../generated/prisma/index.js'

let client: PrismaClient | undefined

/**
 * Lazily created singleton, so importing this module never opens a connection and tests can point
 * DATABASE_URL at a scratch database before the first query.
 */
export const prisma = (): PrismaClient => {
  if (!client) {
    client = new PrismaClient({
      // Request bodies can contain personal data, so only errors and warnings are logged — never queries.
      log: ['error', 'warn'],
    })
  }
  return client
}

export const disconnect = async (): Promise<void> => {
  await client?.$disconnect()
  client = undefined
}
