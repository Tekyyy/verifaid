/**
 * Pinning evidence files to IPFS, so they outlive this server. The chain keeps each file's SHA-256 (in the
 * manifest's hash); IPFS keeps the bytes under a CID any gateway can serve. The two are checked against each
 * other every time a file comes back: a gateway can be slow or gone, but it cannot hand back other bytes unnoticed.
 *
 * Pinning goes through Pinata when `PINATA_JWT` is set (a free account is enough). Without it uploads still work,
 * stored on this server only, and the manifest simply carries no CID.
 *
 * Kept free of `@/` imports so it runs under `node --test`.
 */

import { sha256Hex } from './evidenceFiles.ts'

type Fetch = typeof fetch
type Env = Record<string, string | undefined>

const PIN_URL = 'https://api.pinata.cloud/pinning/pinFileToIPFS'
const PIN_TIMEOUT_MS = 60_000
const FETCH_TIMEOUT_MS = 20_000
/** CIDv0 (`Qm…`) or base32 CIDv1 (`b…`), which is what Pinata returns. Mirrors `isCid` in @poa/shared. */
const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,100})$/

export const isCid = (value: string): boolean => CID.test(value)

export const pinningEnabled = (env: Env = process.env): boolean => Boolean(env.PINATA_JWT?.trim())

/** Where this server reads pinned files back from; Pinata's own gateway is the fastest for files it pinned. */
export const gatewayBase = (env: Env = process.env): string =>
  (env.IPFS_GATEWAY ?? env.NEXT_PUBLIC_IPFS_GATEWAY ?? 'https://gateway.pinata.cloud/ipfs/').replace(
    /\/?$/,
    '/',
  )

/**
 * Pins one file and returns its CID, or null when pinning is off or failed. A failed pin never fails the upload:
 * the file is still stored here and its hash still goes on chain; it just is not on IPFS yet.
 */
export const pinFile = async (
  bytes: Uint8Array,
  name: string,
  type: string,
  options: { env?: Env; fetchImpl?: Fetch } = {},
): Promise<string | null> => {
  const env = options.env ?? process.env
  const jwt = env.PINATA_JWT?.trim()
  if (!jwt) return null
  const body = new FormData()
  body.append('file', new Blob([new Uint8Array(bytes)], { type }), name)
  body.append(
    'pinataMetadata',
    JSON.stringify({ name: `verifaid-evidence-${sha256Hex(bytes).slice(0, 16)}` }),
  )
  body.append('pinataOptions', JSON.stringify({ cidVersion: 1 }))
  try {
    const response = await (options.fetchImpl ?? fetch)(PIN_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}` },
      body,
      signal: AbortSignal.timeout(PIN_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const result = (await response.json()) as { IpfsHash?: unknown }
    return typeof result.IpfsHash === 'string' && isCid(result.IpfsHash) ? result.IpfsHash : null
  } catch {
    return null
  }
}

/**
 * Reads a pinned file back from a gateway, and returns it only if it is the file the chain committed to. Used
 * when this server no longer has its own copy (a new server, a lost disk).
 */
export const fetchPinned = async (
  cid: string,
  sha256: string,
  options: { env?: Env; fetchImpl?: Fetch } = {},
): Promise<Uint8Array | null> => {
  if (!isCid(cid)) return null
  try {
    const response = await (options.fetchImpl ?? fetch)(`${gatewayBase(options.env)}${cid}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const bytes = new Uint8Array(await response.arrayBuffer())
    return sha256Hex(bytes) === sha256.toLowerCase() ? bytes : null
  } catch {
    return null
  }
}
