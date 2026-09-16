import {
  aidVaultAbi,
  decodeSchemaData,
  type FundingRecordedData,
  mockEURCAbi,
  nonCustodialLedgerAbi,
  regionCode,
  saltedRefHash,
} from '@poa/shared'
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
  readAttestation,
  roleAccount,
  rolePrivateKey,
  send,
  tokenBalanceOf,
  totalDonated,
} from './helpers/chain.js'
import { REF_SALT, suiteSkipReason, testConfig } from './helpers/env.js'
import { postSigned, sign, uniqueRef } from './helpers/http.js'

/**
 * A fiat donation must end up indistinguishable from a crypto one as far as the chain is concerned: money counted
 * toward the need, a `FundingRecorded` attestation that ties it to a salted payment reference, and no way to
 * replay it — in both custody modes.
 */

const skipReason = await suiteSkipReason('webhook')

const AMOUNT_CENTS = 1234
const AMOUNT_BASE_UNITS = BigInt(AMOUNT_CENTS) * 10_000n

interface WebhookResult {
  status: string
  idempotent: boolean
  vault: string
  donateTxHash: Hex | null
  attestTxHash: Hex | null
  attestationUID: Hex
  paymentRefHash: Hex
  donorRefHash: Hex
  amountBaseUnits: string
  grossBaseUnits: string
  feeBaseUnits: string
  netBaseUnits: string
  currency: string
  custodyMode: string
  source: string
}

const post = (app: FastifyInstance, body: unknown, signature?: string | null) =>
  postSigned(app, '/webhooks/sepa', body, signature)

describe.skipIf(Boolean(skipReason))('SEPA webhook', () => {
  let app: FastifyInstance
  let harness: Harness
  let onChain: FundingNeed
  let offChain: FundingNeed

  beforeAll(async () => {
    harness = createHarness()
    app = await buildApp(testConfig())
    await app.ready()
    onChain = await createNeedInFunding(harness)
    offChain = await createNeedInFunding(harness, { custodyMode: 'OffChain' })
  }, 180_000)

  afterAll(async () => {
    await app?.close()
  })

  const payment = (suffix: string, need: FundingNeed = onChain) => ({
    endToEndId: uniqueRef(`SEPA-E2E-${suffix}`),
    amountEurCents: AMOUNT_CENTS,
    donorReference: `DONOR-${suffix}`,
    needId: need.needId.toString(),
  })

  it('on-chain need: deposits the net amount and attests FundingRecorded with matching amounts and hashes', async () => {
    const body = payment('primary')
    const response = await post(app, body)
    expect(response.statusCode, response.body).toBe(200)

    const result = response.json<WebhookResult>()
    expect(result.status).toBe('ATTESTED')
    expect(result.idempotent).toBe(false)
    expect(result.custodyMode).toBe('OnChain')
    expect(result.source).toBe('SEPA')
    expect(result.currency).toBe('EUR')
    expect(result.amountBaseUnits).toBe(AMOUNT_BASE_UNITS.toString())
    expect(result.grossBaseUnits).toBe(AMOUNT_BASE_UNITS.toString())
    expect(result.feeBaseUnits).toBe('0')

    // The hashes are exactly what Solidity's keccak256(abi.encode(salt, reference)) produces.
    const salt = keccak256(stringToHex(REF_SALT))
    expect(result.paymentRefHash).toBe(saltedRefHash(salt, body.endToEndId))
    expect(result.donorRefHash).toBe(saltedRefHash(salt, body.donorReference))

    // 1. The vault emitted DonatedOnBehalf for this payment, from the provider.
    const receipt = await harness.publicClient.getTransactionReceipt({ hash: result.donateTxHash as Hex })
    const [event] = parseEventLogs({ abi: aidVaultAbi, eventName: 'DonatedOnBehalf', logs: receipt.logs })
    expect(event?.args.amount).toBe(AMOUNT_BASE_UNITS)
    expect(event?.args.paymentRefHash).toBe(result.paymentRefHash)
    expect(event?.args.donorRefHash).toBe(result.donorRefHash)
    expect(event?.args.partner.toLowerCase()).toBe(roleAccount('bankPartner').address.toLowerCase())

    // 2. The vault's own record agrees.
    const matches = await harness.publicClient.readContract({
      address: onChain.vault,
      abi: aidVaultAbi,
      functionName: 'fiatDepositMatches',
      args: [
        result.paymentRefHash,
        roleAccount('bankPartner').address,
        result.donorRefHash,
        AMOUNT_BASE_UNITS,
      ],
    })
    expect(matches).toBe(true)

    // 3. FundingRecorded exists, is addressed to the vault and decodes to the same amounts and references.
    const attestation = await readAttestation(harness, result.attestationUID)
    const [needId, gross, fee, net, currency, paymentRefHash, donorRefHash] =
      decodeSchemaData<FundingRecordedData>('FundingRecorded', attestation.data)
    expect(attestation.schema).toBe(harness.deployment.schemas.FundingRecorded)
    expect(needId).toBe(onChain.needId)
    expect([gross, fee, net]).toEqual([AMOUNT_BASE_UNITS, 0n, AMOUNT_BASE_UNITS])
    expect(currency).toBe(regionCode('EUR'))
    expect(paymentRefHash).toBe(result.paymentRefHash)
    expect(donorRefHash).toBe(result.donorRefHash)
    expect(attestation.recipient).toBe(onChain.vault)
    expect(attestation.revocable).toBe(false)
  }, 180_000)

  it('is idempotent: the same endToEndId twice produces one deposit and one attestation', async () => {
    const body = payment('replay')
    const first = await post(app, body)
    expect(first.statusCode, first.body).toBe(200)
    const before = await totalDonated(harness, onChain.vault)

    const second = await post(app, body)
    expect(second.statusCode, second.body).toBe(200)
    expect(second.json<WebhookResult>().idempotent).toBe(true)
    expect(await totalDonated(harness, onChain.vault)).toBe(before)

    // Same tx hashes, same attestation: nothing new was sent.
    expect(second.json<WebhookResult>().donateTxHash).toBe(first.json<WebhookResult>().donateTxHash)
    expect(second.json<WebhookResult>().attestationUID).toBe(first.json<WebhookResult>().attestationUID)
    expect(await prisma().fiatTransfer.count({ where: { endToEndId: body.endToEndId } })).toBe(1)
  }, 180_000)

  it('off-chain need: moves no tokens, counts the net amount in the ledger and attests as custodian', async () => {
    const body = { ...payment('offchain', offChain), feeEurCents: 0, currency: 'EUR' }
    const provider = roleAccount('bankPartner').address
    const [ledgerBefore, providerBalanceBefore, ledgerBalanceBefore] = await Promise.all([
      totalDonated(harness, offChain.vault),
      tokenBalanceOf(harness, provider),
      tokenBalanceOf(harness, offChain.vault),
    ])

    const response = await post(app, body)
    expect(response.statusCode, response.body).toBe(200)
    const result = response.json<WebhookResult>()
    expect(result.status).toBe('ATTESTED')
    expect(result.custodyMode).toBe('OffChain')
    expect(result.donateTxHash).toBeNull()

    expect(await totalDonated(harness, offChain.vault)).toBe(ledgerBefore + AMOUNT_BASE_UNITS)
    expect(await tokenBalanceOf(harness, provider)).toBe(providerBalanceBefore)
    expect(await tokenBalanceOf(harness, offChain.vault)).toBe(ledgerBalanceBefore)

    // The ledger logged the funding for this provider, in the attestation transaction itself.
    const receipt = await harness.publicClient.getTransactionReceipt({ hash: result.attestTxHash as Hex })
    const [event] = parseEventLogs({
      abi: nonCustodialLedgerAbi,
      eventName: 'FundingRecorded',
      logs: receipt.logs,
    })
    expect(event?.args.provider.toLowerCase()).toBe(provider.toLowerCase())
    expect(event?.args.net).toBe(AMOUNT_BASE_UNITS)
    expect(event?.args.paymentRefHash).toBe(result.paymentRefHash)

    const attestation = await readAttestation(harness, result.attestationUID)
    expect(attestation.recipient).toBe(offChain.vault)

    // Replayed: nothing more is counted.
    const replay = await post(app, body)
    expect(replay.json<WebhookResult>().idempotent).toBe(true)
    expect(await totalDonated(harness, offChain.vault)).toBe(ledgerBefore + AMOUNT_BASE_UNITS)
  }, 180_000)

  it('off-chain need: a provider that is not the named custodian is refused before anything is sent', async () => {
    // Same chain, same salt, but signing as a wallet that is not the need's custodian.
    const other = await buildApp(testConfig({ BANK_PARTNER_PRIVATE_KEY: rolePrivateKey('relayer') }))
    await other.ready()
    try {
      const body = payment('not-custodian', offChain)
      const before = await totalDonated(harness, offChain.vault)
      const response = await post(other, body)
      expect(response.statusCode, response.body).toBe(403)
      expect(response.json<{ error: string }>().error).toBe('NOT_CUSTODIAN')
      expect(await totalDonated(harness, offChain.vault)).toBe(before)
      expect(await prisma().fiatTransfer.findUnique({ where: { endToEndId: body.endToEndId } })).toBeNull()
    } finally {
      await other.close()
    }
  }, 60_000)

  it('resumes a payment whose deposit landed but whose attestation never did', async () => {
    const body = payment('resume')
    const salt = keccak256(stringToHex(REF_SALT))
    const paymentRefHash = saltedRefHash(salt, body.endToEndId)
    const donorRefHash = saltedRefHash(salt, body.donorReference)
    const provider = roleAccount('bankPartner').address

    // Simulate a run that died right after donateOnBehalf: the provider's deposit, and the row it left behind.
    const token = harness.deployment.external.Token
    await send(harness, 'bankPartner', {
      address: token,
      abi: mockEURCAbi,
      functionName: 'mint',
      args: [provider, AMOUNT_BASE_UNITS],
    } as never)
    await send(harness, 'bankPartner', {
      address: token,
      abi: mockEURCAbi,
      functionName: 'approve',
      args: [onChain.vault, AMOUNT_BASE_UNITS],
    } as never)
    await send(harness, 'bankPartner', {
      address: onChain.vault,
      abi: aidVaultAbi,
      functionName: 'donateOnBehalf',
      args: [AMOUNT_BASE_UNITS, donorRefHash, paymentRefHash],
    } as never)
    await prisma().fiatTransfer.create({
      data: {
        endToEndId: body.endToEndId,
        needId: body.needId,
        vault: onChain.vault,
        amountBaseUnits: AMOUNT_BASE_UNITS.toString(),
        amountEurCents: AMOUNT_CENTS,
        feeBaseUnits: '0',
        currency: 'EUR',
        source: 'SEPA',
        custodyMode: 'OnChain',
        paymentRefHash,
        donorRefHash,
        status: 'FUNDED',
      },
    })
    const before = await totalDonated(harness, onChain.vault)

    const response = await post(app, body)
    expect(response.statusCode, response.body).toBe(200)
    const result = response.json<WebhookResult>()
    expect(result).toMatchObject({ status: 'ATTESTED', idempotent: false, donateTxHash: null })
    expect(result.attestationUID).toMatch(/^0x[0-9a-f]{64}$/)
    // No second deposit: the chain showed the reference as consumed, so only the attestation was sent.
    expect(await totalDonated(harness, onChain.vault)).toBe(before)
  }, 180_000)

  it('rejects a bad HMAC signature without touching the chain', async () => {
    const body = payment('bad-hmac')
    const response = await post(app, body, 'sha256=deadbeef')

    expect(response.statusCode).toBe(401)
    expect(response.json<{ error: string }>().error).toBe('BAD_SIGNATURE')
    expect(await prisma().fiatTransfer.findUnique({ where: { endToEndId: body.endToEndId } })).toBeNull()
  })

  it('rejects a request with no signature header at all', async () => {
    const response = await post(app, payment('unsigned'), null)
    expect(response.statusCode).toBe(401)
  })

  it('rejects a signature computed over a different body', async () => {
    const body = payment('tampered')
    const response = await post(app, body, sign(JSON.stringify({ ...body, amountEurCents: 1 })))
    expect(response.statusCode).toBe(401)
  })

  it('refuses to reuse an endToEndId for a different amount', async () => {
    const body = payment('conflict')
    expect((await post(app, body)).statusCode).toBe(200)

    const response = await post(app, { ...body, amountEurCents: AMOUNT_CENTS + 1 })
    expect(response.statusCode).toBe(400)
    expect(response.json<{ error: string }>().error).toBe('REFERENCE_CONFLICT')
  }, 180_000)

  it('rejects a fee larger than the amount', async () => {
    const response = await post(app, { ...payment('fee-too-big'), feeEurCents: AMOUNT_CENTS + 1 })
    expect(response.statusCode).toBe(400)
    expect(response.json<{ error: string }>().error).toBe('FEE_EXCEEDS_AMOUNT')
  })

  it('serves a donor proof with gross, fee, net and custody, without leaking the salt or the references', async () => {
    const body = { ...payment('proof', offChain), currency: 'USD' }
    const posted = await post(app, body)
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

    const proof = response.json<
      WebhookResult & { needId: string; attestationSchema: string; links: { attestation: string | null } }
    >()
    expect(proof.needId).toBe(offChain.needId.toString())
    expect(proof.vault).toBe(offChain.vault)
    expect(proof.grossBaseUnits).toBe(AMOUNT_BASE_UNITS.toString())
    expect(proof.feeBaseUnits).toBe('0')
    expect(proof.netBaseUnits).toBe(AMOUNT_BASE_UNITS.toString())
    expect(proof.currency).toBe('USD')
    expect(proof.custodyMode).toBe('OffChain')
    expect(proof.attestationSchema).toBe('FundingRecorded')
    expect(proof.attestationUID).toBe(posted.json<WebhookResult>().attestationUID)
    expect(proof.paymentRefHash).toMatch(/^0x[0-9a-f]{64}$/)
    // Anvil has no explorer, so the links are explicitly null rather than a broken URL.
    expect(proof.links.attestation).toBeNull()

    const hashResponse = await app.inject({
      method: 'GET',
      url: `/donations/${encodeURIComponent(body.endToEndId)}/reference-hash`,
    })
    expect(hashResponse.json<{ paymentRefHash: string }>().paymentRefHash).toBe(proof.paymentRefHash)
  }, 180_000)

  it('404s for an unknown payment reference', async () => {
    const response = await app.inject({ method: 'GET', url: '/donations/UNKNOWN-REF/proof' })
    expect(response.statusCode).toBe(404)
  })

  it('404s for a need that does not exist', async () => {
    const response = await post(app, { ...payment('no-need'), needId: '999999' })
    expect(response.statusCode).toBe(404)
  }, 60_000)

  it('409s for a need that exists but has not been verified', async () => {
    const pending = await createNeedInFunding(harness, { verify: false })
    const response = await post(app, payment('pending', pending))
    expect(response.statusCode, response.body).toBe(409)
    expect(response.json<{ error: string }>().error).toBe('NEED_NOT_FUNDING')
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
      const response = await post(
        app,
        { endToEndId: uniqueRef('SEPA-DEV'), amountEurCents: 100, donorReference: 'DEV', needId: '999999' },
        null,
      )
      expect(response.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  }, 60_000)
})

describe('health and docs', () => {
  it('serves /health and the OpenAPI document with every endpoint', async () => {
    const app = await buildApp(testConfig())
    await app.ready()
    try {
      const health = await app.inject({ method: 'GET', url: '/health' })
      expect(health.statusCode).toBe(200)
      expect(health.json<{ service: string }>().service).toBe('bank-connector')
      expect(health.json<{ checkoutEnabled: boolean }>().checkoutEnabled).toBe(true)

      const docs = await app.inject({ method: 'GET', url: '/docs/json' })
      expect(docs.statusCode).toBe(200)
      const paths = Object.keys(docs.json<{ paths: Record<string, unknown> }>().paths)
      expect(paths).toEqual(
        expect.arrayContaining([
          '/webhooks/sepa',
          '/donations/{endToEndId}/proof',
          '/checkout/sessions',
          '/imports/funding',
          '/settlements',
        ]),
      )
    } finally {
      await app.close()
    }
  }, 30_000)

  it('does not expose the checkout mock when it is disabled', async () => {
    const app = await buildApp(testConfig({ CHECKOUT_MOCK_ENABLED: 'false' }))
    await app.ready()
    try {
      const response = await app.inject({ method: 'POST', url: '/checkout/sessions', payload: {} })
      expect(response.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  }, 30_000)
})
