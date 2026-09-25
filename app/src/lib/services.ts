/**
 * Client for this app's evidence uploads. It may be offline; every call returns a result the caller renders. The
 * PII vault's client is `lib/vault.ts`.
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
