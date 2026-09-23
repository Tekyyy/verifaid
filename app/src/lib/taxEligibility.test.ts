import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { DonationTrack, OrgTaxStatusView } from '@poa/shared'
import {
  assessDonation,
  channelOfRef,
  deductibleHere,
  isEligible,
  parseJurisdiction,
  regimeOf,
  sgDeductionRate,
} from './taxEligibility.ts'

const status = (jurisdiction: string, verified = true): OrgTaxStatusView => ({
  org: '0x0000000000000000000000000000000000000001',
  jurisdiction,
  taxId: '12-3456789',
  legalName: 'Example Charity',
  source: 'https://example.org',
  claimedAt: 1,
  verified,
  verifiedBy: verified ? '0x0000000000000000000000000000000000000002' : null,
  verifiedSource: verified ? 'register' : null,
  verifiedAt: verified ? 2 : null,
})

const FUNDED_AT = Date.UTC(2026, 2, 10) / 1000

const track = (overrides: {
  jurisdiction?: string | null
  refKind?: DonationTrack['refKind']
  amount?: string
  funded?: boolean
  outcome?: DonationTrack['outcome']
  releasedToNgo?: string
}) => ({
  refKind: overrides.refKind ?? 'receipt',
  donation: { amount: overrides.amount ?? '100000000' } as DonationTrack['donation'],
  stages: [
    { stage: 'Verified', reached: true, at: 1, txHash: null, attestationUID: null, pending: null },
    {
      stage: 'Funded',
      reached: overrides.funded ?? true,
      at: (overrides.funded ?? true) ? FUNDED_AT : null,
      txHash: null,
      attestationUID: null,
      pending: null,
    },
  ] as DonationTrack['stages'],
  outcome: overrides.outcome ?? 'InProgress',
  releasedToNgo: overrides.releasedToNgo ?? '0',
  need: {
    taxStatus: overrides.jurisdiction === null ? null : status(overrides.jurisdiction ?? 'US:501c3'),
  },
})

describe('regimeOf', () => {
  it('recognises the two designations, case-insensitively', () => {
    assert.equal(regimeOf(status('US:501c3')), 'US_501C3')
    assert.equal(regimeOf(status('us:501C3')), 'US_501C3')
    assert.equal(regimeOf(status(' SG:IPC ')), 'SG_IPC')
  })

  it('never trusts an unchecked claim', () => {
    assert.equal(regimeOf(status('US:501c3', false)), null)
    assert.equal(regimeOf(status('SG:IPC', false)), null)
  })

  it('does not read a bare country, or another designation, as deductible', () => {
    assert.equal(regimeOf(status('US')), null)
    assert.equal(regimeOf(status('US:501c4')), null)
    assert.equal(regimeOf(status('SG')), null)
    assert.equal(regimeOf(status('ES')), null)
    assert.equal(regimeOf(null), null)
  })
})

describe('isEligible', () => {
  it('a 501(c)(3) takes both tokens and cash', () => {
    assert.equal(isEligible(status('US:501c3'), 'digital'), true)
    assert.equal(isEligible(status('US:501c3'), 'cash'), true)
  })

  it('an IPC takes cash only: digital tokens are not a qualifying donation type', () => {
    assert.equal(isEligible(status('SG:IPC'), 'cash'), true)
    assert.equal(isEligible(status('SG:IPC'), 'digital'), false)
  })

  it('maps tracking references to channels', () => {
    assert.equal(channelOfRef('payment'), 'cash')
    assert.equal(channelOfRef('receipt'), 'digital')
    assert.equal(channelOfRef('deposit'), 'digital')
  })
})

describe('parseJurisdiction', () => {
  it('splits country and designation', () => {
    assert.deepEqual(parseJurisdiction('sg:IPC'), { country: 'SG', designation: 'IPC' })
    assert.deepEqual(parseJurisdiction('US'), { country: 'US', designation: '' })
  })
})

describe('sgDeductionRate', () => {
  it('is 250% through 31 Dec 2026 and unknown after', () => {
    assert.equal(sgDeductionRate(Date.UTC(2026, 11, 31, 23, 59) / 1000), 250)
    assert.equal(sgDeductionRate(Date.UTC(2027, 0, 1) / 1000), null)
  })
})

describe('assessDonation', () => {
  it('is deductible once funding closed, dated then', () => {
    const result = assessDonation(track({}))
    assert.equal(result.kind, 'deductible')
    if (result.kind !== 'deductible') return
    assert.equal(result.regime, 'US_501C3')
    assert.equal(result.amount, 100_000_000n)
    assert.equal(result.partial, false)
    assert.equal(result.since, FUNDED_AT)
    assert.equal(result.taxYear, 2026)
  })

  it('is not yet a completed gift while funding is open', () => {
    assert.equal(assessDonation(track({ funded: false })).kind, 'revocable')
  })

  it('is nothing when the organisation is not eligible', () => {
    assert.equal(assessDonation(track({ jurisdiction: null })).kind, 'none')
    assert.equal(assessDonation(track({ jurisdiction: 'US' })).kind, 'none')
  })

  it('refuses a token donation to an IPC but accepts cash', () => {
    assert.deepEqual(assessDonation(track({ jurisdiction: 'SG:IPC' })), {
      kind: 'channel',
      regime: 'SG_IPC',
      channel: 'digital',
    })
    assert.equal(assessDonation(track({ jurisdiction: 'SG:IPC', refKind: 'payment' })).kind, 'deductible')
  })

  it('is returned when fully withdrawn or refunded with nothing paid out', () => {
    assert.equal(assessDonation(track({ amount: '0' })).kind, 'returned')
    assert.equal(assessDonation(track({ outcome: 'Refunded' })).kind, 'returned')
    assert.equal(assessDonation(track({ outcome: 'Expired', funded: false })).kind, 'returned')
  })

  it('keeps only what was paid out when the rest is refunded', () => {
    const result = assessDonation(track({ outcome: 'Refundable', releasedToNgo: '30000000' }))
    assert.equal(result.kind, 'deductible')
    if (result.kind !== 'deductible') return
    assert.equal(result.amount, 30_000_000n)
    assert.equal(result.partial, true)
  })
})

describe('deductibleHere', () => {
  it('is true only where a way of giving on this platform qualifies', () => {
    // A 501(c)(3) takes tokens, and tokens are all this platform takes.
    assert.equal(deductibleHere(status('US:501c3')), true)
    // An IPC takes cash alone; a card here buys USDC first, so nothing given here is deductible.
    assert.equal(deductibleHere(status('SG:IPC')), false)
    assert.equal(deductibleHere(status('US:501c3', false)), false)
    assert.equal(deductibleHere(null), false)
  })
})
