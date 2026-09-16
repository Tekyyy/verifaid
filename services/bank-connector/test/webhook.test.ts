import { aidVaultAbi, decodeSchemaData, easAbi, hmac, saltedRefHash } from '@poa/shared'
import { prisma } from '@poa/shared/db'
import type { FastifyInstance } from 'fastify'
import { type Hex, keccak256, parseEventLogs, stringToHex } from 'viem'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import {
  createHarness,
  createNeedInFunding,
  type FundingNeed,
  type Harness,
  roleAccount,
} from './helpers/chain.js'
import {
  CHAIN_SKIP,
  chainAvailable,
  POSTGRES_SKIP,
  postgresAvailable,
  REF_SALT,
  testConfig,
  WEBHOOK_SECRET,
} from './helpers/env.js'

/**
 * A fiat donation must end up indistinguishable from a crypto one as far as the chain is concerned: money in
 * the vault, an attestation that ties it to a salted payment reference, and no way to replay it.
 */

const hasPostgres = await postgresAvailable()
const hasChain = await chainAvailable()
const skipReason = !hasPostgres ? POSTGRES_SKIP : !hasChain ? CHAIN_SKIP : null
// Written to the raw stream: vitest swallows `console` output produced while it is still collecting files, and a
// silent skip is indistinguishable from a suite that never existed.
if (skipReason) process.stderr.write(`\n[bank-connector] SKIPPING chain + database tests: ${skipReason}\n\n`)

const AMOUNT_CENTS = 1234
const AMOUNT_BASE_UNITS = BigInt(AMOUNT_CENTS) * 10_000n

const sign = (body: string): string => `sha256=${hmac(WEBHOOK_SECRET, body).toString('hex')}`

const post = (app: FastifyInstance, body: unknown, signature?: string) =>
  app.inject({
    method: 'POST',
    url: '/webhooks/sepa',
    headers: {
      'content-type': 'application/json',
      ...(signature === undefined ? {} : { 'x-poa-signature': signature }),
    },
    payload: JSON.stringify(body),
  })

describe.skipIf(Boolean(skipReason))('SEPA webhook', () => {
  let app: FastifyInstance
  let harness: Harness
  let need: FundingNeed

  beforeAll(async () => {
    harness = createHarness()
    app = await buildApp(testConfig())
    await app.ready()
    need = await createNeedInFunding(harness)
  }, 180_000)

  afterAll(async () => {
    await app?.close()
  })

  const payment = (suffix: string) => ({
    endToEndId: `SEPA-E2E-${Date.now()}-${suffix}`,
    amountEurCents: AMOUNT_CENTS,
    donorReference: `DONOR-${suffix}`,
    needId: need.needId.toString(),
  })

  it('deposits the donation on-chain and attests it with matching amount and reference hashes', async () => {
    const body = payment('primary')
    const raw = JSON.stringify(body)
    const response = await post(app, body, sign(raw))
    expect(response.statusCode, response.body).toBe(200)

    const result = response.json<{
      status: string
      idempotent: boolean
      donateTxHash: Hex
      attestationUID: Hex
      paymentRefHash: Hex
      donorRefHash: Hex
      amountBaseUnits: string
    }>()
    expect(result.status).toBe('ATTESTED')
    expect(result.idempotent).toBe(false)
    expect(result.amountBaseUnits).toBe(AMOUNT_BASE_UNITS.toString())

    // The hashes are exactly what Solidity's keccak256(abi.encode(salt, reference)) produces.
    const salt = keccak256(stringToHex(REF_SALT))
    expect(result.paymentRefHash).toBe(saltedRefHash(salt, body.endToEndId))
    expect(result.donorRefHash).toBe(saltedRefHash(salt, body.donorReference))

    // 1. The vault emitted DonatedOnBehalf for this payment.
    const receipt = await harness.publicClient.getTransactionReceipt({ hash: result.donateTxHash })
    const [event] = parseEventLogs({ abi: aidVaultAbi, eventName: 'DonatedOnBehalf', logs: receipt.logs })
    expect(event?.args.amount).toBe(AMOUNT_BASE_UNITS)
    expect(event?.args.paymentRefHash).toBe(result.paymentRefHash)
    expect(event?.args.donorRefHash).toBe(result.donorRefHash)
    expect(event?.args.partner.toLowerCase()).toBe(roleAccount('bankPartner').address.toLowerCase())

    // 2. The vault's own record agrees.
    const record = await harness.publicClient.readContract({
      address: need.vault,
      abi: aidVaultAbi,
      functionName: 'fiatDonation',
      args: [result.paymentRefHash],
    })
    expect(record.amount).toBe(AMOUNT_BASE_UNITS)

    // 3. The FiatDonation attestation exists and decodes to the same amount and references.
    const attestation = await harness.publicClient.readContract({
      address: harness.deployment.external.EAS,
      abi: easAbi,
      functionName: 'getAttestation',
      args: [result.attestationUID],
    })
    const [needId, amount, paymentRefHash, donorRefHash] = decodeSchemaData<[bigint, bigint, Hex, Hex]>(
      'FiatDonation',
      attestation.data,
    )
    expect(needId).toBe(need.needId)
    expect(amount).toBe(AMOUNT_BASE_UNITS)
    expect(paymentRefHash).toBe(result.paymentRefHash)
    expect(donorRefHash).toBe(result.donorRefHash)
    expect(attestation.recipient).toBe(need.vault)
    expect(attestation.revocable).toBe(false)
  }, 180_000)

  it('is idempotent: the same endToEndId twice produces one deposit', async () => {
    const body = payment('replay')
    const raw = JSON.stringify(body)

    const first = await post(app, body, sign(raw))
    expect(first.statusCode, first.body).toBe(200)
    const before = await harness.publicClient.readContract({
      address: need.vault,
      abi: aidVaultAbi,
      functionName: 'totalDonated',
    })

    const second = await post(app, body, sign(raw))
    expect(second.statusCode, second.body).toBe(200)
    expect(second.json<{ idempotent: boolean }>().idempotent).toBe(true)

    const after = await harness.publicClient.readContract({
      address: need.vault,
      abi: aidVaultAbi,
      functionName: 'totalDonated',
    })
    expect(after).toBe(before)

    // Same tx hashes, same attestation: nothing new was sent.
    expect(second.json<{ donateTxHash: string }>().donateTxHash).toBe(
      first.json<{ donateTxHash: string }>().donateTxHash,
    )
    expect(second.json<{ attestationUID: string }>().attestationUID).toBe(
      first.json<{ attestationUID: string }>().attestationUID,
    )
    expect(await prisma().fiatTransfer.count({ where: { endToEndId: body.endToEndId } })).toBe(1)
  }, 180_000)

  it('rejects a bad HMAC signature without touching the chain', async () => {
    const body = payment('bad-hmac')
    const response = await post(app, body, 'sha256=deadbeef')

    expect(response.statusCode).toBe(401)
    expect(response.json<{ error: string }>().error).toBe('BAD_SIGNATURE')
    expect(await prisma().fiatTransfer.findUnique({ where: { endToEndId: body.endToEndId } })).toBeNull()
  })

  it('rejects a request with no signature header at all', async () => {
    const body = payment('unsigned')
    const response = await post(app, body)
    expect(response.statusCode).toBe(401)
  })

  it('rejects a signature computed over a different body', async () => {
    const body = payment('tampered')
    const signature = sign(JSON.stringify({ ...body, amountEurCents: 1 }))
    const response = await post(app, body, signature)
    expect(response.statusCode).toBe(401)
  })

  it('refuses to reuse an endToEndId for a different amount', async () => {
    const body = payment('conflict')
    await post(app, body, sign(JSON.stringify(body)))

    const changed = { ...body, amountEurCents: AMOUNT_CENTS + 1 }
    const response = await post(app, changed, sign(JSON.stringify(changed)))
    expect(response.statusCode).toBe(400)
    expect(response.json<{ error: string }>().error).toBe('REFERENCE_CONFLICT')
  }, 180_000)

  it('serves a donor proof without leaking the salt or the raw references', async () => {
    const body = payment('proof')
    const posted = await post(app, body, sign(JSON.stringify(body)))
    expect(posted.statusCode, posted.body).toBe(200)

    const response = await app.inject({
      method: 'GET',
      url: `/donations/${encodeURIComponent(body.endToEndId)}/proof`,
    })
    expect(response.statusCode).toBe(200)

    // Neither the salt nor either raw reference may appear anywhere in the response.
    expect(response.body).not.toContain(REF_SALT)
    expect(response.body).not.toContain(body.donorReference)
    expect(response.body).not.toContain(body.endToEndId)

    const proof = response.json<{
      needId: string
      vault: string
      amountBaseUnits: string
      paymentRefHash: string
      attestationUID: string
      links: { attestation: string | null }
    }>()
    expect(proof.needId).toBe(need.needId.toString())
    expect(proof.vault).toBe(need.vault)
    expect(proof.amountBaseUnits).toBe(AMOUNT_BASE_UNITS.toString())
    expect(proof.paymentRefHash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(proof.attestationUID).toMatch(/^0x[0-9a-f]{64}$/)
    // Anvil has no explorer, so the links are explicitly null rather than a broken URL.
    expect(proof.links.attestation).toBeNull()
  }, 180_000)

  it('404s for an unknown payment reference', async () => {
    const response = await app.inject({ method: 'GET', url: '/donations/UNKNOWN-REF/proof' })
    expect(response.statusCode).toBe(404)
  })

  it('rejects a need that has no vault yet', async () => {
    const body = { ...payment('no-vault'), needId: '999999' }
    const response = await post(app, body, sign(JSON.stringify(body)))
    expect(response.statusCode).toBe(404)
  }, 60_000)
})

describe.skipIf(Boolean(skipReason))('development mode', () => {
  it('accepts an unsigned webhook when no secret is configured, and says so on /health', async () => {
    const app = await buildApp(testConfig({ BANK_WEBHOOK_SECRET: '' }))
    await app.ready()
    try {
      const health = await app.inject({ method: 'GET', url: '/health' })
      expect(health.json<{ webhookAuthenticated: boolean }>().webhookAuthenticated).toBe(false)
      expect(health.json<{ partnerRegistered: boolean }>().partnerRegistered).toBe(true)

      // Unsigned, but still rejected later for a need that cannot accept it — the signature is the only thing waived.
      const response = await post(app, {
        endToEndId: `SEPA-DEV-${Date.now()}`,
        amountEurCents: 100,
        donorReference: 'DEV',
        needId: '999999',
      })
      expect(response.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  }, 60_000)
})

describe('health and docs', () => {
  it('serves /health and the OpenAPI document', async () => {
    const app = await buildApp(testConfig())
    await app.ready()
    try {
      const health = await app.inject({ method: 'GET', url: '/health' })
      expect(health.statusCode).toBe(200)
      expect(health.json<{ service: string }>().service).toBe('bank-connector')

      const docs = await app.inject({ method: 'GET', url: '/docs/json' })
      expect(docs.statusCode).toBe(200)
      const paths = Object.keys(docs.json<{ paths: Record<string, unknown> }>().paths)
      expect(paths).toEqual(expect.arrayContaining(['/webhooks/sepa', '/donations/{endToEndId}/proof']))
    } finally {
      await app.close()
    }
  }, 30_000)
})
