import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isFresh, readDossier, storeDossier, vaultSignIn } from './vault.ts'

const BASE = 'https://vault.example'
const WALLET = '0x00000000000000000000000000000000000000a1'

/** A vault that answers like the real one, recording what it was asked. */
const fakeVault = () => {
  const calls: { path: string; init: RequestInit }[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace(BASE, '')
    calls.push({ path, init: init ?? {} })
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
    if (path === '/auth/nonce')
      return json(200, { nonce: 'n1', message: 'Sign in to the VerifAid PII vault. n1' })
    if (path === '/auth/verify') {
      const body = JSON.parse(String(init?.body)) as { signature: string }
      return body.signature === '0xsigned'
        ? json(200, {
            token: 't1',
            address: WALLET,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          })
        : json(401, { message: 'SIWE signature did not verify' })
    }
    const auth = new Headers(init?.headers).get('authorization')
    if (auth !== 'Bearer t1') return json(401, { message: 'Missing bearer token' })
    if (path === '/dossiers') return json(201, { hash: '0xabc', ngoAddress: WALLET, needId: null })
    if (path === '/dossiers/0xabc') {
      return json(200, {
        hash: '0xabc',
        ciphertextHash: '0xabc',
        hashMatches: true,
        ngoAddress: WALLET,
        needId: null,
        role: 'verifier',
        createdAt: '2026-09-25T00:00:00Z',
        assessment: { summary: 'Forty households without water.' },
      })
    }
    return json(404, { message: 'No dossier stored for that hash' })
  }) as typeof fetch
  return { calls, options: { baseUrl: BASE, fetchImpl } }
}

describe('the vault client', () => {
  it('signs the message the vault wrote, and trades the signature for a token', async () => {
    const vault = fakeVault()
    let signed = ''
    const session = await vaultSignIn(vault.options, WALLET, async (message) => {
      signed = message
      return '0xsigned'
    })
    assert.equal(
      signed,
      'Sign in to the VerifAid PII vault. n1',
      'the wallet signs exactly what the vault wrote',
    )
    assert.ok(session.ok)
    assert.equal(session.ok && session.data.token, 't1')
    assert.equal(JSON.parse(String(vault.calls[0]?.init.body)).address, WALLET)
  })

  it('reports a refused signature or a failed verification instead of throwing', async () => {
    const vault = fakeVault()
    const refused = await vaultSignIn(vault.options, WALLET, async () => {
      throw new Error('User rejected the request.\nDetails: …')
    })
    assert.deepEqual(refused, { ok: false, error: 'User rejected the request.' })
    const bad = await vaultSignIn(vault.options, WALLET, async () => '0xforged')
    assert.equal(bad.ok, false)
    assert.equal(!bad.ok && bad.status, 401)
  })

  it('stores an assessment in the shape the vault expects, with the token', async () => {
    const vault = fakeVault()
    const stored = await storeDossier(vault.options, 't1', 'Forty households without water.')
    assert.ok(stored.ok)
    assert.equal(stored.ok && stored.data.hash, '0xabc')
    const sent = JSON.parse(String(vault.calls[0]?.init.body))
    assert.deepEqual(sent, { assessment: { summary: 'Forty households without water.' } })
  })

  it('reads a dossier with the token, and passes on the status of a refusal', async () => {
    const vault = fakeVault()
    const read = await readDossier(vault.options, 't1', '0xabc')
    assert.ok(
      read.ok && read.data.hashMatches && read.data.assessment.summary === 'Forty households without water.',
    )
    const missing = await readDossier(vault.options, 't1', '0xdef')
    assert.equal(!missing.ok && missing.status, 404)
    const noToken = await readDossier(vault.options, 'nope', '0xabc')
    assert.equal(!noToken.ok && noToken.status, 401)
  })

  it('keeps a session only while it has more than a minute left', () => {
    const now = Date.parse('2026-09-25T12:00:00Z')
    const session = (inMs: number) =>
      ({ token: 't', address: WALLET, expiresAt: new Date(now + inMs).toISOString() }) as const
    assert.equal(isFresh(session(3_600_000), now), true)
    assert.equal(isFresh(session(30_000), now), false)
    assert.equal(isFresh(null, now), false)
  })
})
