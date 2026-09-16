import { openEnvelope, rewrapDek, sealEnvelope } from '@poa/shared'
import { keccak256 } from 'viem'
import { describe, expect, it } from 'vitest'
import { buildBundle, decodeBundle } from '../src/bundle.js'
import { computeCidV1 } from '../src/ipfs.js'
import { grantContext, ngoContext } from '../src/keys.js'

/**
 * The upload path end to end, minus HTTP and IPFS: strip → bundle → seal → hash, and back. This is the property
 * the on-chain attestation depends on — `evidenceHash` must identify exactly the bytes that were uploaded.
 */

const MASTER_KEY = Buffer.alloc(32, 0x5a)
const NGO = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const
const VERIFIER = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65' as const

const photoWithExif = Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  Buffer.from([0xff, 0xe1, 0x00, 0x14, ...Buffer.from('Exif\0\0II*\0lat/long', 'latin1')]),
  Buffer.from([0xff, 0xda, 0x00, 0x04, 0x01, 0x01]),
  Buffer.from([0x11, 0x22, 0x33, 0x44]),
  Buffer.from([0xff, 0xd9]),
])

const manifest = {
  deliveryId: '7',
  itemsDelivered: 120,
  regionCode: 'ES-CM',
  notes: 'Handed out at the parish hall; Ana Ruiz signed the paper list.',
}

describe('evidence bundle', () => {
  it('round-trips through envelope encryption and keeps the evidence hash stable', () => {
    const bundle = buildBundle(manifest, [
      { name: 'photo.jpg', contentType: 'image/jpeg', data: photoWithExif },
      { name: 'manifest.csv', contentType: 'text/csv', data: Buffer.from('item,qty\nrice,120\n') },
    ])

    const sealed = sealEnvelope(MASTER_KEY, ngoContext(NGO), bundle.payload)
    const evidenceHash = keccak256(sealed.box)

    // What goes on-chain is the hash of what gets uploaded, and nothing else reproduces it.
    expect(evidenceHash).toBe(keccak256(sealed.box))
    expect(keccak256(bundle.payload)).not.toBe(evidenceHash)

    const opened = decodeBundle(openEnvelope(MASTER_KEY, ngoContext(NGO), sealed.wrappedDek, sealed.box))
    expect(opened.manifest.notes).toBe(manifest.notes)
    expect(opened.files).toHaveLength(2)
    expect(Buffer.from(opened.files[0]!.data, 'base64').includes(Buffer.from('Exif', 'latin1'))).toBe(false)
    expect(Buffer.from(opened.files[1]!.data, 'base64').toString()).toBe('item,qty\nrice,120\n')
  })

  it('keeps free-text notes out of the manifest that is stored in the database', () => {
    const bundle = buildBundle(manifest, [
      { name: 'photo.jpg', contentType: 'image/jpeg', data: photoWithExif },
    ])

    expect(JSON.stringify(bundle.storedManifest)).not.toContain('Ana Ruiz')
    expect(bundle.storedManifest).toMatchObject({ deliveryId: '7', itemsDelivered: 120, regionCode: 'ES-CM' })
    expect(bundle.storedManifest.files[0]).toMatchObject({ name: 'photo.jpg', format: 'jpeg' })
    expect(bundle.removedMetadata).toEqual(['photo.jpg:APP1'])
  })

  it('is unreadable by another NGO and readable through a verifier grant', () => {
    const bundle = buildBundle(manifest, [
      { name: 'a.txt', contentType: 'text/plain', data: Buffer.from('x') },
    ])
    const sealed = sealEnvelope(MASTER_KEY, ngoContext(NGO), bundle.payload)

    expect(() =>
      openEnvelope(
        MASTER_KEY,
        ngoContext('0x0000000000000000000000000000000000000001'),
        sealed.wrappedDek,
        sealed.box,
      ),
    ).toThrow()

    const grant = rewrapDek(MASTER_KEY, ngoContext(NGO), grantContext(VERIFIER), sealed.wrappedDek)
    const opened = decodeBundle(openEnvelope(MASTER_KEY, grantContext(VERIFIER), grant, sealed.box))
    expect(opened.manifest.deliveryId).toBe('7')
  })

  it('sanitises file names so a path can never escape the bundle', () => {
    const bundle = buildBundle(manifest, [
      { name: '../../etc/passwd', contentType: 'text/plain', data: Buffer.from('x') },
    ])
    expect(bundle.storedManifest.files[0]?.name).toBe('.._.._etc_passwd')
  })
})

describe('content addressing', () => {
  it('computes a real CIDv1 (raw, sha2-256)', async () => {
    // Known vector: `ipfs add --cid-version 1 --raw-leaves` of the bytes "hello world".
    expect(await computeCidV1(Buffer.from('hello world'))).toBe(
      'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
    )
    const a = await computeCidV1(Buffer.from('one'))
    const b = await computeCidV1(Buffer.from('two'))
    expect(a).not.toBe(b)
  })
})
