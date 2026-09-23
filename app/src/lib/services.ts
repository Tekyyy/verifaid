import type { Hex } from 'viem'
import { piiVaultUrl } from './config'

/**
 * Clients for the off-chain pieces the operator routes talk to: this app's evidence uploads and the PII vault
 * (spec §9). Either may be offline; every call returns a result the caller renders, and neither ever receives
 * beneficiary personal data from this app.
 */

export type ServiceResult<T> = { ok: true; data: T } | { ok: false; error: string }

const TIMEOUT_MS = 30_000

const failure = (error: unknown): { ok: false; error: string } => ({
  ok: false,
  error: error instanceof Error ? error.message : String(error),
})

/** A file the app stored for the NGO's evidence, as `POST /api/uploads` returns it. */
export interface UploadedEvidenceFile {
  name: string
  type: string
  size: number
  sha256: string
  /** IPFS content identifier, when the platform pinned the file. */
  cid?: string
  url: string
}

/**
 * `POST /api/uploads` (multipart): this app checks each file's type from its bytes, strips photo metadata and
 * stores it by SHA-256. The hashes are what the NGO then signs in its delivery manifest.
 */
export const uploadEvidenceFiles = async (files: File[]): Promise<ServiceResult<UploadedEvidenceFile[]>> => {
  const body = new FormData()
  for (const file of files) body.append('files', file)
  try {
    const response = await fetch('/api/uploads', {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const data = (await response.json().catch(() => null)) as {
      files?: UploadedEvidenceFile[]
      message?: string
    } | null
    if (!response.ok)
      return { ok: false, error: data?.message ?? `${response.status} ${response.statusText}` }
    if (!data?.files) return { ok: false, error: 'malformed response' }
    return { ok: true, data: data.files }
  } catch (error) {
    return failure(error)
  }
}

/** Where a verifier goes to read a needs assessment dossier. */
export const dossierViewUrl = (hash: string): string => `${piiVaultUrl}/dossiers/${encodeURIComponent(hash)}`

/**
 * `POST /dossiers`: the NGO's needs assessment is stored encrypted and only its hash reaches the chain.
 * The assessment text is sent to the NGO's own vault service and nowhere else.
 */
export const storeDossier = async (content: string): Promise<ServiceResult<{ hash: Hex }>> => {
  try {
    const response = await fetch(`${piiVaultUrl}/dossiers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) return { ok: false, error: `${response.status} ${response.statusText}` }
    const data = (await response.json()) as { hash?: Hex }
    if (!data?.hash) return { ok: false, error: 'malformed response' }
    return { ok: true, data: { hash: data.hash } }
  } catch (error) {
    return failure(error)
  }
}
