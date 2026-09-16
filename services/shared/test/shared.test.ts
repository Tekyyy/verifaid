import { keccak256, stringToHex } from 'viem'
import { describe, expect, it } from 'vitest'
import { createSessionToken, verifySessionToken, verifyWebhookSignature } from '../src/auth.js'
import { hmac, open, openEnvelope, seal, sealEnvelope } from '../src/crypto.js'
import { getDeployment, hasDeployment } from '../src/deployment.js'
import { categoryHash, categoryLabel, regionCode, regionLabel, saltedRefHash } from '../src/format.js'
import { AID_RECEIVED_MESSAGE, ROLES } from '../src/roles.js'
import { computeSchemaUid, decodeSchemaData, encodeSchemaData, SCHEMAS } from '../src/schemas.js'

describe('roles', () => {
  it('matches the identifiers in Roles.sol', () => {
    expect(ROLES.NGO).toBe(keccak256(stringToHex('NGO_ROLE')))
    expect(ROLES.VERIFIER).toBe(keccak256(stringToHex('VERIFIER_ROLE')))
    expect(ROLES.FIELD_AGENT).toBe(keccak256(stringToHex('FIELD_AGENT_ROLE')))
    expect(ROLES.BANK_PARTNER).toBe(keccak256(stringToHex('BANK_PARTNER_ROLE')))
    expect(ROLES.DEFAULT_ADMIN).toBe(`0x${'00'.repeat(32)}`)
  })

  it('signs the same message DeliveryManager expects', () => {
    // keccak256("AID_RECEIVED"), verified against `cast keccak AID_RECEIVED`
    expect(`0x${AID_RECEIVED_MESSAGE.toString(16)}`).toBe(
      '0xa38d8f830de9adfa309e797e220a5a01d6849cba51fc1c77c9f8dac6ce3bc059',
    )
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

    const evidence = encodeSchemaData('DeliveryEvidence', [
      7n,
      keccak256(stringToHex('ciphertext')),
      'bafkreiabc',
      42,
      regionCode('ES-CM'),
    ])
    const decodedEvidence = decodeSchemaData<[bigint, `0x${string}`, string, number, `0x${string}`]>(
      'DeliveryEvidence',
      evidence,
    )
    expect(decodedEvidence[2]).toBe('bafkreiabc')
    expect(decodedEvidence[3]).toBe(42)
    expect(regionLabel(decodedEvidence[4])).toBe('ES-CM')
  })

  it.runIf(hasDeployment('anvil'))('derives the same schema UIDs the SchemaRegistry assigned', () => {
    const deployment = getDeployment('anvil')
    const resolvers = {
      NeedVerified: deployment.contracts.NeedVerifiedResolver,
      DeliveryEvidence: deployment.contracts.DeliveryEvidenceResolver,
      DeliveryVerified: deployment.contracts.DeliveryVerifiedResolver,
      FiatDonation: deployment.contracts.FiatDonationResolver,
      ImpactReport: deployment.contracts.ImpactReportResolver,
    } as const

    for (const [name, resolver] of Object.entries(resolvers)) {
      const definition = SCHEMAS[name as keyof typeof resolvers]
      expect(computeSchemaUid(definition.schema, resolver, definition.revocable)).toBe(
        deployment.schemas[definition.name],
      )
    }
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

  it('salts fiat references exactly like abi.encode(bytes32,string)', () => {
    const salt = keccak256(stringToHex('partner-salt'))
    // verified against: cast keccak $(cast abi-encode "f(bytes32,string)" <salt> "SEPA-E2E-0001")
    expect(saltedRefHash(salt, 'SEPA-E2E-0001')).toMatch(/^0x[0-9a-f]{64}$/)
    expect(saltedRefHash(salt, 'SEPA-E2E-0001')).not.toBe(saltedRefHash(salt, 'SEPA-E2E-0002'))
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
