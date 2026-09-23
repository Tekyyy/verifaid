import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { sha256Hex } from './evidenceFiles.ts'
import { fetchPinned, isCid, pinFile, pinningEnabled } from './ipfs.ts'

const CID = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy'
const bytes = new TextEncoder().encode('%PDF-1.7 receipt')

describe('pinning evidence to IPFS', () => {
  it('is off without a key, and then pins nothing', async () => {
    assert.equal(pinningEnabled({}), false)
    let called = false
    const cid = await pinFile(bytes, 'a.pdf', 'application/pdf', {
      env: {},
      fetchImpl: (async () => {
        called = true
        return new Response('{}')
      }) as typeof fetch,
    })
    assert.equal(cid, null)
    assert.equal(called, false)
  })

  it('sends the file with the key and returns the CID Pinata gives back', async () => {
    let auth: string | null = null
    const cid = await pinFile(bytes, 'a.pdf', 'application/pdf', {
      env: { PINATA_JWT: 'jwt-123' },
      fetchImpl: (async (_url: string, init: RequestInit) => {
        auth = new Headers(init.headers).get('authorization')
        return Response.json({ IpfsHash: CID })
      }) as typeof fetch,
    })
    assert.equal(cid, CID)
    assert.equal(auth, 'Bearer jwt-123')
  })

  it('treats a failed or strange answer as not pinned, without failing the upload', async () => {
    const env = { PINATA_JWT: 'jwt' }
    const refused = (async () => new Response('nope', { status: 401 })) as typeof fetch
    const odd = (async () => Response.json({ IpfsHash: '../../etc/passwd' })) as typeof fetch
    const down = (async () => {
      throw new Error('offline')
    }) as typeof fetch
    for (const fetchImpl of [refused, odd, down]) {
      assert.equal(await pinFile(bytes, 'a.pdf', 'application/pdf', { env, fetchImpl }), null)
    }
  })
})

describe('reading a pinned file back', () => {
  const serve = (body: Uint8Array) => (async () => new Response(new Uint8Array(body))) as typeof fetch

  it('returns the bytes when they are the ones the chain committed to', async () => {
    const got = await fetchPinned(CID, sha256Hex(bytes), { env: {}, fetchImpl: serve(bytes) })
    assert.deepEqual(got, bytes)
  })

  it('refuses other bytes, whatever the gateway says', async () => {
    const other = new TextEncoder().encode('forged')
    assert.equal(await fetchPinned(CID, sha256Hex(bytes), { env: {}, fetchImpl: serve(other) }), null)
  })

  it('never asks a gateway for something that is not a CID', async () => {
    assert.equal(isCid('../x'), false)
    assert.equal(await fetchPinned('../x', sha256Hex(bytes), { env: {}, fetchImpl: serve(bytes) }), null)
  })
})
