import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  isSha256,
  safeFileName,
  sha256Hex,
  sniffType,
  stripJpegMetadata,
  stripMetadata,
  stripPngMetadata,
} from './evidenceFiles.ts'

const bytes = (...values: number[]) => Uint8Array.from(values)

/** A segment: marker, big-endian length (including the two length bytes), payload. */
const segment = (marker: number, payload: number[]) => [
  0xff,
  marker,
  (payload.length + 2) >> 8,
  (payload.length + 2) & 0xff,
  ...payload,
]

const EXIF_GPS = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x47, 0x50, 0x53] // "Exif\0\0GPS"
const JFIF = [0x4a, 0x46, 0x49, 0x46, 0x00]
const SCAN = [0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0x33, 0x44, 0xff, 0xd9]

describe('stripJpegMetadata', () => {
  it('removes EXIF, IPTC and comments and keeps the picture', () => {
    const photo = bytes(
      0xff,
      0xd8,
      ...segment(0xe0, JFIF),
      ...segment(0xe1, EXIF_GPS),
      ...segment(0xed, [1, 2, 3]),
      ...segment(0xfe, [0x68, 0x69]),
      ...SCAN,
    )
    const clean = stripJpegMetadata(photo)
    assert.deepEqual([...clean], [0xff, 0xd8, ...segment(0xe0, JFIF), ...SCAN])
    assert.equal(stripMetadata(photo, 'image/jpeg').length, clean.length)
  })

  it('leaves a file it cannot parse exactly as it was', () => {
    const odd = bytes(0xff, 0xd8, 0x00, 0x01, 0x02)
    assert.equal(stripJpegMetadata(odd), odd)
  })
})

describe('stripPngMetadata', () => {
  const chunk = (type: string, data: number[]) => [
    0,
    0,
    0,
    data.length,
    ...[...type].map((c) => c.charCodeAt(0)),
    ...data,
    0,
    0,
    0,
    0, // CRC, not checked here
  ]
  const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

  it('drops the text and EXIF chunks', () => {
    const png = bytes(
      ...SIGNATURE,
      ...chunk('IHDR', [1, 2, 3]),
      ...chunk('tEXt', [0x47, 0x50, 0x53]),
      ...chunk('eXIf', [9]),
      ...chunk('IDAT', [7, 7]),
      ...chunk('IEND', []),
    )
    assert.deepEqual(
      [...stripPngMetadata(png)],
      [...SIGNATURE, ...chunk('IHDR', [1, 2, 3]), ...chunk('IDAT', [7, 7]), ...chunk('IEND', [])],
    )
  })
})

describe('sniffType', () => {
  it('trusts the bytes, not the name', () => {
    assert.equal(sniffType(bytes(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg')
    assert.equal(sniffType(bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31)), 'application/pdf')
    assert.equal(sniffType(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50)), 'image/webp')
    assert.equal(sniffType(new TextEncoder().encode('<html><script>')), null)
  })
})

describe('names and hashes', () => {
  it('hashes content, and recognises a hash', () => {
    const hash = sha256Hex(new TextEncoder().encode('abc'))
    assert.equal(hash, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    assert.equal(isSha256(hash), true)
    assert.equal(isSha256('../etc/passwd'), false)
  })

  it('keeps a readable name without paths or header-breaking characters', () => {
    assert.equal(safeFileName('C:\\fakepath\\factura enero.pdf'), 'factura enero.pdf')
    assert.equal(safeFileName('../../x"\r\ny.jpg'), 'x___y.jpg')
    assert.equal(safeFileName(''), 'file')
    assert.equal(safeFileName('recibo-ñandú.png'), 'recibo-ñandú.png')
  })
})
