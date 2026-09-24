import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CommunityProofView, ProofBountyView } from '@poa/shared'
import {
  acceptsBounty,
  acceptsProof,
  bountyDeadline,
  isPaying,
  openBountyOf,
  payableProofs,
  rewardsLeft,
} from './community.ts'

const NOW = 1_800_000_000

const bounty = (overrides: Partial<ProofBountyView> = {}): ProofBountyView => ({
  id: '1',
  needId: '4',
  ngo: '0x0000000000000000000000000000000000000001',
  reward: '5000000',
  maxRewards: 3,
  rewardsPaid: 0,
  balance: '15000000',
  deadline: NOW + 86_400,
  openedAt: NOW - 86_400,
  closed: false,
  closedAt: null,
  refunded: null,
  txHash: '0x00',
  ...overrides,
})

const proof = (
  id: string,
  submitter: string,
  overrides: Partial<CommunityProofView> = {},
): CommunityProofView => ({
  id,
  needId: '4',
  submitter: submitter as `0x${string}`,
  manifestHash: '0x00',
  manifest: null,
  manifestText: '{}',
  submittedAt: NOW - Number(id),
  txHash: '0x00',
  reward: null,
  ...overrides,
})

describe('community proof', () => {
  it('opens to proof once the money moves, and to a pot once the need is verified', () => {
    assert.equal(acceptsProof('Funding'), false)
    assert.equal(acceptsProof('InDelivery'), true)
    assert.equal(acceptsProof('Completed'), true)
    assert.equal(acceptsBounty('Pending'), false)
    assert.equal(acceptsBounty('Funding'), true)
    assert.equal(acceptsBounty('Cancelled'), false)
  })

  it('asks for a deadline the opening block still accepts, from the minimum to the maximum', () => {
    const DAY = 86_400
    // The contract wants block.timestamp + 1 day <= deadline <= block.timestamp + 365 days, and the block lands after
    // the page read the clock.
    const accepted = (deadline: bigint, block: number) =>
      deadline >= BigInt(block + DAY) && deadline <= BigInt(block + 365 * DAY)
    for (const days of [1, 30, 364, 365]) {
      for (const delay of [0, 12, 600]) {
        assert.equal(
          accepted(bountyDeadline(NOW, days), NOW + delay),
          true,
          `${days} days, block ${delay}s later`,
        )
      }
    }
    assert.equal(bountyDeadline(NOW, 30) - BigInt(NOW), BigInt(30 * DAY + 3_600))
  })

  it('finds the open pot and whether it still pays', () => {
    assert.equal(openBountyOf([bounty({ id: '2', closed: true })]), null)
    const open = bounty({ id: '3' })
    assert.equal(openBountyOf([bounty({ id: '2', closed: true }), open]), open)
    assert.equal(isPaying(open, NOW), true)
    assert.equal(isPaying(bounty({ deadline: NOW - 1 }), NOW), false, 'past its deadline')
    assert.equal(isPaying(bounty({ balance: '0', rewardsPaid: 3 }), NOW), false, 'empty')
    assert.equal(rewardsLeft(bounty({ rewardsPaid: 1 })), 2)
  })

  it('offers each wallet once per need, oldest first, and nothing filed after the deadline', () => {
    const pot = bounty()
    const paid = proof('1', '0xAAaa000000000000000000000000000000000000', {
      reward: { bountyId: '1', amount: '5000000', timestamp: NOW, txHash: '0x00' },
    })
    const sameWallet = proof('2', '0xaaaa000000000000000000000000000000000000')
    const late = proof('3', '0xbbbb000000000000000000000000000000000000', { submittedAt: NOW + 2 * 86_400 })
    const newer = proof('4', '0xcccc000000000000000000000000000000000000', { submittedAt: NOW - 10 })
    const older = proof('5', '0xdddd000000000000000000000000000000000000', { submittedAt: NOW - 20 })

    assert.deepEqual(
      payableProofs([paid, sameWallet, late, newer, older], pot).map((p) => p.id),
      ['5', '4'],
    )
    assert.deepEqual(payableProofs([older], bounty({ closed: true })), [])
    assert.deepEqual(payableProofs([older], null), [])
  })
})
