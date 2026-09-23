import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { NeedSummary, TrancheView } from '@poa/shared'
import {
  earningsUpTo,
  isLongCampaign,
  LONG_CAMPAIGN_DAYS,
  MIN_TVL_USD,
  type MorphoVaultsResponse,
  normalizeMorphoVaults,
  optInState,
  waitingCapital,
  waitingWindow,
} from './campaigns.ts'

const DAY = 86_400
const NOW = 1_800_000_000
const USDC = (whole: number) => String(BigInt(whole) * 1_000_000n)

type Need = Pick<
  NeedSummary,
  | 'status'
  | 'targetAmount'
  | 'totalDonated'
  | 'totalReleased'
  | 'totalRefunded'
  | 'fundingDeadline'
  | 'executionDeadline'
  | 'idleCapital'
>

const need = (overrides: Partial<Need> = {}): Need => ({
  status: 'Funding',
  targetAmount: USDC(10_000),
  totalDonated: USDC(4_000),
  totalReleased: '0',
  totalRefunded: '0',
  fundingDeadline: NOW + 30 * DAY,
  executionDeadline: NOW + 150 * DAY,
  idleCapital: null,
  ...overrides,
})

const tranches = (bps: number[], released = 0): Pick<TrancheView, 'index' | 'bps' | 'status'>[] =>
  bps.map((share, index) => ({ index, bps: share, status: index < released ? 'Released' : 'Locked' }))

describe('long campaigns', () => {
  it('counts the window from funding closing, or from now once it has', () => {
    assert.equal(waitingWindow(need(), NOW), 120 * DAY)
    assert.equal(waitingWindow(need({ fundingDeadline: NOW - 10 * DAY }), NOW), 150 * DAY)
    assert.equal(waitingWindow(need({ executionDeadline: null }), NOW), 0)
  })

  it(`is long from ${LONG_CAMPAIGN_DAYS} days, and only while there is work ahead`, () => {
    assert.equal(
      isLongCampaign(need({ executionDeadline: NOW + 30 * DAY + LONG_CAMPAIGN_DAYS * DAY }), NOW),
      true,
    )
    assert.equal(isLongCampaign(need({ executionDeadline: NOW + 30 * DAY + 89 * DAY }), NOW), false)
    assert.equal(isLongCampaign(need({ status: 'Completed' }), NOW), false)
  })

  it('reads the opt-in from the indexer, not from a guess', () => {
    const idle = { venue: null, deployed: '0', earned: '0', paidOut: '0', lost: '0' }
    assert.equal(optInState(need({ idleCapital: idle })), 'optedIn')
    assert.equal(optInState(need({ status: 'Pending' })), 'canOptIn')
    assert.equal(optInState(need()), 'notOptedIn')
  })
})

describe('waitingCapital', () => {
  it('plans on the target before close, leaving out tranche 0, which pays out at close', () => {
    const waiting = waitingCapital(need(), tranches([4000, 6000]), 8000, NOW)
    // 60% of the target is locked behind deliveries; the 80% cap is not the binding limit.
    assert.equal(waiting.amount, 6_000_000_000n)
    assert.equal(waiting.basis, 'target')
    assert.equal(waiting.seconds, 120 * DAY)
  })

  it('never exceeds the approved cap of the pot', () => {
    const waiting = waitingCapital(need(), tranches([1000, 9000]), 5000, NOW)
    assert.equal(waiting.amount, 5_000_000_000n)
  })

  it('works from what was raised and what is still locked once funding has closed', () => {
    const closed = need({
      status: 'InDelivery',
      totalDonated: USDC(8_000),
      totalReleased: USDC(2_400),
      fundingDeadline: NOW - DAY,
    })
    const waiting = waitingCapital(closed, tranches([3000, 4000, 3000], 1), 8000, NOW)
    // 70% of 8,000 is still locked (5,600), the pot is 5,600, and 80% of it is the ceiling.
    assert.equal(waiting.amount, 4_480_000_000n)
    assert.equal(waiting.basis, 'raised')
  })

  it('is zero with no venue cap', () => {
    assert.equal(waitingCapital(need(), tranches([4000, 6000]), 0, NOW).amount, 0n)
  })
})

describe('earningsUpTo', () => {
  it('is simple interest on the whole amount for the whole window', () => {
    // 6,000 USDC at 4.5% for a year.
    assert.equal(earningsUpTo({ amount: 6_000_000_000n, seconds: 365 * DAY }, 0.045), 270_000_000n)
  })

  it('is zero for a bad or negative rate, or nothing to lend', () => {
    assert.equal(earningsUpTo({ amount: 1n, seconds: DAY }, Number.NaN), 0n)
    assert.equal(earningsUpTo({ amount: 1_000_000n, seconds: DAY }, -0.01), 0n)
    assert.equal(earningsUpTo({ amount: 0n, seconds: DAY }, 0.05), 0n)
  })
})

describe('normalizeMorphoVaults', () => {
  const v1 = (name: string, tvl: number, extra: Record<string, unknown> = {}) => ({
    address: `0x${name.length.toString(16).padStart(40, 'a')}`,
    name,
    listed: true,
    state: { netApy: 0.0443, totalAssetsUsd: tvl, curators: [{ name: 'Gauntlet' }] },
    liquidity: { usd: tvl / 2 },
    warnings: [],
    ...extra,
  })

  it('keeps listed, warning-free vaults above the size floor, most withdrawable first, from both versions', () => {
    const response = {
      data: {
        vaults: {
          items: [
            v1('Small', MIN_TVL_USD - 1),
            v1('Big', 400e6),
            v1('Flagged', 300e6, { warnings: [{ type: 'bad_debt', level: 'RED' }] }),
            v1('Unlisted', 200e6, { listed: false }),
          ],
        },
        vaultV2s: {
          items: [
            {
              address: `0x${'b'.repeat(40)}`,
              name: 'Prime V2',
              listed: true,
              netApy: 0.05,
              totalAssetsUsd: 500e6,
              liquidityUsd: 100e6,
              curators: { items: [{ name: 'Steakhouse' }] },
              warnings: [],
            },
          ],
        },
      },
    } as MorphoVaultsResponse
    const vaults = normalizeMorphoVaults(response)
    assert.deepEqual(
      vaults.map((vault) => [vault.name, vault.version, vault.curator]),
      [
        ['Big', 'v1', 'Gauntlet'],
        ['Prime V2', 'v2', 'Steakhouse'],
      ],
    )
    assert.match(vaults[1]?.url ?? '', /^https:\/\/app\.morpho\.org\/base\/vault\/0x/)
  })

  it('drops a vault with no rate instead of showing a made-up one', () => {
    const response = {
      data: { vaults: { items: [v1('NoRate', 400e6, { state: { netApy: null, totalAssetsUsd: 400e6 } })] } },
    } as MorphoVaultsResponse
    assert.deepEqual(normalizeMorphoVaults(response), [])
    assert.deepEqual(normalizeMorphoVaults({}), [])
  })
})
