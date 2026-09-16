import { prisma } from '@poa/shared/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import {
  createHarness,
  createNeedInFunding,
  type FundingNeed,
  type Harness,
  totalDonated,
} from './helpers/chain.js'
import { suiteSkipReason, testConfig } from './helpers/env.js'
import { postCsv, sign, uniqueRef } from './helpers/http.js'

/**
 * A CSV import is the webhook in bulk: each valid row through the same pipeline, in order, idempotent per
 * end-to-end id, with a per-row verdict so a partly failed file can simply be uploaded again.
 */

const skipReason = await suiteSkipReason('imports')

const HEADER = 'end_to_end_id,need_id,amount_eur,fee_eur,currency,donor_reference'

interface ImportResponse {
  rows: { line: number; endToEndId: string; status: string; trackingRef?: string; error?: string }[]
  summary: { attested: number; duplicate: number; failed: number; invalid: number }
}

describe.skipIf(Boolean(skipReason))('CSV funding import', () => {
  let app: FastifyInstance
  let harness: Harness
  let onChain: FundingNeed
  let offChain: FundingNeed

  beforeAll(async () => {
    harness = createHarness()
    app = await buildApp(testConfig())
    await app.ready()
    onChain = await createNeedInFunding(harness)
    offChain = await createNeedInFunding(harness, { custodyMode: 'OffChain', thirdPartyCostBps: 200 })
  }, 180_000)

  afterAll(async () => {
    await app?.close()
  })

  it('processes mixed rows: attested, duplicate, invalid and failed, with a summary', async () => {
    const first = uniqueRef('CSV-A')
    const second = uniqueRef('CSV-B')
    const csv = [
      HEADER,
      `${first},${onChain.needId},12.00,,,DONOR-CSV-1`,
      `${second},${offChain.needId},20.00,0.30,eur,"DONOR, CSV 2"`,
      `${first},${onChain.needId},12.00,,,DONOR-CSV-1`,
      `${uniqueRef('CSV-C')},${onChain.needId},12.345,,,DONOR-CSV-3`,
      `${uniqueRef('CSV-D')},999999,1.00,0,EUR,DONOR-CSV-4`,
      `${uniqueRef('CSV-E')},${onChain.needId},1.00`,
      '',
    ].join('\n')

    const [onChainBefore, offChainBefore] = await Promise.all([
      totalDonated(harness, onChain.vault),
      totalDonated(harness, offChain.vault),
    ])
    const response = await postCsv(app, csv)
    expect(response.statusCode, response.body).toBe(200)
    const result = response.json<ImportResponse>()

    expect(result.rows.map((row) => [row.line, row.status])).toEqual([
      [2, 'ATTESTED'],
      [3, 'ATTESTED'],
      [4, 'DUPLICATE'],
      [5, 'INVALID'],
      [6, 'FAILED'],
      [7, 'INVALID'],
    ])
    expect(result.summary).toEqual({ attested: 2, duplicate: 1, failed: 1, invalid: 2 })
    expect(result.rows[0]?.trackingRef).toMatch(/^0x[0-9a-f]{64}$/)
    expect(result.rows[2]?.trackingRef).toBe(result.rows[0]?.trackingRef)
    expect(result.rows[3]?.error).toContain('amount_eur')
    expect(result.rows[4]?.error).toContain('NOT_FOUND')
    // Row errors never echo cell values.
    expect(response.body).not.toContain('DONOR-CSV')

    // 20.00 EUR with a €0.30 fee on a 2% disclosure: 0.30 fits under the €0.40 cap, so it is kept as reported.
    expect(await totalDonated(harness, onChain.vault)).toBe(onChainBefore + 12_000_000n)
    expect(await totalDonated(harness, offChain.vault)).toBe(offChainBefore + 19_700_000n)
    const stored = await prisma().fiatTransfer.findUnique({ where: { endToEndId: second } })
    expect(stored).toMatchObject({
      source: 'CSV',
      currency: 'EUR',
      custodyMode: 'OffChain',
      feeBaseUnits: '300000',
    })

    // Uploading the same file again changes nothing on-chain.
    const again = await postCsv(app, csv)
    expect(again.json<ImportResponse>().summary).toEqual({ attested: 0, duplicate: 3, failed: 1, invalid: 2 })
    expect(await totalDonated(harness, onChain.vault)).toBe(onChainBefore + 12_000_000n)
  }, 300_000)

  it('rejects a bad or missing HMAC before parsing anything', async () => {
    const csv = `${HEADER}\n${uniqueRef('CSV-HMAC')},${onChain.needId},1.00,,,DONOR\n`
    expect((await postCsv(app, csv, 'sha256=deadbeef')).statusCode).toBe(401)
    expect((await postCsv(app, csv, null)).statusCode).toBe(401)
    expect((await postCsv(app, csv, sign(`${csv} `))).statusCode).toBe(401)
  })

  it('rejects a file with a wrong header, no rows or broken quoting', async () => {
    const badHeader = await postCsv(app, 'id,need,amount\nA,1,1.00\n')
    expect(badHeader.statusCode).toBe(400)
    expect(badHeader.json<{ error: string }>().error).toBe('INVALID_CSV_HEADER')

    const empty = await postCsv(app, `${HEADER}\n`)
    expect(empty.json<{ error: string }>().error).toBe('EMPTY_IMPORT')

    const broken = await postCsv(app, `${HEADER}\n"unterminated,1,1.00,,,D\n`)
    expect(broken.statusCode).toBe(400)
    expect(broken.json<{ error: string }>().error).toBe('INVALID_CSV')
  })

  it('enforces the row limit', async () => {
    const small = await buildApp(testConfig({ IMPORT_MAX_ROWS: '2' }))
    await small.ready()
    try {
      const rows = [1, 2, 3].map((i) => `${uniqueRef(`CSV-LIMIT-${i}`)},${onChain.needId},1.00,,,D`)
      const response = await postCsv(small, [HEADER, ...rows].join('\n'))
      expect(response.statusCode).toBe(413)
      expect(response.json<{ error: string }>().error).toBe('TOO_MANY_ROWS')
    } finally {
      await small.close()
    }
  })
})
