/**
 * The evidence an NGO files for a delivery: what it accounts for, file by file. The manifest is the exact text
 * `DeliveryManager.submitEvidence` receives — its keccak256 is kept on chain and the text itself is in the event —
 * so building it must be deterministic and reading it must never trust it blindly.
 *
 * Files are referenced by their SHA-256, so a file cannot be replaced after the fact without the hash, and with it
 * every approval, no longer matching. Where a file lives (`url`) is a convenience; the hash is the commitment.
 * Since v9 a file pinned to IPFS also carries its `cid`, so it outlives the server that received it: anyone can
 * fetch it from any IPFS gateway and check it against `sha256`.
 */

export const EVIDENCE_KINDS = ['photo', 'receipt', 'bank_statement', 'other'] as const
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number]

export interface EvidenceFile {
  kind: EvidenceKind
  /** The name it was uploaded with, for people; never trusted as a path. */
  name: string
  /** MIME type as uploaded. */
  type: string
  size: number
  /** Lowercase hex SHA-256 of the file's bytes. */
  sha256: string
  /** IPFS content identifier, when the file was pinned. */
  cid?: string
  /** Where the file can be downloaded. */
  url: string
}

export interface EvidenceManifest {
  v: 1
  /** What the money was spent on, in the NGO's words. */
  note: string
  files: EvidenceFile[]
}

/** Mirrors `DeliveryManager.MAX_MANIFEST_BYTES`. */
export const MAX_MANIFEST_BYTES = 8192

/** Mirrors `CommunityProofs.MAX_PROOFS_PER_WALLET`: proofs one wallet may file about one need. */
export const MAX_PROOFS_PER_WALLET = 3
export const MAX_EVIDENCE_FILES = 12
export const MAX_NOTE_LENGTH = 1500

const SHA256 = /^[0-9a-f]{64}$/
/** CIDv0 (base58, `Qm…`) or CIDv1 in base32 (`b…`), which is what pinning services return. */
const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,100})$/

export const isCid = (value: string): boolean => CID.test(value)

/** Serialises with a fixed key order, so the same evidence always yields the same bytes and the same hash. */
export const buildManifest = (note: string, files: readonly EvidenceFile[]): string =>
  JSON.stringify({
    v: 1,
    note: note.trim(),
    files: files.map((file) => ({
      kind: file.kind,
      name: file.name,
      type: file.type,
      size: file.size,
      sha256: file.sha256.toLowerCase(),
      // Only when present, so evidence that was never pinned serialises exactly as it did before v9.
      ...(file.cid ? { cid: file.cid } : {}),
      url: file.url,
    })),
  })

/** Byte length as the contract measures it (UTF-8). */
export const manifestBytes = (text: string): number => new TextEncoder().encode(text).length

/** Parses a manifest from the chain. Null for anything that is not one: the raw text is still shown as is. */
export const parseManifest = (text: string): EvidenceManifest | null => {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (value.v !== 1 || typeof value.note !== 'string' || !Array.isArray(value.files)) return null

  const files: EvidenceFile[] = []
  for (const item of value.files.slice(0, MAX_EVIDENCE_FILES)) {
    if (!item || typeof item !== 'object') return null
    const file = item as Record<string, unknown>
    const kind = EVIDENCE_KINDS.includes(file.kind as EvidenceKind) ? (file.kind as EvidenceKind) : 'other'
    if (typeof file.sha256 !== 'string' || !SHA256.test(file.sha256.toLowerCase())) return null
    files.push({
      kind,
      name: typeof file.name === 'string' ? file.name.slice(0, 200) : '',
      type: typeof file.type === 'string' ? file.type.slice(0, 100) : '',
      size: typeof file.size === 'number' && Number.isFinite(file.size) ? file.size : 0,
      sha256: file.sha256.toLowerCase(),
      ...(typeof file.cid === 'string' && isCid(file.cid) ? { cid: file.cid } : {}),
      // Only links a browser can open safely; anything else is dropped rather than rendered.
      url: typeof file.url === 'string' && /^(https?:\/\/|\/)/.test(file.url) ? file.url : '',
    })
  }
  return { v: 1, note: value.note.slice(0, MAX_NOTE_LENGTH), files }
}
