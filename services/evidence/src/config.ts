import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { chainFor, type NetworkName, resolveNetwork } from '@poa/shared'
import { config as loadDotenv } from 'dotenv'
import { z } from 'zod'

/**
 * Configuration for the evidence service.
 *
 * Everything has a development default so `pnpm --filter @poa/evidence dev` works on a fresh clone, but every
 * default that weakens security (an ephemeral session secret, an auto-created key file) is announced loudly at
 * boot rather than silently assumed.
 */

/** Walks up from the current directory to the workspace root so the repo-level `.env` is found from anywhere. */
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

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4001),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  POA_NETWORK: z.string().optional(),
  RPC_URL: z.string().optional(),
  SESSION_SECRET: z.string().min(16).optional(),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  SIWE_DOMAIN: z.string().optional(),
  CORS_ORIGIN: z.string().default('*'),
  NGO_KEK_PATH: z.string().default('./secrets/ngo-kek.key'),
  PINATA_JWT: z.string().optional(),
  PINATA_GATEWAY: z.string().default('https://gateway.pinata.cloud'),
  IPFS_LOCAL_DIR: z.string().optional(),
  /** Per-file ceiling; multipart uploads above it are rejected before anything is buffered. */
  MAX_FILE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),
  MAX_FILES: z.coerce.number().int().positive().default(12),
})

export interface EvidenceConfig {
  port: number
  host: string
  logLevel: (typeof LOG_LEVELS)[number]
  network: NetworkName
  chainId: number
  rpcUrl: string
  sessionSecret: string
  sessionSecretIsEphemeral: boolean
  sessionTtlSeconds: number
  siweDomain: string
  corsOrigin: string
  kekPath: string
  pinataJwt?: string
  pinataGateway: string
  ipfsDir: string
  maxFileBytes: number
  maxFiles: number
}

const randomSecret = (): string => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): EvidenceConfig => {
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${z.prettifyError(parsed.error)}`)
  }
  const value = parsed.data
  const network = resolveNetwork(value.POA_NETWORK)
  const chain = chainFor(network)
  return {
    port: value.PORT,
    host: value.HOST,
    logLevel: value.LOG_LEVEL,
    network,
    chainId: chain.id,
    rpcUrl: value.RPC_URL ?? chain.rpcUrls.default.http[0] ?? 'http://127.0.0.1:8545',
    sessionSecret: value.SESSION_SECRET ?? randomSecret(),
    sessionSecretIsEphemeral: value.SESSION_SECRET === undefined,
    sessionTtlSeconds: value.SESSION_TTL_SECONDS,
    siweDomain: value.SIWE_DOMAIN ?? `localhost:${value.PORT}`,
    corsOrigin: value.CORS_ORIGIN,
    kekPath: resolve(repoRoot, value.NGO_KEK_PATH),
    pinataJwt: value.PINATA_JWT || undefined,
    pinataGateway: value.PINATA_GATEWAY,
    ipfsDir: resolve(repoRoot, value.IPFS_LOCAL_DIR ?? '.data/ipfs'),
    maxFileBytes: value.MAX_FILE_BYTES,
    maxFiles: value.MAX_FILES,
  }
}
