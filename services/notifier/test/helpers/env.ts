import { randomBytes } from 'node:crypto'
import { prisma } from '@poa/shared/db'
import { loadConfig, type NotifierConfig } from '../../src/config.js'

/** Preconditions: the suites that need Postgres skip with a message instead of failing the run. */

export const POSTGRES_SKIP =
  'Postgres is unreachable. Start it with `docker compose up -d postgres`, set DATABASE_URL and run `pnpm db:push`.'

export const ADMIN_TOKEN = 'test-admin-token-0123456789'
export const APP_BASE_URL = 'https://app.example'
export const PUBLIC_BASE_URL = 'https://notifier.example'

/** One random KEK per test process: nothing a test seals can be opened with a real key, or vice versa. */
export const TEST_KEK = randomBytes(32).toString('hex')

export const postgresAvailable = async (): Promise<boolean> => {
  try {
    await prisma().$queryRaw`select 1`
    // The notifier tables exist only after `pnpm db:push` with the current schema.
    await prisma().notifierCursor.count()
    return true
  } catch {
    return false
  }
}

export const testConfig = (overrides: Partial<NodeJS.ProcessEnv> = {}): NotifierConfig =>
  loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    NOTIFIER_KEK: TEST_KEK,
    NOTIFIER_ADMIN_TOKEN: ADMIN_TOKEN,
    NOTIFIER_WORKER: 'off',
    NOTIFIER_WEBHOOK_TIMEOUT_MS: '3000',
    APP_BASE_URL,
    PUBLIC_BASE_URL,
    EMAIL_API_URL: '',
    EMAIL_API_KEY: '',
    ...overrides,
  })

export const adminHeaders = (token = ADMIN_TOKEN): Record<string, string> => ({
  authorization: `Bearer ${token}`,
})

/**
 * The integration suite owns the notifier tables for its duration. Refuses to wipe anything but a local database,
 * so pointing DATABASE_URL at a shared one cannot destroy real subscriptions.
 */
export const resetNotifierTables = async (): Promise<void> => {
  const host = new URL(process.env.DATABASE_URL ?? 'postgresql://unknown').hostname
  if (!['localhost', '127.0.0.1', '::1', '[::1]', 'postgres'].includes(host)) {
    throw new Error(`refusing to reset notifier tables on non-local database host "${host}"`)
  }
  const db = prisma()
  await db.notificationDelivery.deleteMany({})
  await db.webhookEndpoint.deleteMany({})
  await db.alertSubscription.deleteMany({})
  await db.notifierCursor.deleteMany({})
}
