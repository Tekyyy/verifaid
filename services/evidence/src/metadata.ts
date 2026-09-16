/**
 * Metadata stripping for delivery photos (spec §8.1: "EXIF stripped").
 *
 * A camera photo carries GPS coordinates, a device serial number and a timestamp in its APP1/Exif segment, and
 * often an embedded thumbnail that survives cropping. Any of those can de-anonymise a beneficiary, so they are
 * removed *before* the bundle is encrypted — the verifier who is allowed to decrypt the evidence must not learn
 * where the household lives either.
 *
 * Deliberately a small, dependency-free byte walker: it is easier to audit than an image library, it cannot
 * re-encode (and therefore cannot silently degrade evidence), and it has no native build step.
 */

export type ImageFormat = 'jpeg' | 'png' | 'unknown'

export interface StripResult {
  data: Buffer
  format: ImageFormat
  /** Names of the segments/chunks that were dropped, e.g. `["APP1", "COM", "tEXt"]`. */
  removed: string[]
}

const JPEG_SOI = 0xd8
const JPEG_EOI = 0xd9
const JPEG_SOS = 0xda
const JPEG_COM = 0xfe
const JPEG_TEM = 0x01
const JPEG_APP0 = 0xe0
const JPEG_APP15 = 0xef
const JPEG_RST0 = 0xd0
const JPEG_RST7 = 0xd7

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** PNG chunks that can carry text, an original capture time or a full Exif block. */
const PNG_METADATA_CHUNKS = new Set(['tEXt', 'iTXt', 'zTXt', 'eXIf', 'tIME'])

const isJpeg = (data: Buffer): boolean => data.length >= 2 && data[0] === 0xff && data[1] === JPEG_SOI

const isPng = (data: Buffer): boolean => data.length >= 8 && data.subarray(0, 8).equals(PNG_SIGNATURE)

/** JFIF is the density/aspect header every decoder expects; it holds no personal data, so APP0/JFIF stays. */
const isJfifApp0 = (marker: number, payload: Buffer): boolean =>
  marker === JPEG_APP0 && payload.subarray(0, 5).toString('latin1') === 'JFIF\0'

const markerName = (marker: number): string => {
  if (marker >= JPEG_APP0 && marker <= JPEG_APP15) return `APP${marker - JPEG_APP0}`
  if (marker === JPEG_COM) return 'COM'
  return `0x${marker.toString(16).toUpperCase()}`
}

/**
 * Drops every APPn segment except APP0/JFIF, and every COM segment. Everything else — the quantisation and
 * Huffman tables, the frame header and the entropy-coded scan — is copied byte for byte, so the decoded image
 * is bit-identical to the original.
 */
const stripJpeg = (data: Buffer): StripResult => {
  const chunks: Buffer[] = [data.subarray(0, 2)]
  const removed: string[] = []
  let offset = 2

  while (offset < data.length) {
    if (data[offset] !== 0xff) {
      // Not a marker boundary: the file is malformed or already inside entropy-coded data. Copy the rest as-is
      // rather than guessing, so a damaged upload is never silently truncated.
      chunks.push(data.subarray(offset))
      break
    }

    // Fill bytes: any number of 0xFF may precede a marker.
    let cursor = offset
    while (cursor < data.length && data[cursor] === 0xff) cursor += 1
    if (cursor >= data.length) {
      chunks.push(data.subarray(offset))
      break
    }

    const marker = data[cursor] as number
    if (marker === JPEG_EOI || marker === JPEG_TEM || (marker >= JPEG_RST0 && marker <= JPEG_RST7)) {
      chunks.push(Buffer.from([0xff, marker]))
      offset = cursor + 1
      continue
    }

    if (cursor + 2 >= data.length) {
      chunks.push(data.subarray(offset))
      break
    }

    const length = data.readUInt16BE(cursor + 1)
    const segmentEnd = cursor + 1 + length
    if (length < 2 || segmentEnd > data.length) {
      chunks.push(data.subarray(offset))
      break
    }

    const payload = data.subarray(cursor + 3, segmentEnd)
    const isApp = marker >= JPEG_APP0 && marker <= JPEG_APP15
    const drop = (isApp && !isJfifApp0(marker, payload)) || marker === JPEG_COM

    if (drop) {
      removed.push(markerName(marker))
    } else {
      chunks.push(Buffer.from([0xff, marker]), data.subarray(cursor + 1, segmentEnd))
    }

    if (marker === JPEG_SOS) {
      // The compressed scan follows the SOS header with no length prefix; copy it and everything after verbatim.
      chunks.push(data.subarray(segmentEnd))
      break
    }
    offset = segmentEnd
  }

  return { data: Buffer.concat(chunks), format: 'jpeg', removed }
}

/** Drops text, time and Exif chunks; IHDR/PLTE/IDAT/IEND and any other critical chunk are copied untouched. */
const stripPng = (data: Buffer): StripResult => {
  const chunks: Buffer[] = [data.subarray(0, 8)]
  const removed: string[] = []
  let offset = 8

  while (offset + 8 <= data.length) {
    const length = data.readUInt32BE(offset)
    const type = data.subarray(offset + 4, offset + 8).toString('latin1')
    const chunkEnd = offset + 12 + length
    if (chunkEnd > data.length) {
      chunks.push(data.subarray(offset))
      return { data: Buffer.concat(chunks), format: 'png', removed }
    }

    if (PNG_METADATA_CHUNKS.has(type)) {
      removed.push(type)
    } else {
      chunks.push(data.subarray(offset, chunkEnd))
    }

    offset = chunkEnd
    if (type === 'IEND') break
  }

  return { data: Buffer.concat(chunks), format: 'png', removed }
}

/** Returns the image with its metadata segments removed, or the input unchanged for non-image payloads. */
export const stripImageMetadata = (data: Buffer): StripResult => {
  if (isJpeg(data)) return stripJpeg(data)
  if (isPng(data)) return stripPng(data)
  return { data, format: 'unknown', removed: [] }
}

export const detectImageFormat = (data: Buffer): ImageFormat => {
  if (isJpeg(data)) return 'jpeg'
  if (isPng(data)) return 'png'
  return 'unknown'
}
