import type { Address, Hex } from 'viem'

/**
 * Client for the PII vault's dossier routes. The vault only answers a wallet that signed in: it writes a SIWE
 * message, the wallet signs it, and the signature buys a session token that lasts an hour. Storing a needs
 * assessment takes an active NGO; reading one takes the NGO that stored it or a registered verifier. The vault
 * re-checks those roles on chain on every call, so the token itself grants nothing.
 */

export type VaultResult<T> = { ok: true; data: T } | { ok: false; error: string; status?: number }

export interface VaultSession {
  token: string
  address: Address
  expiresAt: string
}

export interface DossierView {
  hash: Hex
  /** Recomputed from the stored bytes on every read: compare it with the need's on-chain dossier hash. */
  ciphertextHash: Hex
  hashMatches: boolean
  ngoAddress: Address
  needId: string | null
  /** How the caller was let in: `ngo` (the owner) or `verifier`. */
  role: string
  createdAt: string
  assessment: { summary?: string; [field: string]: unknown }
}

export interface VaultOptions {
  baseUrl: string
  fetchImpl?: typeof fetch
}

const TIMEOUT_MS = 30_000
const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json' }

const call = async <T>(options: VaultOptions, path: string, init: RequestInit): Promise<VaultResult<T>> => {
  try {
    const response = await (options.fetchImpl ?? fetch)(`${options.baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const body = (await response.json().catch(() => null)) as (T & { message?: string }) | null
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: body?.message ?? `${response.status} ${response.statusText}`,
      }
    }
    if (body === null) return { ok: false, error: 'malformed response' }
    return { ok: true, data: body }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** The vault writes the message, `sign` has the wallet sign it, and the signature is exchanged for a token. */
export const vaultSignIn = async (
  options: VaultOptions,
  address: Address,
  sign: (message: string) => Promise<Hex>,
): Promise<VaultResult<VaultSession>> => {
  const challenge = await call<{ message: string }>(options, '/auth/nonce', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ address }),
  })
  if (!challenge.ok) return challenge
  let signature: Hex
  try {
    signature = await sign(challenge.data.message)
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message.split('\n')[0] || 'signature refused' : 'signature refused',
    }
  }
  return call<VaultSession>(options, '/auth/verify', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ message: challenge.data.message, signature }),
  })
}

/** Stores the assessment encrypted; `hash` (of the ciphertext) is what the need commits to on chain. */
export const storeDossier = (options: VaultOptions, token: string, summary: string) =>
  call<{ hash: Hex }>(options, '/dossiers', {
    method: 'POST',
    headers: { ...JSON_HEADERS, authorization: `Bearer ${token}` },
    body: JSON.stringify({ assessment: { summary } }),
  })

export const readDossier = (options: VaultOptions, token: string, hash: string) =>
  call<DossierView>(options, `/dossiers/${encodeURIComponent(hash)}`, {
    method: 'GET',
    headers: { accept: 'application/json', authorization: `Bearer ${token}` },
  })

/** A session good for at least another minute. */
export const isFresh = (
  session: VaultSession | null | undefined,
  now = Date.now(),
): session is VaultSession => Boolean(session && new Date(session.expiresAt).getTime() - now > 60_000)
