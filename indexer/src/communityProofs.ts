import { ponder } from 'ponder:registry'
import schema from 'ponder:schema'
import { appendTimeline, seconds } from './lib/timeline.js'

/**
 * v10: proof about a need from people who do not run it, and the reward pots NGOs fund for it from their own
 * wallets. Community proof is context for donors: nothing here moves or blocks a need's money.
 */

ponder.on('CommunityProofs:ProofSubmitted', async ({ event, context }) => {
  const { proofId, needId, submitter, manifestHash, manifest } = event.args
  await context.db.insert(schema.communityProof).values({
    id: proofId,
    needId,
    submitter,
    manifestHash,
    manifest,
    submittedAt: seconds(event),
    txHash: event.transaction.hash,
    rewardBountyId: null,
    rewardAmount: null,
    rewardedAt: null,
    rewardTxHash: null,
  })
  await appendTimeline(context, event, {
    needId,
    type: 'CommunityProofSubmitted',
    data: { proofId: proofId.toString(), submitter, manifestHash },
  })
})

ponder.on('CommunityProofs:BountyOpened', async ({ event, context }) => {
  const { bountyId, needId, ngo, reward, maxRewards, deadline } = event.args
  await context.db.insert(schema.proofBounty).values({
    id: bountyId,
    needId,
    ngo,
    reward,
    maxRewards: Number(maxRewards),
    rewardsPaid: 0,
    balance: reward * maxRewards,
    deadline: Number(deadline),
    openedAt: seconds(event),
    closed: false,
    closedAt: null,
    refunded: null,
    txHash: event.transaction.hash,
  })
  await appendTimeline(context, event, {
    needId,
    type: 'ProofBountyOpened',
    data: {
      bountyId: bountyId.toString(),
      reward: reward.toString(),
      maxRewards: Number(maxRewards),
      deadline: Number(deadline),
    },
  })
})

ponder.on('CommunityProofs:ProofRewarded', async ({ event, context }) => {
  const { proofId, bountyId, needId, submitter, amount } = event.args
  await context.db.update(schema.communityProof, { id: proofId }).set({
    rewardBountyId: bountyId,
    rewardAmount: amount,
    rewardedAt: seconds(event),
    rewardTxHash: event.transaction.hash,
  })
  await context.db.update(schema.proofBounty, { id: bountyId }).set((row) => ({
    rewardsPaid: row.rewardsPaid + 1,
    balance: row.balance - amount,
  }))
  await appendTimeline(context, event, {
    needId,
    type: 'CommunityProofRewarded',
    data: {
      proofId: proofId.toString(),
      bountyId: bountyId.toString(),
      submitter,
      amount: amount.toString(),
    },
  })
})

ponder.on('CommunityProofs:BountyClosed', async ({ event, context }) => {
  const { bountyId, needId, refunded } = event.args
  await context.db.update(schema.proofBounty, { id: bountyId }).set({
    closed: true,
    closedAt: seconds(event),
    refunded,
    balance: 0n,
  })
  await appendTimeline(context, event, {
    needId,
    type: 'ProofBountyClosed',
    data: { bountyId: bountyId.toString(), refunded: refunded.toString() },
  })
})
