import assert from 'node:assert/strict'
import { generateKeyPairSync, type KeyObject, verify } from 'node:crypto'
import { describe, it } from 'node:test'
import { buildCdpJwt, parseCdpSecret } from './cdpJwt.ts'

/** Run with `pnpm --filter @poa/app test` (Node's own runner and type stripping; no test dependency). */

const decode = (segment: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>

const split = (token: string) => {
  const [header = '', claims = '', signature = ''] = token.split('.')
  return {
    header: decode(header),
    claims: decode(claims),
    signingInput: Buffer.from(`${header}.${claims}`),
    signature: Buffer.from(signature, 'base64url'),
  }
}

/** A CDP-style Ed25519 secret: base64(seed ‖ public key), from a freshly generated key pair. */
const ed25519Secret = (): { secret: string; publicKey: KeyObject } => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32)
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  return { secret: Buffer.concat([seed, raw]).toString('base64'), publicKey }
}

const request = {
  keyId: 'organizations/org-id/apiKeys/key-id',
  method: 'POST',
  host: 'api.developer.coinbase.com',
  path: '/onramp/v1/token',
  now: 1_800_000_000,
} as const

const expectClaims = (header: Record<string, unknown>, claims: Record<string, unknown>, alg: string) => {
  assert.equal(header.alg, alg)
  assert.equal(header.kid, request.keyId)
  assert.equal(header.typ, 'JWT')
  assert.match(String(header.nonce), /^[0-9a-f]{32}$/)
  assert.deepEqual(claims, {
    sub: request.keyId,
    iss: 'cdp',
    aud: ['cdp_service'],
    nbf: request.now,
    exp: request.now + 120,
    uri: 'POST api.developer.coinbase.com/onramp/v1/token',
  })
}

describe('buildCdpJwt', () => {
  it('signs with an Ed25519 secret (EdDSA) that verifies against the public key', () => {
    const { secret, publicKey } = ed25519Secret()
    const { header, claims, signingInput, signature } = split(buildCdpJwt({ ...request, keySecret: secret }))
    expectClaims(header, claims, 'EdDSA')
    assert.equal(signature.length, 64)
    assert.ok(verify(null, signingInput, publicKey, signature))
  })

  it('signs with an EC P-256 PEM secret (ES256, raw r‖s) that verifies against the public key', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const pem = privateKey.export({ format: 'pem', type: 'sec1' }).toString()
    const { header, claims, signingInput, signature } = split(buildCdpJwt({ ...request, keySecret: pem }))
    expectClaims(header, claims, 'ES256')
    assert.equal(signature.length, 64)
    assert.ok(verify('sha256', signingInput, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature))
  })

  it('accepts a PEM whose newlines were escaped in a .env file', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const escaped = privateKey.export({ format: 'pem', type: 'sec1' }).toString().replace(/\n/g, '\\n')
    assert.equal(parseCdpSecret(escaped).alg, 'ES256')
  })

  it('uses a fresh nonce for every token', () => {
    const { secret } = ed25519Secret()
    const first = split(buildCdpJwt({ ...request, keySecret: secret })).header.nonce
    const second = split(buildCdpJwt({ ...request, keySecret: secret })).header.nonce
    assert.notEqual(first, second)
  })

  it('rejects malformed secrets without echoing them', () => {
    const { secret } = ed25519Secret()
    const raw = Buffer.from(secret, 'base64')
    const wrongLength = raw.subarray(0, 48).toString('base64')
    const mismatched = Buffer.concat([raw.subarray(0, 32), Buffer.alloc(32, 7)]).toString('base64')
    for (const bad of [wrongLength, mismatched, 'not base64 at all!']) {
      assert.throws(
        () => parseCdpSecret(bad),
        (error: Error) => !error.message.includes(bad),
      )
    }
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp384r1' })
    assert.throws(() => parseCdpSecret(privateKey.export({ format: 'pem', type: 'sec1' }).toString()))
  })
})
