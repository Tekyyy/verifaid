import {
  decodeSchemaData,
  NEED_STATUS_VALUE,
  nonCustodialLedgerAbi,
  type SettlementData,
  saltedRefHash,
  TRANCHE_STATUS,
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
  needStatus,
  readAttestation,
  resolverFees,
  rolePrivateKey,
  tranchesOf,
} from './helpers/chain.js'
import { REF_SALT, suiteSkipReason, testConfig } from './helpers/env.js'
import { postSigned, uniqueRef } from './helpers/http.js'

/**
 * Model A payouts: the custodian of an off-chain need reports paying a releasable tranche to the supplier, and
 * that `Settlement` attestation is what releases the tranche on-chain.
 */

const skipReason = await suiteSkipReason('settlements')

interface SettlementResult {
  id: string
  needId: string
  trancheIndex: number
  gross: string
  fee: string
  net: string
  attestationUID: Hex
  txHash: Hex
  status: string
  idempotent: boolean
}

describe.skipIf(Boolean(skipReason))('provider settlements', () => {
  let app: FastifyInstance
  let harness: Harness
  let offChain: FundingNeed

  beforeAll(async () => {
    harness = createHarness()
    app = await buildApp(testConfig())
    await app.ready()

    // Off-chain need with a 2% cost disclosure, funded to its target so funding closes and tranche 0 unlocks.
    offChain = await createNeedInFunding(harness, {
      custodyMode: 'OffChain',
      targetAmount: 20_000_000n,
      thirdPartyCostBps: 200,
    })
    const funded = await postSigned(app, '/webhooks/sepa', {
      endToEndId: uniqueRef('SEPA-SETTLE'),
      amountEurCents: 2000,
      donorReference: 'DONOR-SETTLE',
      needId: offChain.needId.toString(),
    })
    if (funded.statusCode !== 200) throw new Error(`funding failed: ${funded.body}`)
  }, 180_000)

  afterAll(async () => {
    await app?.close()
  })

  it('releases tranche 0 of an off-chain need, capping the payout fee at the disclosure', async () => {
    expect(await needStatus(harness, offChain.needId)).toBe(NEED_STATUS_VALUE.Funded)
    const supplierReference = uniqueRef('SUPPLIER-INV')
    const body = {
      needId: offChain.needId.toString(),
      trancheIndex: 0,
      feeEurCents: 50,
      supplierReference,
      fxReference: 'FX-DEAL-42',
    }

    const response = await postSigned(app, '/settlements', body)
    expect(response.statusCode, response.body).toBe(200)
    const result = response.json<SettlementResult>()
    // Tranche 0 is half of 20.00 EUR; a €0.50 fee would exceed 2% of what donors paid, so €0.40 is attributed.
    expect(result).toMatchObject({
      needId: offChain.needId.toString(),
      trancheIndex: 0,
      gross: '10000000',
      fee: '400000',
      net: '9600000',
      status: 'ATTESTED',
      idempotent: false,
    })

    // The attestation released the tranche and moved the need into delivery.
    const [tranche0, tranche1] = await tranchesOf(harness, offChain.vault)
    expect(TRANCHE_STATUS[tranche0?.status ?? 0]).toBe('Released')
    expect(TRANCHE_STATUS[tranche1?.status ?? 0]).toBe('Locked')
    expect(await needStatus(harness, offChain.needId)).toBe(NEED_STATUS_VALUE.InDelivery)
    expect((await resolverFees(harness, offChain.needId)).settlementFees).toBe(400_000n)

    const receipt = await harness.publicClient.getTransactionReceipt({ hash: result.txHash })
    const [released] = parseEventLogs({
      abi: nonCustodialLedgerAbi,
      eventName: 'TrancheReleased',
      logs: receipt.logs,
    })
    expect(released?.args.index).toBe(0n)
    expect(released?.args.amount).toBe(10_000_000n)

    const attestation = await readAttestation(harness, result.attestationUID)
    expect(attestation.recipient).toBe(offChain.vault)
    expect(attestation.schema).toBe(harness.deployment.schemas.Settlement)
    const [needId, trancheIndex, gross, fee, net, supplierRefHash, fxRef] = decodeSchemaData<SettlementData>(
      'Settlement',
      attestation.data,
    )
    expect([needId, trancheIndex, gross, fee, net]).toEqual([
      offChain.needId,
      0n,
      10_000_000n,
      400_000n,
      9_600_000n,
    ])
    expect(supplierRefHash).toBe(saltedRefHash(keccak256(stringToHex(REF_SALT)), supplierReference))
    expect(fxRef).toBe(keccak256(stringToHex('FX-DEAL-42')))
    expect(response.body).not.toContain(supplierReference)

    // Replayed: same record, nothing sent.
    const replay = await postSigned(app, '/settlements', body)
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json<SettlementResult>()).toMatchObject({
      idempotent: true,
      attestationUID: result.attestationUID,
    })
    expect(await prisma().providerSettlement.count({ where: { needId: body.needId, trancheIndex: 0 } })).toBe(
      1,
    )

    // A different supplier reference for the same payout is a conflict, not a second payout.
    const changed = await postSigned(app, '/settlements', { ...body, supplierReference: 'OTHER' })
    expect(changed.statusCode).toBe(409)
  }, 180_000)

  it('refuses a tranche that is not releasable yet', async () => {
    const response = await postSigned(app, '/settlements', {
      needId: offChain.needId.toString(),
      trancheIndex: 1,
      supplierReference: uniqueRef('SUPPLIER'),
    })
    expect(response.statusCode, response.body).toBe(409)
    expect(response.json<{ error: string }>().error).toBe('TRANCHE_NOT_RELEASABLE')
  }, 60_000)

  it('refuses an on-chain need: its vault releases tranches, not the provider', async () => {
    const onChain = await createNeedInFunding(harness)
    const response = await postSigned(app, '/settlements', {
      needId: onChain.needId.toString(),
      trancheIndex: 0,
      supplierReference: uniqueRef('SUPPLIER'),
    })
    expect(response.statusCode, response.body).toBe(409)
    expect(response.json<{ error: string }>().error).toBe('NOT_OFF_CHAIN_CUSTODY')
  }, 60_000)

  it('refuses a provider that is not the custodian', async () => {
    const other = await buildApp(testConfig({ BANK_PARTNER_PRIVATE_KEY: rolePrivateKey('relayer') }))
    await other.ready()
    try {
      const response = await postSigned(other, '/settlements', {
        needId: offChain.needId.toString(),
        trancheIndex: 1,
        supplierReference: uniqueRef('SUPPLIER'),
      })
      expect(response.statusCode, response.body).toBe(403)
      expect(response.json<{ error: string }>().error).toBe('NOT_CUSTODIAN')
    } finally {
      await other.close()
    }
  }, 60_000)

  it('rejects a bad HMAC', async () => {
    const response = await postSigned(
      app,
      '/settlements',
      { needId: offChain.needId.toString(), trancheIndex: 1, supplierReference: 'X' },
      'sha256=deadbeef',
    )
    expect(response.statusCode).toBe(401)
  })
})
