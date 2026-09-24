import { describe, expect, it } from 'vitest'
import { formatCursor, parseCursor } from '../src/indexer.js'
import {
  currentStage,
  milestoneName,
  needProgress,
  newMilestones,
  reachedNames,
  trackProgress,
} from '../src/stages.js'
import { BACKOFF_MS, MAX_ATTEMPTS, retryAt } from '../src/worker/dispatcher.js'
import { needFixture, trackFixture } from './helpers/fakes.js'

describe('stage diffing', () => {
  const need = needFixture('5')

  it('records only reached stages, in donor order, as the initial notified set', () => {
    const track = trackFixture('12', need, ['Funded', 'Verified'])
    expect(reachedNames(trackProgress(track))).toEqual(['Verified', 'Funded'])
    expect(currentStage(trackProgress(track))).toBe('Funded')
  })

  it('announces nothing that was already notified', () => {
    const track = trackFixture('12', need, ['Verified', 'Funded'])
    expect(newMilestones(['Verified', 'Funded'], trackProgress(track))).toEqual([])
  })

  it('announces every newly reached stage, even several at once', () => {
    const track = trackFixture('12', need, ['Verified', 'Funded', 'Settled', 'Delivered'])
    const fresh = newMilestones(['Verified'], trackProgress(track))
    expect(fresh.map(milestoneName)).toEqual(['Funded', 'Settled', 'Delivered'])
    expect(fresh.every((milestone) => milestone.kind === 'stage')).toBe(true)
  })

  it('treats a final outcome as a milestone but never InProgress', () => {
    const inProgress = trackFixture('12', need, ['Verified'], 'InProgress')
    expect(reachedNames(trackProgress(inProgress))).toEqual(['Verified'])

    const refundable = trackFixture('12', need, ['Verified'], 'Refundable')
    expect(newMilestones(['Verified'], trackProgress(refundable))).toEqual([
      { kind: 'outcome', outcome: 'Refundable' },
    ])

    // Refundable → Refunded is a second, distinct alert.
    const refunded = trackFixture('12', need, ['Verified'], 'Refunded')
    expect(newMilestones(['Verified', 'Refundable'], trackProgress(refunded)).map(milestoneName)).toEqual([
      'Refunded',
    ])
  })

  it('carries the on-chain evidence of the stage it announces', () => {
    const track = trackFixture('12', need, ['Verified', 'Funded'])
    const [milestone] = newMilestones(['Verified'], trackProgress(track))
    expect(milestone?.kind === 'stage' && milestone.stage.txHash).toMatch(/^0x/)
  })

  it('derives need-level stages from the need itself', () => {
    expect(reachedNames(needProgress(needFixture('5', { status: 'Pending', verificationCount: 1 })))).toEqual(
      [],
    )
    expect(reachedNames(needProgress(needFixture('5', { status: 'Funding' })))).toEqual(['Verified'])

    const delivered = needFixture('5', {
      status: 'Completed',
      settlements: [
        {
          uid: `0x${'11'.repeat(32)}`,
          needId: '5',
          trancheIndex: 0,
          attester: '0x00000000000000000000000000000000000000d4',
          gross: '100',
          fee: '1',
          net: '99',
          supplierRefHash: `0x${'22'.repeat(32)}`,
          fxRef: `0x${'33'.repeat(32)}`,
          txHash: `0x${'44'.repeat(32)}`,
          timestamp: 1_700_000_500,
        },
      ],
      deliveries: [
        {
          id: '1',
          needId: '5',
          trancheIndex: 0,
          submitter: '0x00000000000000000000000000000000000000e5',
          status: 'Approved',
          evidenceHash: `0x${'55'.repeat(32)}`,
          manifest: null,
          manifestText: '{}',
          approvedAmount: '400000000',
          rejectedAmount: '0',
          requiredAmount: '300000000',
          rejectionAmount: '500000000',
          verifierApprovals: 0,
          verifierRejections: 0,
          requiredVerifiers: 0,
          votes: [],
          submittedAt: 1_700_000_600,
          decidedAt: 1_700_000_700,
          supersededBy: null,
          contested: false,
          cancelledNeed: false,
          txHash: `0x${'77'.repeat(32)}`,
        },
      ],
      impactReport: {
        needId: '5',
        uid: `0x${'66'.repeat(32)}`,
        beneficiariesServed: 9,
        kpiHash: `0x${'77'.repeat(32)}`,
        reportCID: 'bafy',
        revoked: false,
        timestamp: 1_700_000_900,
      },
    })
    const progress = needProgress(delivered)
    expect(reachedNames(progress)).toEqual([
      'Verified',
      'Funded',
      'Settled',
      'Delivered',
      'ImpactConfirmed',
      'Completed',
    ])
    expect(progress.stages.find((view) => view.stage === 'Settled')?.at).toBe(1_700_000_500)
  })

  it("marks Impact confirmed not applicable on a person's own need, which completes without a report", () => {
    const own = needFixture('5', { status: 'Completed', beneficiary: '0x00000000000000000000000000000000000000b1' })
    const progress = needProgress(own)
    const impact = progress.stages.find((view) => view.stage === 'ImpactConfirmed')
    expect(impact).toMatchObject({ reached: false, notApplicable: true })
    expect(reachedNames(progress)).toEqual(['Verified', 'Funded', 'Completed'])
  })

  it('ignores a revoked impact report', () => {
    const need5 = needFixture('5', {
      status: 'InDelivery',
      impactReport: {
        needId: '5',
        uid: `0x${'66'.repeat(32)}`,
        beneficiariesServed: 1,
        kpiHash: `0x${'77'.repeat(32)}`,
        reportCID: 'bafy',
        revoked: true,
        timestamp: 1,
      },
    })
    expect(reachedNames(needProgress(need5))).not.toContain('ImpactConfirmed')
  })
})

describe('retry schedule', () => {
  it('backs off 1 min, 5 min, 30 min, 2 h, 12 h and gives up after the sixth attempt', () => {
    const now = new Date('2026-01-01T00:00:00Z')
    const delays = [1, 2, 3, 4, 5].map((attempt) => (retryAt(attempt, now)?.getTime() ?? 0) - now.getTime())
    expect(delays).toEqual([60_000, 300_000, 1_800_000, 7_200_000, 43_200_000])
    expect(delays).toEqual([...BACKOFF_MS])
    expect(MAX_ATTEMPTS).toBe(6)
    expect(retryAt(6, now)).toBeNull()
  })
})

describe('timeline cursor', () => {
  it('round-trips "<block>:<logIndex>" and rejects anything else', () => {
    const cursor = parseCursor('123456789:42')
    expect(cursor).toEqual({ blockNumber: 123456789n, logIndex: 42 })
    expect(cursor && formatCursor(cursor)).toBe('123456789:42')
    expect(parseCursor('12')).toBeNull()
    expect(parseCursor('a:b')).toBeNull()
    expect(parseCursor('1:2:3')).toBeNull()
  })
})
