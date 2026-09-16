import { prisma } from '@poa/shared/db'
import { createPublicClient, http } from 'viem'
import { type BankConfig, loadConfig } from '../../src/config.js'

/** Preconditions: the suites that need Postgres or a chain skip with a message instead of failing the run. */

export const RPC_URL = process.env.RPC_URL ?? process.env.ANVIL_RPC_URL ?? 'http://127.0.0.1:8545'

export const POSTGRES_SKIP =
  'Postgres is unreachable. Start it with `docker compose up -d postgres` and set DATABASE_URL.'
export const CHAIN_SKIP = `No anvil chain at ${RPC_URL}. Start it with \`pnpm chain\` and \`pnpm deploy:local\`.`

export const WEBHOOK_SECRET = 'test-webhook-secret'
export const REF_SALT = 'test-bank-ref-salt'
export const DEMO_MNEMONIC_ANVIL = 'test test test test test test test test test test test junk'

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

/**
 * Why the chain + database suites must skip, or null when both are reachable. Written to the raw stream: vitest
 * swallows `console` output produced while it is still collecting files, and a silent skip is indistinguishable
 * from a suite that never existed.
 */
export const suiteSkipReason = async (suite: string): Promise<string | null> => {
  const reason = !(await postgresAvailable()) ? POSTGRES_SKIP : !(await chainAvailable()) ? CHAIN_SKIP : null
  if (reason)
    process.stderr.write(`
[bank-connector:${suite}] SKIPPING chain + database tests: ${reason}

`)
  return reason
}

export const testConfig = (overrides: Partial<NodeJS.ProcessEnv> = {}): BankConfig =>
  loadConfig({
    ...process.env,
    POA_NETWORK: 'anvil',
    RPC_URL,
    // The service derives its partner wallet from DEMO_MNEMONIC. A repo .env configured for a public testnet
    // would point it at an address that holds no role on this chain, so pin both to the local seed.
    DEMO_MNEMONIC: DEMO_MNEMONIC_ANVIL,
    BANK_PARTNER_PRIVATE_KEY: '',
    LOG_LEVEL: 'silent',
    BANK_WEBHOOK_SECRET: WEBHOOK_SECRET,
    BANK_REF_SALT: REF_SALT,
    CHECKOUT_MOCK_ENABLED: 'true',
    CHECKOUT_RATE_LIMIT_PER_MINUTE: '1000',
    ...overrides,
  })
