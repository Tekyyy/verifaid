import { describe, expect, it } from 'vitest'
import { checkoutIdFor } from '../src/checkout.js'
import {
  cardFeeCents,
  type FeeState,
  formatEur,
  maxFundingFee,
  maxFundingFeeAfterDeposit,
  maxSettlementFee,
  parseEurAmount,
  withinCostCap,
} from '../src/fees.js'
import { parseFundingCsv } from '../src/imports.js'

/** Pure arithmetic and parsing: no chain, no database. */

describe('amounts', () => {
  it.each([
    ['25', 2500],
    ['25.5', 2550],
    ['25.00', 2500],
    ['0.01', 1],
    ['999999999.99', 99_999_999_999],
  ])('parses %s as %i cents', (text, cents) => {
    expect(parseEurAmount(text)).toBe(cents)
  })

  it.each(['', '1.234', '-1', '1e3', '1,00', '.5', '1.', '0x10', '1000000000'])('rejects "%s"', (text) => {
    expect(parseEurAmount(text)).toBeNull()
  })

  it('formats base units as EUR', () => {
    expect(formatEur(10_000_000n)).toBe('10.00')
    expect(formatEur(1_234_560_000n)).toBe('1234.56')
    expect(formatEur(0n)).toBe('0.00')
  })

  it('prices a card payment at 1.4% + €0.25, rounded half-up to the cent', () => {
    expect(cardFeeCents(2500, 140, 25)).toBe(60)
    expect(cardFeeCents(1000, 140, 25)).toBe(39)
    expect(cardFeeCents(3572, 140, 25)).toBe(75) // 50.008 → 50
    expect(cardFeeCents(3575, 140, 25)).toBe(75) // 50.05 → 50
    expect(cardFeeCents(3580, 140, 25)).toBe(75) // 50.12 → 50
    expect(cardFeeCents(3600, 140, 25)).toBe(75) // 50.4 → 50
    expect(cardFeeCents(3625, 140, 25)).toBe(76) // 50.75 → 51
  })
})

describe('disclosure cap', () => {
  const empty: FeeState = { totalDonated: 0n, fundingFees: 0n, settlementFees: 0n }

  it('allows no fee at all when nothing was disclosed', () => {
    expect(maxFundingFee(empty, 0, 25_000_000n)).toBe(0n)
    expect(maxSettlementFee({ ...empty, totalDonated: 25_000_000n }, 0)).toBe(0n)
  })

  it('caps a first funding fee at bps of the gross', () => {
    expect(maxFundingFee(empty, 100, 25_000_000n)).toBe(250_000n)
  })

  it('caps cumulatively and never goes negative', () => {
    const state = { totalDonated: 24_750_000n, fundingFees: 250_000n, settlementFees: 0n }
    expect(maxFundingFee(state, 100, 10_000_000n)).toBe(100_000n)
    expect(maxFundingFee({ ...state, settlementFees: 1_000_000n }, 100, 10_000_000n)).toBe(0n)
  })

  /** Brute force against the resolver's own inequality: the cap is both safe and tight. */
  it('is exactly the largest fee the resolver accepts, before and after a deposit', () => {
    let seed = 42
    const random = (max: number): bigint => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return BigInt(seed % max)
    }
    for (let i = 0; i < 500; i++) {
      const bps = Number(random(2001))
      const state: FeeState = {
        totalDonated: random(50_000_000),
        fundingFees: random(500_000),
        settlementFees: random(500_000),
      }
      const gross = random(20_000_000) + 1n

      const cap = maxFundingFee(state, bps, gross)
      const afterFunding = (fee: bigint): FeeState => ({
        ...state,
        totalDonated: state.totalDonated + gross - fee,
        fundingFees: state.fundingFees + fee,
      })
      if (cap > 0n || withinCostCap(afterFunding(0n), bps)) {
        expect(withinCostCap(afterFunding(cap), bps)).toBe(true)
        expect(withinCostCap(afterFunding(cap + 1n), bps)).toBe(false)
      }

      // Resuming after a deposit of `net`: only the fee is free.
      const net = gross
      const deposited = { ...state, totalDonated: state.totalDonated + net }
      const resumeCap = maxFundingFeeAfterDeposit(deposited, bps)
      const attested = (fee: bigint): FeeState => ({ ...deposited, fundingFees: deposited.fundingFees + fee })
      if (resumeCap > 0n) {
        expect(withinCostCap(attested(resumeCap), bps)).toBe(true)
        expect(withinCostCap(attested(resumeCap + 1n), bps)).toBe(false)
      }

      const settlementCap = maxSettlementFee(state, bps)
      if (settlementCap > 0n) {
        expect(withinCostCap({ ...state, settlementFees: state.settlementFees + settlementCap }, bps)).toBe(
          true,
        )
        expect(
          withinCostCap({ ...state, settlementFees: state.settlementFees + settlementCap + 1n }, bps),
        ).toBe(false)
      }
    }
  })
})

describe('checkout ids', () => {
  const salt = `0x${'11'.repeat(32)}` as const

  it('derives a stable id from an Idempotency-Key, and a fresh one without', () => {
    expect(checkoutIdFor(salt, 'key-1')).toBe(checkoutIdFor(salt, 'key-1'))
    expect(checkoutIdFor(salt, 'key-1')).not.toBe(checkoutIdFor(salt, 'key-2'))
    expect(checkoutIdFor(`0x${'22'.repeat(32)}`, 'key-1')).not.toBe(checkoutIdFor(salt, 'key-1'))
    expect(checkoutIdFor(salt)).not.toBe(checkoutIdFor(salt))
    expect(checkoutIdFor(salt, 'key-1')).toMatch(
      /^CHK-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
  })
})

describe('CSV parsing', () => {
  const header = 'end_to_end_id,need_id,amount_eur,fee_eur,currency,donor_reference'

  it('accepts columns in any order, defaults fee and currency, and reports line numbers', () => {
    const rows = parseFundingCsv(
      `\uFEFFdonor_reference,need_id,end_to_end_id,amount_eur,fee_eur,currency\r\nD1,7,E2E-1,10.50,,\r\n\r\n"D,2",8,E2E-2,3,0.1,usd\r\n`,
      10,
    )
    expect(rows).toEqual([
      {
        line: 2,
        endToEndId: 'E2E-1',
        instruction: {
          endToEndId: 'E2E-1',
          needId: '7',
          grossEurCents: 1050,
          feeEurCents: 0,
          currency: 'EUR',
          donorReference: 'D1',
          source: 'CSV',
        },
      },
      {
        line: 4,
        endToEndId: 'E2E-2',
        instruction: {
          endToEndId: 'E2E-2',
          needId: '8',
          grossEurCents: 300,
          feeEurCents: 10,
          currency: 'USD',
          donorReference: 'D,2',
          source: 'CSV',
        },
      },
    ])
  })

  it.each([
    ['E2E,1,0,,,D', 'amount_eur'],
    ['E2E,1,1.00,2.00,,D', 'fee_eur cannot exceed'],
    ['E2E,x,1.00,,,D', 'need_id'],
    ['E2E,1,1.00,,EURO,D', 'currency'],
    ['E2E,1,1.00,,,', 'donor_reference'],
    [',1,1.00,,,D', 'end_to_end_id'],
    ['E2E,1,1.00', 'expected 6 columns'],
  ])('marks "%s" invalid without echoing values', (line, message) => {
    const [row] = parseFundingCsv(`${header}\n${line}\n`, 10)
    expect(row?.instruction).toBeUndefined()
    expect(row?.error).toContain(message)
  })

  it('rejects structural problems for the whole file', () => {
    expect(() => parseFundingCsv('', 10)).toThrow(/header/)
    expect(() => parseFundingCsv(`${header},card_number\nA,1,1,,,D,4242\n`, 10)).toThrow(
      /exactly these columns/,
    )
    expect(() => parseFundingCsv(`${header}\n`, 10)).toThrow(/no rows/)
    expect(() => parseFundingCsv(`${header}\nA,1,1,,,D\nB,1,1,,,D\n`, 1)).toThrow(/limited to 1 rows/)
  })
})
