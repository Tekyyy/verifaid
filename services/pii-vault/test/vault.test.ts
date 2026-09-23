import { prisma } from '@poa/shared/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { createHarness, ensureSecondNgo, type Harness, roleAccount } from './helpers/chain.js'
import { CHAIN_SKIP, chainAvailable, POSTGRES_SKIP, postgresAvailable, testConfig } from './helpers/env.js'
import { bearer, login } from './helpers/http.js'

/**
 * The vault's two promises: an NGO can read back exactly what it stored, and nothing — not another NGO, not the
 * vault itself after a deletion — can read it otherwise.
 */

const hasPostgres = await postgresAvailable()
const hasChain = await chainAvailable()
const skipReason = !hasPostgres ? POSTGRES_SKIP : !hasChain ? CHAIN_SKIP : null
// Written to the raw stream: vitest swallows `console` output produced while it is still collecting files, and a
// silent skip is indistinguishable from a suite that never existed.
if (skipReason) process.stderr.write(`\n[pii-vault] SKIPPING chain + database tests: ${skipReason}\n\n`)

const PROGRAM_ID = '1'
const PROFILE = {
  name: 'María Lopez',
  contact: '+34 600 111 222',
  householdSize: 5,
  address: 'Calle Mayor 3, Toledo',
  notes: 'Prefers pick-up on Thursdays',
}

/** A fresh commitment per run, so the suite is repeatable against a long-lived local chain. */
const freshCommitment = (): string => `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`

describe.skipIf(Boolean(skipReason))('beneficiary records', () => {
  let app: FastifyInstance
  let harness: Harness
  let ngoToken: string

  beforeAll(async () => {
    harness = createHarness()
    app = await buildApp(testConfig())
    await app.ready()
    ngoToken = await login(app, roleAccount('ngo'))
  }, 60_000)

  afterAll(async () => {
    await app?.close()
  })

  const enrol = async (commitment: string) => {
    const response = await app.inject({
      method: 'POST',
      url: '/beneficiaries',
      headers: bearer(ngoToken),
      payload: { programId: PROGRAM_ID, commitment, profile: PROFILE },
    })
    expect(response.statusCode, response.body).toBe(201)
    return response.json<{ id: string; commitment: string }>()
  }

  it('creates, reads back and then makes the record unreadable when the key is destroyed', async () => {
    const commitment = freshCommitment()
    const created = await enrol(commitment)

    const read = await app.inject({
      method: 'GET',
      url: `/beneficiaries/${created.id}`,
      headers: bearer(ngoToken),
    })
    expect(read.statusCode).toBe(200)
    expect(read.json<{ profile: typeof PROFILE }>().profile).toEqual(PROFILE)

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/beneficiaries/${created.id}`,
      headers: bearer(ngoToken),
    })
    expect(deleted.statusCode).toBe(200)
    const body = deleted.json<{ commitment: string; alreadyShredded: boolean }>()
    expect(body.commitment).toBe(commitment)
    expect(body.alreadyShredded).toBe(false)

    const afterDelete = await app.inject({
      method: 'GET',
      url: `/beneficiaries/${created.id}`,
      headers: bearer(ngoToken),
    })
    expect(afterDelete.statusCode).toBe(410)
    expect(afterDelete.json<{ message: string }>().message).toContain('crypto-shredded')

    // The row and its ciphertext survive — only the data key is gone, which is what makes it unrecoverable.
    const row = await prisma().beneficiary.findUnique({ where: { id: created.id } })
    expect(row?.wrappedDek).toBeNull()
    expect(row?.shreddedAt).toBeInstanceOf(Date)
    expect(row?.ciphertext.length).toBeGreaterThan(0)
    expect(Buffer.from(row!.ciphertext).toString('utf8')).not.toContain('María')
  }, 60_000)

  it('never returns personal data from the list endpoint', async () => {
    const commitment = freshCommitment()
    const created = await enrol(commitment)

    const list = await app.inject({
      method: 'GET',
      url: `/beneficiaries?programId=${PROGRAM_ID}`,
      headers: bearer(ngoToken),
    })
    expect(list.statusCode).toBe(200)
    expect(list.body).not.toContain('María')
    expect(list.body).not.toContain('600 111 222')

    const body = list.json<{ beneficiaries: { id: string; commitment: string; shredded: boolean }[] }>()
    const entry = body.beneficiaries.find((item) => item.id === created.id)
    expect(entry).toMatchObject({ commitment, shredded: false })
  }, 60_000)

  it('rejects a duplicate commitment in the same program', async () => {
    const commitment = freshCommitment()
    await enrol(commitment)
    const again = await app.inject({
      method: 'POST',
      url: '/beneficiaries',
      headers: bearer(ngoToken),
      payload: { programId: PROGRAM_ID, commitment, profile: PROFILE },
    })
    expect(again.statusCode).toBe(409)
  }, 60_000)

  it('refuses another NGO: it can neither read nor enrol into a program it does not own', async () => {
    const created = await enrol(freshCommitment())
    const ngoB = await ensureSecondNgo(harness)
    const ngoBToken = await login(app, ngoB)

    const read = await app.inject({
      method: 'GET',
      url: `/beneficiaries/${created.id}`,
      headers: bearer(ngoBToken),
    })
    expect(read.statusCode).toBe(403)
    expect(read.body).not.toContain('María')

    const write = await app.inject({
      method: 'POST',
      url: '/beneficiaries',
      headers: bearer(ngoBToken),
      payload: { programId: PROGRAM_ID, commitment: freshCommitment(), profile: PROFILE },
    })
    expect(write.statusCode).toBe(403)

    const list = await app.inject({
      method: 'GET',
      url: `/beneficiaries?programId=${PROGRAM_ID}`,
      headers: bearer(ngoBToken),
    })
    expect(list.statusCode).toBe(403)

    const erase = await app.inject({
      method: 'DELETE',
      url: `/beneficiaries/${created.id}`,
      headers: bearer(ngoBToken),
    })
    expect(erase.statusCode).toBe(403)
  }, 120_000)

  it('refuses an address that holds no NGO role at all', async () => {
    const donorToken = await login(app, roleAccount('donor1'))
    const response = await app.inject({
      method: 'POST',
      url: '/beneficiaries',
      headers: bearer(donorToken),
      payload: { programId: PROGRAM_ID, commitment: freshCommitment(), profile: PROFILE },
    })
    expect(response.statusCode).toBe(403)
  }, 60_000)

  it('requires a session', async () => {
    const response = await app.inject({ method: 'GET', url: `/beneficiaries?programId=${PROGRAM_ID}` })
    expect(response.statusCode).toBe(401)
  })
})

describe.skipIf(Boolean(skipReason))('needs assessment dossiers', () => {
  let app: FastifyInstance
  let ngoToken: string

  const ASSESSMENT = {
    summary: 'Flooding in the ES-CM subdivision left 240 households without dry food stores.',
    households: 240,
    methodology: 'Door-to-door survey with the municipality, 2026-09-10 to 2026-09-12.',
    sources: ['municipal register', 'field team report'],
  }

  beforeAll(async () => {
    app = await buildApp(testConfig())
    await app.ready()
    ngoToken = await login(app, roleAccount('ngo'))
  }, 60_000)

  afterAll(async () => {
    await app?.close()
  })

  it('returns the ciphertext hash the need carries on-chain, and lets a verifier recompute it', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/dossiers',
      headers: bearer(ngoToken),
      payload: { assessment: ASSESSMENT },
    })
    expect(created.statusCode, created.body).toBe(201)
    const { hash } = created.json<{ hash: string }>()
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/)

    const asNgo = await app.inject({ method: 'GET', url: `/dossiers/${hash}`, headers: bearer(ngoToken) })
    expect(asNgo.statusCode).toBe(200)
    expect(asNgo.json<{ role: string }>().role).toBe('ngo')

    const verifierToken = await login(app, roleAccount('verifier1'))
    const asVerifier = await app.inject({
      method: 'GET',
      url: `/dossiers/${hash}`,
      headers: bearer(verifierToken),
    })
    expect(asVerifier.statusCode, asVerifier.body).toBe(200)

    const body = asVerifier.json<{
      role: string
      ciphertextHash: string
      hashMatches: boolean
      assessment: typeof ASSESSMENT
    }>()
    expect(body.role).toBe('verifier')
    expect(body.assessment).toEqual(ASSESSMENT)
    // The verifier compares this against the need's on-chain dossierHash.
    expect(body.ciphertextHash).toBe(hash)
    expect(body.hashMatches).toBe(true)
  }, 90_000)

  it('refuses a caller who is neither the owning NGO nor a registered verifier', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/dossiers',
      headers: bearer(ngoToken),
      payload: { assessment: ASSESSMENT },
    })
    const { hash } = created.json<{ hash: string }>()

    const donorToken = await login(app, roleAccount('donor1'))
    const response = await app.inject({
      method: 'GET',
      url: `/dossiers/${hash}`,
      headers: bearer(donorToken),
    })
    expect(response.statusCode).toBe(403)
    expect(response.body).not.toContain('Flooding')
  }, 90_000)

  it('returns 404 for an unknown hash', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/dossiers/0x${'11'.repeat(32)}`,
      headers: bearer(ngoToken),
    })
    expect(response.statusCode).toBe(404)
  }, 30_000)
})

describe('health and docs', () => {
  it('serves /health and the OpenAPI document without a session', async () => {
    const app = await buildApp(testConfig())
    await app.ready()
    try {
      const health = await app.inject({ method: 'GET', url: '/health' })
      expect(health.statusCode).toBe(200)
      expect(health.json<{ service: string }>().service).toBe('pii-vault')

      const docs = await app.inject({ method: 'GET', url: '/docs/json' })
      expect(docs.statusCode).toBe(200)
      const paths = Object.keys(docs.json<{ paths: Record<string, unknown> }>().paths)
      expect(paths).toEqual(expect.arrayContaining(['/beneficiaries', '/beneficiaries/{id}', '/dossiers']))
    } finally {
      await app.close()
    }
  }, 30_000)
})
