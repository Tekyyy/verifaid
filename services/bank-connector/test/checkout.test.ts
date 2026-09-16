import { aidVaultAbi, decodeSchemaData, type FundingRecordedData } from '@poa/shared'
import type { FastifyInstance } from 'fastify'
import { type Hex, parseEventLogs } from 'viem'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { maxFundingFee, withinCostCap } from '../src/fees.js'
import {
  createHarness,
  createNeedInFunding,
  type Harness,
  readAttestation,
  resolverFees,
  totalDonated,
} from './helpers/chain.js'
import { suiteSkipReason, testConfig } from './helpers/env.js'
import { postCheckout, uniqueRef } from './helpers/http.js'

/**
 * The checkout mock stands in for a PSP: no card data, a realistic fee model, and a fee that can never break the
 * need's binding cost disclosure — the provider absorbs whatever the PSP would have charged above it.
 */

const skipReason = await suiteSkipReason('checkout')

interface CheckoutResult {
  checkoutId: string
  trackingRef: Hex
  needId: string
  method: string
  currency: string
  gross: string
  fee: string
  net: string
  status: string
  custodyMode: string
}

describe.skipIf(Boolean(skipReason))('checkout mock', () => {
  let app: FastifyInstance
  let harness: Harness

  beforeAll(async () => {
    harness = createHarness()
    app = await buildApp(testConfig())
    await app.ready()
  }, 60_000)

  afterAll(async () => {
    await app?.close()
  })

  it('card: charges 1.4% + €0.25 but caps the fee at the need’s cost disclosure', async () => {
    // 1% disclosure: a €25.00 card payment would cost €0.60 at the PSP, but only €0.25 may be attributed.
    const need = await createNeedInFunding(harness, { thirdPartyCostBps: 100 })
    const response = await postCheckout(app, {
      needId: need.needId.toString(),
      amount: '25.00',
      method: 'card',
    })
    expect(response.statusCode, response.body).toBe(201)

    const result = response.json<CheckoutResult>()
    expect(result.checkoutId).toMatch(/^CHK-[0-9a-f-]{36}$/)
    expect(result).toMatchObject({
      needId: need.needId.toString(),
      method: 'card',
      currency: 'EUR',
      gross: '25000000',
      fee: '250000',
      net: '24750000',
      status: 'ATTESTED',
      custodyMode: 'OnChain',
    })
    expect(result.trackingRef).toMatch(/^0x[0-9a-f]{64}$/)

    // The vault received the net amount, and the attestation carries gross, capped fee and net.
    expect(await totalDonated(harness, need.vault)).toBe(24_750_000n)
    expect((await resolverFees(harness, need.needId)).fundingFees).toBe(250_000n)

    const proof = await app.inject({ method: 'GET', url: `/donations/${result.checkoutId}/proof` })
    const { attestationUID, donateTxHash, source } = proof.json<{
      attestationUID: Hex
      donateTxHash: Hex
      source: string
    }>()
    expect(source).toBe('CARD')
    const receipt = await harness.publicClient.getTransactionReceipt({ hash: donateTxHash })
    const [deposit] = parseEventLogs({ abi: aidVaultAbi, eventName: 'DonatedOnBehalf', logs: receipt.logs })
    expect(deposit?.args.amount).toBe(24_750_000n)
    expect(deposit?.args.paymentRefHash).toBe(result.trackingRef)

    const [, gross, fee, net, , paymentRefHash] = decodeSchemaData<FundingRecordedData>(
      'FundingRecorded',
      (await readAttestation(harness, attestationUID)).data,
    )
    expect([gross, fee, net]).toEqual([25_000_000n, 250_000n, 24_750_000n])
    expect(paymentRefHash).toBe(result.trackingRef)

    // A second payment is capped cumulatively, against everything already attributed to intermediaries.
    const state = { totalDonated: 24_750_000n, fundingFees: 250_000n, settlementFees: 0n }
    const expectedFee = maxFundingFee(state, 100, 10_000_000n)
    const second = await postCheckout(app, {
      needId: need.needId.toString(),
      amount: '10.00',
      method: 'card',
    })
    expect(second.statusCode, second.body).toBe(201)
    expect(second.json<CheckoutResult>().fee).toBe(expectedFee.toString())

    const fees = await resolverFees(harness, need.needId)
    expect(withinCostCap({ totalDonated: await totalDonated(harness, need.vault), ...fees }, 100)).toBe(true)
  }, 180_000)

  it('card on a need with no cost disclosure: the provider absorbs the whole PSP fee', async () => {
    const need = await createNeedInFunding(harness)
    const response = await postCheckout(app, {
      needId: need.needId.toString(),
      amount: '12.50',
      method: 'card',
    })
    expect(response.statusCode, response.body).toBe(201)
    expect(response.json<CheckoutResult>()).toMatchObject({ gross: '12500000', fee: '0', net: '12500000' })
  }, 180_000)

  it('is idempotent on Idempotency-Key: same result, no second transaction; reuse for another checkout is a 409', async () => {
    const need = await createNeedInFunding(harness, { custodyMode: 'OffChain' })
    const body = {
      needId: need.needId.toString(),
      amount: '5.00',
      method: 'bank',
      donorReference: 'DONOR-IDEM',
    }
    const key = uniqueRef('idem')

    const first = await postCheckout(app, body, key)
    expect(first.statusCode, first.body).toBe(201)
    expect(first.headers['idempotent-replayed']).toBe('false')
    expect(first.json<CheckoutResult>()).toMatchObject({ custodyMode: 'OffChain', fee: '0', net: '5000000' })
    const donated = await totalDonated(harness, need.vault)
    expect(donated).toBe(5_000_000n)

    const second = await postCheckout(app, body, key)
    expect(second.statusCode, second.body).toBe(201)
    expect(second.headers['idempotent-replayed']).toBe('true')
    expect(second.json()).toEqual(first.json())
    expect(await totalDonated(harness, need.vault)).toBe(donated)

    const differentAmount = await postCheckout(app, { ...body, amount: '6.00' }, key)
    expect(differentAmount.statusCode).toBe(409)
    expect(differentAmount.json<{ error: string }>().error).toBe('IDEMPOTENCY_KEY_REUSED')

    const differentMethod = await postCheckout(app, { ...body, method: 'card' }, key)
    expect(differentMethod.statusCode).toBe(409)
    expect(await totalDonated(harness, need.vault)).toBe(donated)

    // Without a key, the same body is simply a second donation.
    const unkeyed = await postCheckout(app, body)
    expect(unkeyed.statusCode, unkeyed.body).toBe(201)
    expect(unkeyed.json<CheckoutResult>().checkoutId).not.toBe(first.json<CheckoutResult>().checkoutId)
  }, 180_000)

  it('409s above the remaining target (with the remaining amount) and once funding has closed', async () => {
    const need = await createNeedInFunding(harness, { custodyMode: 'OffChain', targetAmount: 10_000_000n })
    const needId = need.needId.toString()

    const tooMuch = await postCheckout(app, { needId, amount: '25.00', method: 'bank' })
    expect(tooMuch.statusCode, tooMuch.body).toBe(409)
    expect(tooMuch.json()).toMatchObject({ error: 'EXCEEDS_REMAINING', remaining: '10000000' })

    const exact = await postCheckout(app, { needId, amount: '10.00', method: 'bank' })
    expect(exact.statusCode, exact.body).toBe(201)

    const closed = await postCheckout(app, { needId, amount: '1.00', method: 'bank' })
    expect(closed.statusCode, closed.body).toBe(409)
    expect(closed.json<{ error: string }>().error).toBe('NEED_NOT_FUNDING')
  }, 180_000)

  it('404s for a need that does not exist', async () => {
    const response = await postCheckout(app, { needId: '999999', amount: '1.00', method: 'bank' })
    expect(response.statusCode).toBe(404)
  }, 60_000)
})

describe('checkout validation (no chain or database needed)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp(testConfig())
    await app.ready()
  }, 30_000)

  afterAll(async () => {
    await app?.close()
  })

  const valid = { needId: '1', amount: '25.00', method: 'card' }

  it.each([
    ['a zero amount', { ...valid, amount: '0.00' }],
    ['three decimals', { ...valid, amount: '1.234' }],
    ['a negative amount', { ...valid, amount: '-5' }],
    ['a numeric amount', { ...valid, amount: 25 }],
    ['an unknown method', { ...valid, method: 'crypto' }],
    ['a non-numeric need id', { ...valid, needId: 'abc' }],
    ['an unknown field', { ...valid, note: 'hello' }],
  ])('rejects %s with 400', async (_label, body) => {
    const response = await postCheckout(app, body)
    expect(response.statusCode, response.body).toBe(400)
  })

  it('never accepts card data, and says so', async () => {
    const response = await postCheckout(app, { ...valid, cardNumber: '4242424242424242', cvv: '123' })
    expect(response.statusCode).toBe(400)
    expect(response.json<{ error: string }>().error).toBe('CARD_DATA_REJECTED')
    expect(response.body).not.toContain('4242')
  })

  it('rejects an Idempotency-Key that is not printable ASCII', async () => {
    const response = await postCheckout(app, valid, 'x'.repeat(300))
    expect(response.statusCode).toBe(400)
  })

  it('rate-limits per client with retry-after and remaining-quota headers', async () => {
    const limited = await buildApp(testConfig({ CHECKOUT_RATE_LIMIT_PER_MINUTE: '2' }))
    await limited.ready()
    try {
      const invalid = { ...valid, amount: '0' }
      const first = await postCheckout(limited, invalid)
      expect(first.headers['x-ratelimit-limit']).toBe('2')
      expect(first.headers['x-ratelimit-remaining']).toBe('1')
      await postCheckout(limited, invalid)
      const third = await postCheckout(limited, invalid)
      expect(third.statusCode).toBe(429)
      expect(third.json<{ error: string }>().error).toBe('RATE_LIMITED')
      expect(Number(third.headers['retry-after'])).toBeGreaterThan(0)
    } finally {
      await limited.close()
    }
  })
})
