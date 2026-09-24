import type { CommunityProofView, NeedStatus, ProofBountyView } from '@poa/shared'

/**
 * Community proof: photos of a need filed by people who do not run it, and the reward pots an NGO funds from its own
 * wallet to pay for useful ones. Pure helpers shared by the need page, the NGO dashboard and the "prove & earn" list.
 */

/** Mirrors CommunityProofs: proof can be filed once a need's money has started to move. */
const PROOF_STATUSES: readonly NeedStatus[] = ['Funded', 'InDelivery', 'Completed']

/** Mirrors CommunityProofs: a pot can be opened on any need that is verified and not over. */
const BOUNTY_STATUSES: readonly NeedStatus[] = ['Verified', 'Funding', 'Funded', 'InDelivery', 'Completed']

export const MAX_REWARDS = 1000
export const MIN_BOUNTY_DAYS = 1
export const MAX_BOUNTY_DAYS = 365

/** Slack for the time between reading the chain's clock and the block that opens the pot. */
const DEADLINE_SLACK_SECONDS = 3_600

/**
 * The deadline to ask for when a pot is open for `days`. The contract counts from the timestamp of the block that
 * opens it, which lands after the page read the chain's clock, so the deadline gets an hour's slack — without it the
 * one-day minimum would always be refused — and is capped at the maximum, which that later block only widens.
 * `chainNow` is the latest block's timestamp, not the browser's clock: a local chain can run hours ahead.
 */
export const bountyDeadline = (chainNow: number, days: number): bigint =>
  BigInt(Math.min(chainNow + days * 86_400 + DEADLINE_SLACK_SECONDS, chainNow + MAX_BOUNTY_DAYS * 86_400))

export const acceptsProof = (status: NeedStatus): boolean => PROOF_STATUSES.includes(status)

export const acceptsBounty = (status: NeedStatus): boolean => BOUNTY_STATUSES.includes(status)

/** The pot still open on a need, if any: the contract allows one at a time. */
export const openBountyOf = (bounties: readonly ProofBountyView[]): ProofBountyView | null =>
  bounties.find((bounty) => !bounty.closed) ?? null

/** An open pot still paying for new proof: not closed, before its deadline, and with money left. */
export const isPaying = (bounty: ProofBountyView | null, now: number): bounty is ProofBountyView =>
  Boolean(
    bounty && !bounty.closed && now <= bounty.deadline && BigInt(bounty.balance) >= BigInt(bounty.reward),
  )

export const rewardsLeft = (bounty: ProofBountyView): number => bounty.maxRewards - bounty.rewardsPaid

/**
 * What the NGO can still pay for from the open pot: unpaid proof filed before the deadline, from wallets not yet
 * paid on this need (one reward per wallet per need), oldest first — the order people filed in.
 */
export const payableProofs = (
  proofs: readonly CommunityProofView[],
  bounty: ProofBountyView | null,
): CommunityProofView[] => {
  if (!bounty || bounty.closed) return []
  const paid = new Set(proofs.filter((proof) => proof.reward).map((proof) => proof.submitter.toLowerCase()))
  return proofs
    .filter(
      (proof) =>
        !proof.reward && proof.submittedAt <= bounty.deadline && !paid.has(proof.submitter.toLowerCase()),
    )
    .sort((a, b) => a.submittedAt - b.submittedAt || Number(a.id) - Number(b.id))
}
