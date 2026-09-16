import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@poa/shared/db'
import { createPublicClient, http } from 'viem'
import { loadConfig, type VaultConfig } from '../../src/config.js'

/** Preconditions: the suites that need Postgres or a chain skip with a message instead of failing the run. */

export const RPC_URL = process.env.RPC_URL ?? process.env.ANVIL_RPC_URL ?? 'http://127.0.0.1:8545'

export const POSTGRES_SKIP =
  'Postgres is unreachable. Start it with `docker compose up -d postgres` and set DATABASE_URL.'
export const CHAIN_SKIP = `No anvil chain at ${RPC_URL}. Start it with \`pnpm chain\` and \`pnpm deploy:local\`.`

export const postgresAvailable = async (): Promise<boolean> => {
  try {
    await prisma().$queryRaw`select 1`
    return true
  } catch {
    return false
  }
}

export const chainAvailable = async (): Promise<boolean> => {
  try {
    const client = createPublicClient({ transport: http(RPC_URL) })
    return (await client.getChainId()) > 0
  } catch {
    return false
  }
}

/** A config whose master key lives in a throwaway directory, so a test run never touches the real KEK. */
export const testConfig = (overrides: Partial<NodeJS.ProcessEnv> = {}): VaultConfig => {
  const scratch = mkdtempSync(join(tmpdir(), 'poa-vault-'))
  return loadConfig({
    ...process.env,
    POA_NETWORK: 'anvil',
    RPC_URL,
    SESSION_SECRET: 'test-session-secret-0123456789',
    LOG_LEVEL: 'silent',
    NGO_KEK_PATH: join(scratch, 'ngo-kek.key'),
    ...overrides,
  })
}
