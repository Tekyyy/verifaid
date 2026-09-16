import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseKey } from '@poa/shared'
import type { Address } from 'viem'

/**
 * The master key-encryption key. In production this is a KMS/HSM key; here it is a 32-byte hex file whose path
 * comes from `NGO_KEK_PATH`. Per-NGO and per-grantee keys are derived from it with HKDF (`deriveKey`), so one
 * file protects every record without any NGO's key being able to open another's.
 */

export const ngoContext = (ngo: Address): string => `ngo:${ngo.toLowerCase()}`

/** Context of a key re-wrapped for one verifier, so each grant is a distinct, revocable key. */
export const grantContext = (grantee: Address): string => `grant:${grantee.toLowerCase()}`

export interface LoadKeyResult {
  key: Buffer
  created: boolean
}

/**
 * Reads the master key, creating it on first run. Creation is reported so the caller can log it: a key file that
 * appears by itself must be backed up, and losing it makes every stored record unrecoverable by design.
 */
export const loadMasterKey = (path: string): LoadKeyResult => {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${randomBytes(32).toString('hex')}\n`, { encoding: 'utf8', mode: 0o600 })
    return { key: parseKey(readFileSync(path, 'utf8')), created: true }
  }
  return { key: parseKey(readFileSync(path, 'utf8')), created: false }
}
