import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

/**
 * Envelope encryption used by the PII vault and the evidence service.
 *
 *   plaintext --AES-256-GCM--> ciphertext        (per-record data key, "DEK")
 *   DEK       --AES-256-GCM--> wrapped DEK       (key-encryption key derived per NGO from the master KEK)
 *
 * Deleting the wrapped DEK ("crypto-shredding") makes a record permanently unreadable while leaving the
 * ciphertext in place — that is how the right to erasure is honoured without deleting rows that on-chain hashes
 * refer to. In production the master key lives in a KMS/HSM; in development it is a local key file.
 */

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const KEY_BYTES = 32

/** iv ‖ authTag ‖ ciphertext, the single blob that gets stored or uploaded. */
export type SealedBox = Buffer

export const generateDek = (): Buffer => randomBytes(KEY_BYTES)

/** Derives a per-context key (e.g. one KEK per NGO, one grant key per verifier) from the master key. */
export const deriveKey = (masterKey: Buffer, context: string): Buffer =>
  Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), Buffer.from(context, 'utf8'), KEY_BYTES))

export const seal = (key: Buffer, plaintext: Buffer, aad?: Buffer): SealedBox => {
  if (key.length !== KEY_BYTES) throw new Error('key must be 32 bytes')
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  if (aad) cipher.setAAD(aad)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
}

export const open = (key: Buffer, box: SealedBox, aad?: Buffer): Buffer => {
  if (key.length !== KEY_BYTES) throw new Error('key must be 32 bytes')
  if (box.length < IV_BYTES + 16) throw new Error('sealed box is truncated')
  const iv = box.subarray(0, IV_BYTES)
  const authTag = box.subarray(IV_BYTES, IV_BYTES + 16)
  const ciphertext = box.subarray(IV_BYTES + 16)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  if (aad) decipher.setAAD(aad)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

export interface EnvelopeResult {
  /** iv ‖ tag ‖ ciphertext of the payload, encrypted with a fresh DEK. */
  box: SealedBox
  /** The DEK, itself sealed with the context key. Destroying this makes `box` unrecoverable. */
  wrappedDek: SealedBox
}

/** Encrypts `plaintext` under a fresh DEK and wraps that DEK with a key derived for `context`. */
export const sealEnvelope = (masterKey: Buffer, context: string, plaintext: Buffer, aad?: Buffer): EnvelopeResult => {
  const dek = generateDek()
  try {
    return { box: seal(dek, plaintext, aad), wrappedDek: seal(deriveKey(masterKey, context), dek) }
  } finally {
    dek.fill(0)
  }
}

export const openEnvelope = (
  masterKey: Buffer,
  context: string,
  wrappedDek: SealedBox,
  box: SealedBox,
  aad?: Buffer,
): Buffer => {
  const dek = open(deriveKey(masterKey, context), wrappedDek)
  try {
    return open(dek, box, aad)
  } finally {
    dek.fill(0)
  }
}

/** Re-wraps an existing DEK for another grantee (e.g. sharing evidence with a specific verifier). */
export const rewrapDek = (
  masterKey: Buffer,
  fromContext: string,
  toContext: string,
  wrappedDek: SealedBox,
): SealedBox => {
  const dek = open(deriveKey(masterKey, fromContext), wrappedDek)
  try {
    return seal(deriveKey(masterKey, toContext), dek)
  } finally {
    dek.fill(0)
  }
}

/** Constant-time comparison for tokens and digests. */
export const safeEqual = (a: Buffer | string, b: Buffer | string): boolean => {
  const left = Buffer.isBuffer(a) ? a : Buffer.from(a, 'utf8')
  const right = Buffer.isBuffer(b) ? b : Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** HMAC-SHA256, used for webhook signatures and session tokens. */
export const hmac = (key: Buffer | string, payload: Buffer | string): Buffer =>
  createHmac('sha256', key).update(payload).digest()

/** Parses a 32-byte hex key (with or without 0x) from an env var or key file. */
export const parseKey = (value: string): Buffer => {
  const hex = value.trim().replace(/^0x/, '')
  const key = Buffer.from(hex, 'hex')
  if (key.length !== KEY_BYTES) throw new Error('expected a 32-byte hex key')
  return key
}
