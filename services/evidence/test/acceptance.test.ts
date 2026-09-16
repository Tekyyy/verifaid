import { decodeSchemaData } from '@poa/shared'
import { prisma } from '@poa/shared/db'
import type { FastifyInstance } from 'fastify'
import type { Hex } from 'viem'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { CHAIN_SKIP, chainAvailable, POSTGRES_SKIP, postgresAvailable, testConfig } from './helpers/env.js'
import { login, multipartBody } from './helpers/http.js'
import {
  attestDeliveryEvidence,
  createHarness,
  createNeedInDelivery,
  type Harness,
  openDelivery,
  readAttestation,
} from './helpers/lifecycle.js'
import { roleAccount } from './helpers/wallets.js'

/**
 * Phase 4 acceptance criterion (spec §12): the hash the evidence service returns for an upload is the hash the
 * `DeliveryEvidence` attestation carries on-chain. Anything less proves only that the service can encrypt.
 */

const hasPostgres = await postgresAvailable()
const hasChain = await chainAvailable()
const skipReason = !hasPostgres ? POSTGRES_SKIP : !hasChain ? CHAIN_SKIP : null
// Written to the raw stream: vitest swallows `console` output produced while it is still collecting files, and a
// silent skip is indistinguishable from a suite that never existed.
if (skipReason) process.stderr.write(`\n[evidence] SKIPPING chain + database tests: ${skipReason}\n\n`)

const PHOTO = Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0', 'latin1'), 1, 1, 0, 0, 1, 0, 1, 0, 0]),
  Buffer.from([0xff, 0xe1, 0x00, 0x1a, ...Buffer.from('Exif\0\0II*\0GPS 41.65,-4.72', 'latin1')]),
  Buffer.from([0xff, 0xda, 0x00, 0x04, 0x01, 0x01]),
  Buffer.from([0x5a, 0x5b, 0x5c, 0x5d]),
  Buffer.from([0xff, 0xd9]),
])

const NOTES = 'Distributed at the parish hall. Contact person: Ana Ruiz, +34 600 000 000.'
const ITEMS_DELIVERED = 120

describe.skipIf(Boolean(skipReason))('evidence upload anchored on-chain', () => {
  let app: FastifyInstance
  let harness: Harness
  let deliveryId: bigint
  let fieldAgentToken: string
  let uploaded: { cid: string; evidenceHash: Hex }

  beforeAll(async () => {
    harness = createHarness()
    app = await buildApp(testConfig())
    await app.ready()

    const need = await createNeedInDelivery(harness)
    deliveryId = await openDelivery(harness, need.needId)

    fieldAgentToken = await login(app, roleAccount('fieldAgent'))
    const { payload, headers } = await multipartBody(
      {
        manifest: JSON.stringify({
          deliveryId: deliveryId.toString(),
          itemsDelivered: ITEMS_DELIVERED,
          regionCode: 'ES-CM',
          notes: NOTES,
        }),
      },
      [
        { field: 'files', filename: 'IMG_0042.jpg', contentType: 'image/jpeg', data: PHOTO },
        {
          field: 'files',
          filename: 'packing-list.csv',
          contentType: 'text/csv',
          data: Buffer.from('item,qty\nrice 5kg,120\n'),
        },
      ],
    )

    const response = await app.inject({
      method: 'POST',
      url: '/evidence',
      headers: { ...headers, authorization: `Bearer ${fieldAgentToken}` },
      payload,
    })
    expect(response.statusCode, response.body).toBe(201)
    uploaded = response.json<{ cid: string; evidenceHash: Hex }>()
  }, 180_000)

  afterAll(async () => {
    await app?.close()
  })

  it('returns a content address and the keccak256 of the ciphertext', () => {
    expect(uploaded.cid).toMatch(/^bafk/)
    expect(uploaded.evidenceHash).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('strips camera metadata before anything is encrypted', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/evidence/${uploaded.cid}`,
      headers: { authorization: `Bearer ${fieldAgentToken}` },
    })
    expect(response.statusCode).toBe(200)

    const body = response.json<{ files: { name: string; data: string }[] }>()
    const photo = Buffer.from(body.files[0]!.data, 'base64')
    expect(photo.includes(Buffer.from('Exif', 'latin1'))).toBe(false)
    expect(photo.includes(Buffer.from('GPS 41.65,-4.72', 'latin1'))).toBe(false)
    // The scan data and the JFIF header survive, so the photo still decodes.
    expect(photo.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    expect(photo.includes(Buffer.from([0x5a, 0x5b, 0x5c, 0x5d]))).toBe(true)
  })

  it('anchors exactly the uploaded hash in the on-chain DeliveryEvidence attestation', async () => {
    const uid = await attestDeliveryEvidence(harness, {
      deliveryId,
      evidenceHash: uploaded.evidenceHash,
      cid: uploaded.cid,
      itemsDelivered: ITEMS_DELIVERED,
    })
    expect(uid).not.toBe(`0x${'00'.repeat(32)}`)

    const attestation = await readAttestation(harness, uid)
    const [attestedDeliveryId, attestedHash, attestedCid, attestedItems] = decodeSchemaData<
      [bigint, Hex, string, number, Hex]
    >('DeliveryEvidence', attestation.data)

    expect(attestedHash).toBe(uploaded.evidenceHash)
    expect(attestedCid).toBe(uploaded.cid)
    expect(attestedDeliveryId).toBe(deliveryId)
    expect(attestedItems).toBe(ITEMS_DELIVERED)
    expect(attestation.attester.toLowerCase()).toBe(roleAccount('fieldAgent').address.toLowerCase())
    expect(attestation.recipient).toBe(harness.deployment.contracts.DeliveryManager)
  }, 60_000)

  it('lets an independent verifier read the bundle and records the key grant', async () => {
    const verifierToken = await login(app, roleAccount('verifier1'))
    const response = await app.inject({
      method: 'GET',
      url: `/evidence/${uploaded.cid}`,
      headers: { authorization: `Bearer ${verifierToken}` },
    })

    expect(response.statusCode, response.body).toBe(200)
    const body = response.json<{ role: string; manifest: { notes?: string } }>()
    expect(body.role).toBe('verifier')
    expect(body.manifest.notes).toBe(NOTES)

    const grants = await prisma().keyGrant.findMany({ where: { evidenceCid: uploaded.cid } })
    expect(grants).toHaveLength(1)
    expect(grants[0]?.granteeAddress).toBe(roleAccount('verifier1').address)

    // A second read reuses the same grant instead of creating a new one.
    await app.inject({
      method: 'GET',
      url: `/evidence/${uploaded.cid}`,
      headers: { authorization: `Bearer ${verifierToken}` },
    })
    expect(await prisma().keyGrant.count({ where: { evidenceCid: uploaded.cid } })).toBe(1)
  }, 60_000)

  it('refuses a caller with no role over the delivery', async () => {
    const donorToken = await login(app, roleAccount('donor1'))
    const response = await app.inject({
      method: 'GET',
      url: `/evidence/${uploaded.cid}`,
      headers: { authorization: `Bearer ${donorToken}` },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json<{ error: string }>().error).toBe('FORBIDDEN')
  }, 60_000)

  it('refuses an upload signed by someone who is not the delivery’s field agent', async () => {
    const ngoToken = await login(app, roleAccount('ngo'))
    const { payload, headers } = await multipartBody(
      {
        manifest: JSON.stringify({
          deliveryId: deliveryId.toString(),
          itemsDelivered: 1,
          regionCode: 'ES-CM',
        }),
      },
      [{ field: 'files', filename: 'x.jpg', contentType: 'image/jpeg', data: PHOTO }],
    )

    const response = await app.inject({
      method: 'POST',
      url: '/evidence',
      headers: { ...headers, authorization: `Bearer ${ngoToken}` },
      payload,
    })
    expect(response.statusCode).toBe(403)
  }, 60_000)

  it('rejects an upload with no session at all', async () => {
    const { payload, headers } = await multipartBody({ manifest: '{}' }, [
      { field: 'files', filename: 'x.jpg', contentType: 'image/jpeg', data: PHOTO },
    ])
    const response = await app.inject({ method: 'POST', url: '/evidence', headers, payload })
    expect(response.statusCode).toBe(401)
  })

  it('exposes only non-personal metadata on /meta', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/evidence/${uploaded.cid}/meta`,
      headers: { authorization: `Bearer ${fieldAgentToken}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.body).not.toContain('Ana Ruiz')
    expect(response.body).not.toContain('600 000 000')

    const body = response.json<{
      evidenceHash: string
      deliveryId: string
      grants: number
      manifest: { itemsDelivered: number; files: unknown[] }
    }>()
    expect(body.evidenceHash).toBe(uploaded.evidenceHash)
    expect(body.deliveryId).toBe(deliveryId.toString())
    expect(body.manifest.itemsDelivered).toBe(ITEMS_DELIVERED)
    expect(body.manifest.files).toHaveLength(2)
    expect(body.grants).toBeGreaterThanOrEqual(0)
  })

  it('rejects evidence for a region the need is not in', async () => {
    const { payload, headers } = await multipartBody(
      {
        manifest: JSON.stringify({
          deliveryId: deliveryId.toString(),
          itemsDelivered: 5,
          regionCode: 'ES-AN',
        }),
      },
      [{ field: 'files', filename: 'x.jpg', contentType: 'image/jpeg', data: PHOTO }],
    )
    const response = await app.inject({
      method: 'POST',
      url: '/evidence',
      headers: { ...headers, authorization: `Bearer ${fieldAgentToken}` },
      payload,
    })
    expect(response.statusCode).toBe(400)
    expect(response.json<{ error: string }>().error).toBe('REGION_MISMATCH')
  }, 60_000)
})

describe('health and docs', () => {
  it('serves /health and the OpenAPI document without a session', async () => {
    const app = await buildApp(testConfig())
    await app.ready()
    try {
      const health = await app.inject({ method: 'GET', url: '/health' })
      expect(health.statusCode).toBe(200)
      expect(health.json<{ status: string }>().status).toBe('ok')

      const docs = await app.inject({ method: 'GET', url: '/docs/json' })
      expect(docs.statusCode).toBe(200)
      expect(Object.keys(docs.json<{ paths: Record<string, unknown> }>().paths)).toContain('/evidence')
    } finally {
      await app.close()
    }
  }, 30_000)
})
