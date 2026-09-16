import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { chainFor, type NetworkName, resolveNetwork } from '@poa/shared'
import { config as loadDotenv } from 'dotenv'
import { type Hex, isHex, keccak256, stringToHex } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { z } from 'zod'

/**
 * Configuration for the mock bank connector.
 *
 * Three secrets matter here and each fails differently when it is missing: without `BANK_WEBHOOK_SECRET` the
 * webhook is unauthenticated (dev only, announced loudly), without `BANK_REF_SALT` the payment reference hashes
 * are guessable, and without `BANK_PARTNER_PRIVATE_KEY` nothing can be deposited on-chain at all.
 */

const findRepoRoot = (start: string): string => {
  let dir = resolve(start)
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return resolve(start)
    dir = parent
  }
}

export const repoRoot = findRepoRoot(process.cwd())
loadDotenv({ path: join(repoRoot, '.env'), quiet: true })

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const

/** Anvil's well-known mnemonic; index 6 is the bank partner registered by `SeedDemo.s.sol`. */
const DEV_MNEMONIC = 'test test test test test test test test test test test junk'
const BANK_PARTNER_INDEX = 6
const DEV_SALT_SEED = 'poa-dev-bank-ref-salt'

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4003),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  POA_NETWORK: z.string().optional(),
  RPC_URL: z.string().optional(),
  CORS_ORIGIN: z.string().default('*'),
  BANK_PARTNER_PRIVATE_KEY: z.string().optional(),
  DEMO_MNEMONIC: z.string().optional(),
  BANK_REF_SALT: z.string().optional(),
  BANK_WEBHOOK_SECRET: z.string().optional(),
})

export interface BankConfig {
  port: number
  host: string
  logLevel: (typeof LOG_LEVELS)[number]
  network: NetworkName
  chainId: number
  rpcUrl: string
  corsOrigin: string
  partnerPrivateKey: Hex
  partnerKeyIsDevDefault: boolean
  /** bytes32 salt; `paymentRefHash = keccak256(abi.encode(salt, reference))`. Never leaves this process. */
  refSalt: Hex
  refSaltIsDevDefault: boolean
  webhookSecret?: string
}

/** Accepts a 32-byte hex salt as-is, or derives one deterministically from any passphrase. */
const toSalt = (value: string): Hex =>
  isHex(value) && value.length === 66 ? (value.toLowerCase() as Hex) : keccak256(stringToHex(value))

/** The seeded bank partner on a local chain, so the demo runs without a key in the environment. */
const devPartnerKey = (mnemonic: string): Hex => {
  const key = mnemonicToAccount(mnemonic, { addressIndex: BANK_PARTNER_INDEX }).getHdKey().privateKey
  if (!key) throw new Error('Could not derive the development bank partner key from the mnemonic')
  return `0x${Buffer.from(key).toString('hex')}`
}

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): BankConfig => {
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success) throw new Error(`Invalid environment: ${z.prettifyError(parsed.error)}`)
  const value = parsed.data
  const network = resolveNetwork(value.POA_NETWORK)
  const chain = chainFor(network)

  const configuredKey = value.BANK_PARTNER_PRIVATE_KEY?.trim()
  const partnerPrivateKey = configuredKey
    ? ((configuredKey.startsWith('0x') ? configuredKey : `0x${configuredKey}`) as Hex)
    : devPartnerKey(value.DEMO_MNEMONIC || DEV_MNEMONIC)

  return {
    port: value.PORT,
    host: value.HOST,
    logLevel: value.LOG_LEVEL,
    network,
    chainId: chain.id,
    rpcUrl: value.RPC_URL ?? chain.rpcUrls.default.http[0] ?? 'http://127.0.0.1:8545',
    corsOrigin: value.CORS_ORIGIN,
    partnerPrivateKey,
    partnerKeyIsDevDefault: !configuredKey,
    refSalt: toSalt(value.BANK_REF_SALT?.trim() || DEV_SALT_SEED),
    refSaltIsDevDefault: !value.BANK_REF_SALT?.trim(),
    webhookSecret: value.BANK_WEBHOOK_SECRET?.trim() || undefined,
  }
}
