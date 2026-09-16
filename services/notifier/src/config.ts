import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { config as loadDotenv } from 'dotenv'
import { z } from 'zod'

/**
 * Configuration for the notifier.
 *
 * Two things decide how much this service can hurt someone when misconfigured. The key-encryption key protects
 * every stored email address: without `NOTIFIER_KEK` a key file is created on first run (and announced, because
 * losing it makes every address unreadable). `NODE_ENV=production` turns on the SSRF guard for webhook URLs: plain
 * http and private or link-local IP literals are refused, so a subscriber cannot aim the worker at the internal
 * network.
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

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4004),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  NODE_ENV: z.string().optional(),
  CORS_ORIGIN: z.string().default('*'),
  INDEXER_URL: z.url().default('http://localhost:42069'),
  INDEXER_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  /** The dashboard, for tracking links in alerts. */
  APP_BASE_URL: z.url().default('http://localhost:3000'),
  /** Where this service is reachable from a subscriber's mail client, for unsubscribe links. */
  PUBLIC_BASE_URL: z.url().optional(),
  /** 32-byte hex key. Takes precedence over the key file. */
  NOTIFIER_KEK: z.string().optional(),
  NOTIFIER_KEK_PATH: z.string().default('./secrets/notifier-kek.key'),
  NOTIFIER_ADMIN_TOKEN: z.string().min(16, 'must be at least 16 characters').optional(),
  NOTIFIER_WORKER: z.enum(['on', 'off', 'true', 'false', '1', '0']).default('on'),
  NOTIFIER_POLL_MS: z.coerce.number().int().min(250).default(10_000),
  NOTIFIER_WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  EMAIL_API_URL: z.url().optional(),
  EMAIL_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('Proof of Aid <alerts@proof-of-aid.local>'),
})

export interface NotifierConfig {
  port: number
  host: string
  logLevel: (typeof LOG_LEVELS)[number]
  /** `NODE_ENV=production`: webhook URLs must be https to a public address. */
  production: boolean
  corsOrigin: string
  indexerUrl: string
  indexerTimeoutMs: number
  appBaseUrl: string
  publicBaseUrl: string
  publicBaseUrlIsDefault: boolean
  kekHex?: string
  kekPath: string
  /** Unset ⇒ the admin API answers 503. */
  adminToken?: string
  workerEnabled: boolean
  pollMs: number
  webhookTimeoutMs: number
  email: {
    /** Both set ⇒ the Resend-compatible API driver; otherwise the outbox driver. */
    apiUrl?: string
    apiKey?: string
    from: string
  }
}

const trimSlash = (url: string): string => url.replace(/\/+$/, '')

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): NotifierConfig => {
  // Compose passes unset variables as empty strings; treat those as absent so the defaults apply.
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value?.trim()))
  const parsed = EnvSchema.safeParse(present)
  if (!parsed.success) throw new Error(`Invalid environment: ${z.prettifyError(parsed.error)}`)
  const value = parsed.data

  return {
    port: value.PORT,
    host: value.HOST,
    logLevel: value.LOG_LEVEL,
    production: value.NODE_ENV === 'production',
    corsOrigin: value.CORS_ORIGIN,
    indexerUrl: trimSlash(value.INDEXER_URL),
    indexerTimeoutMs: value.INDEXER_TIMEOUT_MS,
    appBaseUrl: trimSlash(value.APP_BASE_URL),
    publicBaseUrl: trimSlash(value.PUBLIC_BASE_URL ?? `http://localhost:${value.PORT}`),
    publicBaseUrlIsDefault: value.PUBLIC_BASE_URL === undefined,
    kekHex: value.NOTIFIER_KEK?.trim(),
    kekPath: resolve(repoRoot, value.NOTIFIER_KEK_PATH),
    adminToken: value.NOTIFIER_ADMIN_TOKEN?.trim(),
    workerEnabled: !['off', 'false', '0'].includes(value.NOTIFIER_WORKER),
    pollMs: value.NOTIFIER_POLL_MS,
    webhookTimeoutMs: value.NOTIFIER_WEBHOOK_TIMEOUT_MS,
    email: {
      apiUrl: value.EMAIL_API_URL,
      apiKey: value.EMAIL_API_KEY?.trim(),
      from: value.EMAIL_FROM,
    },
  }
}
