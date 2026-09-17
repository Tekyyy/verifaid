import { createPrivateKey, createPublicKey, type KeyObject, randomBytes, sign } from 'node:crypto'

/**
 * Bearer JWT for the Coinbase Developer Platform REST APIs, built with node:crypto alone so the app takes no SDK
 * dependency. CDP secret API keys come in two shapes:
 *
 * - Ed25519 (the current default): the secret is base64 of 64 bytes, the 32-byte seed followed by the 32-byte
 *   public key. Signed as `EdDSA`.
 * - ECDSA P-256 (legacy keys): a PEM `EC PRIVATE KEY`. Signed as `ES256`, with the JOSE signature encoding
 *   (raw r‖s), not DER.
 *
 * A token authorizes exactly one request, named by its `uri` claim, for two minutes.
 *
 * This module must stay free of path aliases and Next imports: `node --test` runs its tests directly.
 */

export type CdpJwtAlgorithm = 'EdDSA' | 'ES256'

export interface CdpJwtInput {
  keyId: string
  keySecret: string
  method: 'GET' | 'POST'
  /** e.g. `api.developer.coinbase.com` */
  host: string
  /** Path without the query string, e.g. `/onramp/v1/token`. */
  path: string
  /** Unix seconds; defaults to now. */
  now?: number
}

const TOKEN_LIFETIME_SECONDS = 120

/** PKCS#8 DER header for a raw 32-byte Ed25519 private key (RFC 8410). */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
/** SPKI DER header for a raw 32-byte Ed25519 public key. */
const ED25519_SPKI_PREFIX_LENGTH = 12

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

const base64url = (value: Buffer | string): string => Buffer.from(value).toString('base64url')

/** Parses a CDP key secret into a signing key. Throws, without echoing the secret, when it is neither shape. */
export const parseCdpSecret = (secret: string): { key: KeyObject; alg: CdpJwtAlgorithm } => {
  // Secrets pasted into a .env file often carry literal "\n" sequences instead of newlines.
  const normalized = secret.trim().replace(/\\n/g, '\n')

  if (normalized.startsWith('-----BEGIN')) {
    const key = createPrivateKey({ key: normalized, format: 'pem' })
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new Error('CDP PEM secret must be an EC P-256 private key')
    }
    return { key, alg: 'ES256' }
  }

  const compact = normalized.replace(/\s+/g, '')
  const raw = BASE64.test(compact) ? Buffer.from(compact, 'base64') : Buffer.alloc(0)
  if (raw.length !== 64) {
    throw new Error('CDP Ed25519 secret must be base64 of 64 bytes (seed followed by public key)')
  }
  const key = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, raw.subarray(0, 32)]),
    format: 'der',
    type: 'pkcs8',
  })
  // A corrupted or truncated secret would still sign, just with a key Coinbase does not know: fail here instead.
  const publicKey = createPublicKey(key).export({ format: 'der', type: 'spki' })
  if (!publicKey.subarray(ED25519_SPKI_PREFIX_LENGTH).equals(raw.subarray(32))) {
    throw new Error('CDP Ed25519 secret is inconsistent: its public key does not match its seed')
  }
  return { key, alg: 'EdDSA' }
}

export const buildCdpJwt = ({ keyId, keySecret, method, host, path, now }: CdpJwtInput): string => {
  const { key, alg } = parseCdpSecret(keySecret)
  const issuedAt = now ?? Math.floor(Date.now() / 1000)

  const header = { alg, kid: keyId, typ: 'JWT', nonce: randomBytes(16).toString('hex') }
  const claims = {
    sub: keyId,
    iss: 'cdp',
    aud: ['cdp_service'],
    nbf: issuedAt,
    exp: issuedAt + TOKEN_LIFETIME_SECONDS,
    uri: `${method} ${host}${path}`,
  }

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`
  const data = Buffer.from(signingInput)
  const signature =
    alg === 'EdDSA' ? sign(null, data, key) : sign('sha256', data, { key, dsaEncoding: 'ieee-p1363' })
  return `${signingInput}.${base64url(signature)}`
}
