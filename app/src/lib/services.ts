import type { Hex } from 'viem'
import { evidenceServiceUrl, piiVaultUrl } from './config'

/**
 * Clients for the two off-chain services the operator routes talk to (spec §9). Both may be offline; every
 * call returns a result the caller renders, and neither ever receives beneficiary personal data from this app.
 */

export type ServiceResult<T> = { ok: true; data: T } | { ok: false; error: string }

const TIMEOUT_MS = 30_000

const failure = (error: unknown): { ok: false; error: string } => ({
  ok: false,
  error: error instanceof Error ? error.message : String(error),
})

export interface EvidenceUploadResult {
  cid: string
  evidenceHash: Hex
}

/**
 * `POST /evidence` (multipart): the service strips EXIF, encrypts client-visible content, pins it and returns
 * the ciphertext hash that goes into the `DeliveryEvidence` attestation. Files never pass through the chain.
 */
export const uploadEvidence = async (
  files: File[],
  manifest: { deliveryId: string; itemsDelivered: number; regionCode: string; note?: string },
): Promise<ServiceResult<EvidenceUploadResult>> => {
  const body = new FormData()
  for (const file of files) body.append('files', file)
  body.append('manifest', JSON.stringify(manifest))

  try {
    const response = await fetch(`${evidenceServiceUrl}/evidence`, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) return { ok: false, error: `${response.status} ${response.statusText}` }
    const data = (await response.json()) as EvidenceUploadResult
    if (!data?.cid || !data?.evidenceHash) return { ok: false, error: 'malformed response' }
    return { ok: true, data }
  } catch (error) {
    return failure(error)
  }
}

/** Where a verifier goes to decrypt evidence; access is checked on-chain by the service, not by this app. */
export const evidenceViewUrl = (cid: string): string =>
  `${evidenceServiceUrl}/evidence/${encodeURIComponent(cid)}`

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
