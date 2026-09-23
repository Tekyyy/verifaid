import { keccak256, stringToHex } from 'viem'
import { describe, expect, it } from 'vitest'
import { DONOR_STAGES, trackingRefKind } from '../src/api.js'
import { createSessionToken, verifySessionToken, verifyWebhookSignature } from '../src/auth.js'
import { hmac, open, openEnvelope, seal, sealEnvelope } from '../src/crypto.js'
import { getDeployment, hasDeployment } from '../src/deployment.js'
import { categoryHash, categoryLabel, countryOf, regionCode, regionLabel } from '../src/format.js'
import { buildManifest, MAX_MANIFEST_BYTES, manifestBytes, parseManifest } from '../src/manifest.js'
import { ROLES } from '../src/roles.js'
import {
  computeSchemaUid,
  decodeSchemaData,
  encodeSchemaData,
  SCHEMAS,
  type SettlementData,
} from '../src/schemas.js'
import { needStatusName, SCHEMA_NAMES } from '../src/types.js'

describe('roles', () => {
  it('matches the identifiers in Roles.sol', () => {
    expect(ROLES.NGO).toBe(keccak256(stringToHex('NGO_ROLE')))
    expect(ROLES.VERIFIER).toBe(keccak256(stringToHex('VERIFIER_ROLE')))
    expect(ROLES.DEFAULT_ADMIN).toBe(`0x${'00'.repeat(32)}`)
  })
})

describe('schemas', () => {
  it('round-trips attestation data through ABI encoding', () => {
    const encoded = encodeSchemaData('NeedVerified', [
      1n,
      keccak256(stringToHex('dossier')),
      true,
      keccak256('0x'),
    ])
    const decoded = decodeSchemaData<[bigint, `0x${string}`, boolean, `0x${string}`]>('NeedVerified', encoded)
    expect(decoded[0]).toBe(1n)
    expect(decoded[2]).toBe(true)
  })

  it.runIf(hasDeployment('anvil'))('derives the same schema UIDs the SchemaRegistry assigned', () => {
    const deployment = getDeployment('anvil')
    // one resolver serves all three schemas
    const resolver = deployment.contracts.ProofOfAidResolver
    for (const name of SCHEMA_NAMES) {
      const definition = SCHEMAS[name]
      expect(computeSchemaUid(definition.schema, resolver, definition.revocable)).toBe(
        deployment.schemas[name],
      )
    }
  })

  it('encodes Settlement payloads', () => {
    const settlement = encodeSchemaData('Settlement', [
      3n,
      0n,
      300_000000n,
      3_000000n,
      297_000000n,
      keccak256(stringToHex('invoice')),
      keccak256(stringToHex('fx')),
    ])
    expect(decodeSchemaData<SettlementData>('Settlement', settlement)[4]).toBe(297_000000n)
  })
})

describe('evidence manifests', () => {
  const file = {
    kind: 'receipt' as const,
    name: 'factura-017.pdf',
    type: 'application/pdf',
    size: 48_213,
    sha256: 'AB'.repeat(32),
    url: '/api/files/abab',
  }

  it('serialises the same evidence to the same bytes, whatever order the fields came in', () => {
    const shuffled = {
      url: file.url,
      sha256: file.sha256,
      size: file.size,
      type: file.type,
      name: file.name,
      kind: file.kind,
    }
    expect(buildManifest('  Tejas y lonas  ', [file])).toBe(buildManifest('Tejas y lonas', [shuffled]))
    expect(buildManifest('x', [file])).toContain(
      '"sha256":"abababababababababababababababababababababababababababababababab"',
    )
  })

  it('reads back what it wrote, and refuses what is not a manifest', () => {
    const text = buildManifest('Tejas y lonas', [file])
    expect(parseManifest(text)?.files[0]?.sha256).toBe('ab'.repeat(32))
    expect(parseManifest(text)?.note).toBe('Tejas y lonas')
    expect(parseManifest('not json')).toBeNull()
    expect(parseManifest(JSON.stringify({ v: 2, note: '', files: [] }))).toBeNull()
    expect(parseManifest(JSON.stringify({ v: 1, note: '', files: [{ sha256: 'nope' }] }))).toBeNull()
  })

  it('keeps an IPFS address only when the file has one, and only a well-formed one', () => {
    const cid = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy'
    expect(buildManifest('x', [file])).not.toContain('cid')
    const pinned = buildManifest('x', [{ ...file, cid }])
    expect(pinned).toContain(`"sha256":"${'ab'.repeat(32)}","cid":"${cid}"`)
    expect(parseManifest(pinned)?.files[0]?.cid).toBe(cid)
    const forged = JSON.stringify({ v: 1, note: '', files: [{ ...file, cid: 'ipfs://../../etc' }] })
    expect(parseManifest(forged)?.files[0]?.cid).toBeUndefined()
  })

  it('never hands a script link to the page', () => {
    const text = JSON.stringify({
      v: 1,
      note: '',
      files: [{ ...file, url: 'javascript:alert(1)', kind: 'weird' }],
    })
    const parsed = parseManifest(text)
    expect(parsed?.files[0]?.url).toBe('')
    expect(parsed?.files[0]?.kind).toBe('other')
  })

  it('measures size in UTF-8 bytes, as the contract does', () => {
    expect(manifestBytes('ñ')).toBe(2)
    expect(MAX_MANIFEST_BYTES).toBe(8192)
  })
})

describe('tracking references', () => {
  it('tells receipt ids from deposit addresses, and refuses anything else', () => {
    expect(trackingRefKind('12')).toBe('receipt')
    expect(trackingRefKind('0x5ce1a0de9f7b2c4d6e8f0a1b3c5d7e9f2a4b6c8d')).toBe('deposit')
    // a 32-byte hash was a payment reference; nothing issues those any more
    expect(trackingRefKind(keccak256(stringToHex('payment')))).toBeNull()
    expect(trackingRefKind('0')).toBeNull()
    expect(trackingRefKind('0x1234')).toBeNull()
    expect(trackingRefKind('../etc/passwd')).toBeNull()
  })

  it('names the five donor stages in the order the proposal gives them', () => {
    expect(DONOR_STAGES).toEqual(['Verified', 'Funded', 'Settled', 'Delivered', 'ImpactConfirmed'])
    expect(countryOf('ES-CM')).toBe('ES')
    expect(needStatusName(7)).toBe('Expired')
  })
})

describe('formatting', () => {
  it('encodes coarse region codes the way Solidity does', () => {
    // Solidity: bytes32("ES-CM") — left aligned ASCII, right padded with zeros
    expect(regionCode('ES-CM')).toBe('0x45532d434d000000000000000000000000000000000000000000000000000000')
    expect(regionLabel(regionCode('ES-CM'))).toBe('ES-CM')
  })

  it('labels known categories and falls back for unknown ones', () => {
    expect(categoryLabel(categoryHash('FOOD'))).toBe('FOOD')
    expect(categoryLabel(keccak256(stringToHex('SOMETHING_ELSE')))).toContain('…')
  })
})

describe('envelope encryption', () => {
  const masterKey = Buffer.alloc(32, 7)

  it('encrypts and decrypts a record', () => {
    const plaintext = Buffer.from(JSON.stringify({ name: 'Jane Doe', householdSize: 4 }))
    const { box, wrappedDek } = sealEnvelope(masterKey, 'ngo:0xabc', plaintext)
    expect(box).not.toContain(plaintext)
    expect(openEnvelope(masterKey, 'ngo:0xabc', wrappedDek, box).toString()).toBe(plaintext.toString())
  })

  it('is unreadable once the data key is shredded', () => {
    const { box } = sealEnvelope(masterKey, 'ngo:0xabc', Buffer.from('secret'))
    // the wrapped DEK is gone: nothing derived from the master key can open the box any more
    expect(() => open(Buffer.alloc(32, 9), box)).toThrow()
  })

  it('rejects tampered ciphertext', () => {
    const key = Buffer.alloc(32, 3)
    const box = seal(key, Buffer.from('payload'))
    box[box.length - 1] ^= 0xff
    expect(() => open(key, box)).toThrow()
  })

  it('binds a context: another NGO cannot open the envelope', () => {
    const { box, wrappedDek } = sealEnvelope(masterKey, 'ngo:0xaaa', Buffer.from('records'))
    expect(() => openEnvelope(masterKey, 'ngo:0xbbb', wrappedDek, box)).toThrow()
  })
})

describe('sessions and webhooks', () => {
  it('accepts its own tokens and rejects tampered or expired ones', () => {
    const token = createSessionToken('secret', '0x1111111111111111111111111111111111111111')
    expect(verifySessionToken('secret', token)?.address).toBe('0x1111111111111111111111111111111111111111')
    expect(verifySessionToken('other-secret', token)).toBeNull()
    expect(verifySessionToken('secret', `${token}x`)).toBeNull()

    const expired = createSessionToken('secret', '0x1111111111111111111111111111111111111111', -10)
    expect(verifySessionToken('secret', expired)).toBeNull()
  })

  it('verifies webhook signatures in constant time', () => {
    const body = JSON.stringify({ endToEndId: 'SEPA-1' })
    const signature = `sha256=${hmac('webhook-secret', body).toString('hex')}`
    expect(verifyWebhookSignature('webhook-secret', body, signature)).toBe(true)
    expect(verifyWebhookSignature('webhook-secret', body, 'sha256=deadbeef')).toBe(false)
    expect(verifyWebhookSignature('webhook-secret', body, undefined)).toBe(false)
  })
})
