import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@poa/shared/db'
import { createPublicClient, http } from 'viem'
import { type EvidenceConfig, loadConfig } from '../../src/config.js'

/**
 * Preconditions for the integration tests. Postgres and anvil are external, so each is probed once and the
 * suites that need them skip with a message instead of failing the whole `pnpm test` run.
 */

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

/** A config that keeps every test artefact (key file, mock IPFS blobs) in a throwaway directory. */
export const testConfig = (overrides: Partial<NodeJS.ProcessEnv> = {}): EvidenceConfig => {
  const scratch = mkdtempSync(join(tmpdir(), 'poa-evidence-'))
  return loadConfig({
    ...process.env,
    POA_NETWORK: 'anvil',
    RPC_URL,
    SESSION_SECRET: 'test-session-secret-0123456789',
    LOG_LEVEL: 'silent',
    NGO_KEK_PATH: join(scratch, 'ngo-kek.key'),
    IPFS_LOCAL_DIR: join(scratch, 'ipfs'),
    PINATA_JWT: '',
    ...overrides,
  })
}
