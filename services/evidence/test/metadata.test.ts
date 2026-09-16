import { describe, expect, it } from 'vitest'
import { detectImageFormat, stripImageMetadata } from '../src/metadata.js'

/**
 * The stripper is the last line of defence between a field agent's camera roll and a verifier's screen, so it is
 * tested against hand-built files where every byte is known: a real image library would hide whether the pixel
 * data survived untouched.
 */

const segment = (marker: number, payload: Buffer): Buffer =>
  Buffer.concat([Buffer.from([0xff, marker]), lengthPrefix(payload), payload])

const lengthPrefix = (payload: Buffer): Buffer => {
  const header = Buffer.alloc(2)
  header.writeUInt16BE(payload.length + 2)
  return header
}

const SOI = Buffer.from([0xff, 0xd8])
const EOI = Buffer.from([0xff, 0xd9])
const JFIF_APP0 = segment(0xe0, Buffer.from([...Buffer.from('JFIF\0', 'latin1'), 1, 1, 0, 0, 1, 0, 1, 0, 0]))
// A real camera APP1: "Exif\0\0" then a TIFF header, here carrying an obvious GPS string.
const EXIF_APP1 = segment(0xe1, Buffer.from('Exif\0\0II*\0GPS 41.6520,-4.7286 IMG_0042 iPhone', 'latin1'))
const COMMENT = segment(0xfe, Buffer.from('camera serial SN-12345', 'latin1'))
const QUANT_TABLE = segment(0xdb, Buffer.from([0x00, 0x10, 0x0b, 0x0c, 0x0e]))
const FRAME_HEADER = segment(0xc0, Buffer.from([0x08, 0x00, 0x10, 0x00, 0x10, 0x01, 0x01, 0x11, 0x00]))
const SCAN_HEADER = segment(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]))
// Entropy-coded data, including a stuffed 0xFF00 that must not be mistaken for a marker.
const SCAN_DATA = Buffer.from([0xa1, 0xb2, 0xff, 0x00, 0xc3, 0xd4, 0xe5, 0xf6])

const pngChunk = (type: string, data: Buffer): Buffer => {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(data.length, 0)
  header.write(type, 4, 'latin1')
  return Buffer.concat([header, data, Buffer.from([0xde, 0xad, 0xbe, 0xef])])
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const IHDR = pngChunk('IHDR', Buffer.from([0, 0, 0, 16, 0, 0, 0, 16, 8, 2, 0, 0, 0]))
const IDAT = pngChunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x01]))
const IEND = pngChunk('IEND', Buffer.alloc(0))

describe('JPEG metadata stripping', () => {
  const photo = Buffer.concat([
    SOI,
    JFIF_APP0,
    EXIF_APP1,
    COMMENT,
    QUANT_TABLE,
    FRAME_HEADER,
    SCAN_HEADER,
    SCAN_DATA,
    EOI,
  ])

  it('removes the Exif APP1 segment and everything it carried', () => {
    const result = stripImageMetadata(photo)

    expect(result.format).toBe('jpeg')
    expect(result.removed).toContain('APP1')
    // The marker itself, its identifier and its payload are all gone.
    expect(result.data.includes(Buffer.from('Exif\0\0', 'latin1'))).toBe(false)
    expect(result.data.includes(Buffer.from('GPS 41.6520,-4.7286', 'latin1'))).toBe(false)
    expect(result.data.includes(EXIF_APP1)).toBe(false)
    expect(result.data.length).toBe(photo.length - EXIF_APP1.length - COMMENT.length)
  })

  it('removes COM comments', () => {
    const result = stripImageMetadata(photo)
    expect(result.removed).toContain('COM')
    expect(result.data.includes(Buffer.from('camera serial SN-12345', 'latin1'))).toBe(false)
  })

  it('leaves the image data intact', () => {
    const result = stripImageMetadata(photo)

    // Structure: SOI, the JFIF header, the tables, the frame and scan headers, the scan itself, EOI.
    expect(result.data).toEqual(
      Buffer.concat([SOI, JFIF_APP0, QUANT_TABLE, FRAME_HEADER, SCAN_HEADER, SCAN_DATA, EOI]),
    )
    // The entropy-coded scan is copied verbatim, byte-stuffing included.
    expect(result.data.subarray(result.data.length - SCAN_DATA.length - EOI.length)).toEqual(
      Buffer.concat([SCAN_DATA, EOI]),
    )
  })

  it('keeps APP0/JFIF but drops other APP0 variants such as the JFXX thumbnail', () => {
    const jfxx = segment(0xe0, Buffer.from('JFXX\0\x10thumbnail-bytes', 'latin1'))
    const withThumbnail = Buffer.concat([SOI, JFIF_APP0, jfxx, QUANT_TABLE, SCAN_HEADER, SCAN_DATA, EOI])
    const result = stripImageMetadata(withThumbnail)

    expect(result.removed).toEqual(['APP0'])
    expect(result.data.includes(JFIF_APP0)).toBe(true)
    expect(result.data.includes(Buffer.from('thumbnail-bytes', 'latin1'))).toBe(false)
  })

  it('returns a clean photo unchanged', () => {
    const clean = Buffer.concat([SOI, JFIF_APP0, QUANT_TABLE, SCAN_HEADER, SCAN_DATA, EOI])
    const result = stripImageMetadata(clean)
    expect(result.removed).toEqual([])
    expect(result.data).toEqual(clean)
  })

  it('copies the remainder rather than truncating a malformed file', () => {
    const truncated = Buffer.concat([SOI, JFIF_APP0, Buffer.from([0xff, 0xe1, 0x00])])
    const result = stripImageMetadata(truncated)
    expect(result.data.length).toBe(truncated.length)
  })
})

describe('PNG metadata stripping', () => {
  const image = Buffer.concat([
    PNG_SIGNATURE,
    IHDR,
    pngChunk('tEXt', Buffer.from('Comment\0Maria Lopez, household 4', 'latin1')),
    pngChunk('zTXt', Buffer.from('Description\0\0compressed', 'latin1')),
    pngChunk('iTXt', Buffer.from('XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta/>', 'latin1')),
    pngChunk('eXIf', Buffer.from('II*\0GPS payload', 'latin1')),
    pngChunk('tIME', Buffer.from([0x07, 0xe9, 0x05, 0x0c, 0x0a, 0x1e, 0x00])),
    IDAT,
    IEND,
  ])

  it('drops every metadata chunk and keeps the pixel data', () => {
    const result = stripImageMetadata(image)

    expect(result.format).toBe('png')
    expect(result.removed).toEqual(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME'])
    expect(result.data).toEqual(Buffer.concat([PNG_SIGNATURE, IHDR, IDAT, IEND]))
    expect(result.data.includes(Buffer.from('Maria Lopez', 'latin1'))).toBe(false)
    expect(result.data.includes(Buffer.from('GPS payload', 'latin1'))).toBe(false)
  })

  it('leaves a PNG without metadata untouched', () => {
    const clean = Buffer.concat([PNG_SIGNATURE, IHDR, IDAT, IEND])
    const result = stripImageMetadata(clean)
    expect(result.removed).toEqual([])
    expect(result.data).toEqual(clean)
  })
})

describe('non-image payloads', () => {
  it('passes through untouched and is reported as unknown', () => {
    const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n', 'latin1')
    const result = stripImageMetadata(pdf)
    expect(result.format).toBe('unknown')
    expect(result.data).toEqual(pdf)
    expect(detectImageFormat(pdf)).toBe('unknown')
  })
})
