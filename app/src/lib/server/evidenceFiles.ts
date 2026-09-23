/**
 * Evidence files, stored by content. An NGO uploads the photos, receipts and bank statements that account for a
 * tranche; each is kept under its SHA-256, which is what the manifest it signs on chain commits to. A file can
 * therefore never be replaced behind the donors' backs: other bytes are another hash, and another address.
 *
 * Kept deliberately dependency-free (no `@/` imports) so it runs under `node --test`.
 */

import { createHash } from 'node:crypto'

export const MAX_FILE_BYTES = 10 * 1024 * 1024

/** What may be uploaded, recognised by its first bytes rather than by what the browser claims. */
export const EVIDENCE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const
export type EvidenceType = (typeof EVIDENCE_TYPES)[number]

export const sniffType = (bytes: Uint8Array): EvidenceType | null => {
  const starts = (...prefix: number[]) => prefix.every((byte, i) => bytes[i] === byte)
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return 'application/pdf'
  return null
}

export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

export const isSha256 = (value: string): boolean => /^[0-9a-f]{64}$/.test(value)

/**
 * A JPEG without the segments that carry who, where and with what: EXIF (GPS, camera serial, timestamps) and
 * XMP in APP1, IPTC in APP13, and comments. The picture itself (and its colour profile) is untouched. A photo of
 * a delivery must not say where the people in it live.
 */
export const stripJpegMetadata = (bytes: Uint8Array): Uint8Array => {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes
  const kept: Uint8Array[] = [bytes.subarray(0, 2)]
  let at = 2
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return bytes // not a marker where one must be: leave the file as it was
    const marker = bytes[at + 1] as number
    // Start of scan: the compressed image follows, with no more metadata segments to look for.
    if (marker === 0xda) {
      kept.push(bytes.subarray(at))
      return concat(kept)
    }
    const length = ((bytes[at + 2] as number) << 8) | (bytes[at + 3] as number)
    const end = at + 2 + length
    if (length < 2 || end > bytes.length) return bytes
    const dropped = marker === 0xe1 || marker === 0xed || marker === 0xfe
    if (!dropped) kept.push(bytes.subarray(at, end))
    at = end
  }
  return bytes
}

/** A PNG without its text and EXIF chunks (tEXt, zTXt, iTXt, eXIf), for the same reason. */
export const stripPngMetadata = (bytes: Uint8Array): Uint8Array => {
  if (sniffType(bytes) !== 'image/png') return bytes
  const kept: Uint8Array[] = [bytes.subarray(0, 8)]
  let at = 8
  while (at + 12 <= bytes.length) {
    const length =
      (((bytes[at] as number) << 24) >>> 0) +
      ((bytes[at + 1] as number) << 16) +
      ((bytes[at + 2] as number) << 8) +
      (bytes[at + 3] as number)
    const end = at + 12 + length
    if (end > bytes.length) return bytes
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8))
    if (!['tEXt', 'zTXt', 'iTXt', 'eXIf'].includes(type)) kept.push(bytes.subarray(at, end))
    at = end
    if (type === 'IEND') break
  }
  return concat(kept)
}

export const stripMetadata = (bytes: Uint8Array, type: EvidenceType): Uint8Array =>
  type === 'image/jpeg' ? stripJpegMetadata(bytes) : type === 'image/png' ? stripPngMetadata(bytes) : bytes

/** A name safe to put in a header and to show, without paths or control characters. */
export const safeFileName = (name: string): string =>
  (name.split(/[\\/]/).pop() ?? '').replace(/[^\p{L}\p{N} ._()-]/gu, '_').slice(0, 120) || 'file'

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}
