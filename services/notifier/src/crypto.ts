import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { deriveKey, hmac, open, openEnvelope, parseKey, safeEqual, seal, sealEnvelope } from '@poa/shared'
import type { NotifierConfig } from './config.js'

/**
 * Thin wrappers over `@poa/shared` crypto, one HKDF context per purpose so no key can be used for another job:
 *
 *   notifier:email                email addresses, envelope-encrypted (a fresh data key per subscription)
 *   notifier:webhook-secret       integrator signing secrets, sealed at rest
 *   notifier:alert-webhook        per-subscription signing secrets for alert webhooks (derived, never stored)
 *   notifier:unsubscribe-link     the token in email unsubscribe links (derived, never stored)
 *
 * Every sealed value is bound to its row id as AES-GCM additional data, so a ciphertext copied onto another row
 * does not decrypt.
 */

const EMAIL_CONTEXT = 'notifier:email'
const WEBHOOK_SECRET_CONTEXT = 'notifier:webhook-secret'
const ALERT_WEBHOOK_CONTEXT = 'notifier:alert-webhook'
const UNSUBSCRIBE_LINK_CONTEXT = 'notifier:unsubscribe-link'

export type KekSource = 'env' | 'file' | 'file-created'

/** The master key: `NOTIFIER_KEK` if set, else the key file, created on first run (like the PII vault's). */
export const loadKek = (
  config: Pick<NotifierConfig, 'kekHex' | 'kekPath'>,
): { key: Buffer; source: KekSource } => {
  if (config.kekHex) return { key: parseKey(config.kekHex), source: 'env' }
  if (existsSync(config.kekPath)) {
    return { key: parseKey(readFileSync(config.kekPath, 'utf8')), source: 'file' }
  }
  mkdirSync(dirname(config.kekPath), { recursive: true })
  writeFileSync(config.kekPath, `${randomBytes(32).toString('hex')}\n`, { encoding: 'utf8', mode: 0o600 })
  return { key: parseKey(readFileSync(config.kekPath, 'utf8')), source: 'file-created' }
}

const sha256Hex = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

/** 32 random bytes, base64url. Returned once; only its sha256 is stored. */
export const newUnsubscribeToken = (): string => randomBytes(32).toString('base64url')

export const hashToken = (token: string): string => sha256Hex(token)

/** The unsubscribe token for email links, recomputed at send time so it never has to be stored. */
export const unsubscribeLinkToken = (kek: Buffer, subscriptionId: string): string =>
  hmac(deriveKey(kek, UNSUBSCRIBE_LINK_CONTEXT), subscriptionId).toString('base64url')

/** Accepts the subscriber's own token (hash compared) or the derived email-link token, in constant time. */
export const subscriptionTokenMatches = (
  kek: Buffer,
  subscription: { id: string; tokenHash: string },
  presented: string,
): boolean => {
  const ownToken = safeEqual(hashToken(presented), subscription.tokenHash)
  const linkToken = safeEqual(presented, unsubscribeLinkToken(kek, subscription.id))
  return ownToken || linkToken
}

/** Constant-time bearer check that does not leak the configured token's length. */
export const adminTokenMatches = (configured: string, presented: string): boolean =>
  safeEqual(sha256Hex(presented), sha256Hex(configured))

export const sealEmail = (
  kek: Buffer,
  subscriptionId: string,
  email: string,
): { emailCiphertext: Uint8Array<ArrayBuffer>; wrappedDek: Uint8Array<ArrayBuffer> } => {
  const { box, wrappedDek } = sealEnvelope(
    kek,
    EMAIL_CONTEXT,
    Buffer.from(email, 'utf8'),
    Buffer.from(subscriptionId, 'utf8'),
  )
  // Prisma's Bytes columns want a plain ArrayBuffer-backed Uint8Array, not a pooled Buffer.
  return { emailCiphertext: new Uint8Array(box), wrappedDek: new Uint8Array(wrappedDek) }
}

/** Null once the subscription has been crypto-shredded. The result must only ever live in memory. */
export const openEmail = (
  kek: Buffer,
  subscription: { id: string; emailCiphertext: Uint8Array | null; wrappedDek: Uint8Array | null },
): string | null => {
  if (!subscription.emailCiphertext || !subscription.wrappedDek) return null
  return openEnvelope(
    kek,
    EMAIL_CONTEXT,
    Buffer.from(subscription.wrappedDek),
    Buffer.from(subscription.emailCiphertext),
    Buffer.from(subscription.id, 'utf8'),
  ).toString('utf8')
}

export const newWebhookSecret = (): string => `whsec_${randomBytes(32).toString('base64url')}`

export const sealWebhookSecret = (kek: Buffer, endpointId: string, secret: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(
    seal(
      deriveKey(kek, WEBHOOK_SECRET_CONTEXT),
      Buffer.from(secret, 'utf8'),
      Buffer.from(endpointId, 'utf8'),
    ),
  )

export const openWebhookSecret = (kek: Buffer, endpointId: string, sealed: Uint8Array): string =>
  open(deriveKey(kek, WEBHOOK_SECRET_CONTEXT), Buffer.from(sealed), Buffer.from(endpointId, 'utf8')).toString(
    'utf8',
  )

/**
 * Signing secret for one webhook-channel subscription: `hmac(HKDF(kek, "notifier:alert-webhook"), subscriptionId)`.
 * Deterministic, so nothing is stored; returned once when the subscription is created.
 */
export const alertWebhookSecret = (kek: Buffer, subscriptionId: string): string =>
  `whsec_${hmac(deriveKey(kek, ALERT_WEBHOOK_CONTEXT), subscriptionId).toString('base64url')}`
