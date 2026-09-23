import {
  DONOR_STAGES,
  type DonationOutcome,
  type DonationTrack,
  type DonorStage,
  type DonorStageView,
  type NeedDetail,
  type NeedStatus,
} from '@poa/shared'

/**
 * Pure diffing: which donor stages and outcomes a subscriber has not been told about yet. No I/O here, so the
 * rule "each milestone is announced exactly once, history is never replayed" is unit-testable on its own.
 *
 * A milestone is a reached stage (`Verified` … `ImpactConfirmed`) or a final outcome (`Completed`, `Refundable`,
 * `Refunded`, `Expired`, `Cancelled`). The two vocabularies do not overlap, so both live in the same
 * `notifiedStages` list and the same dedupe key namespace.
 */

export const FINAL_OUTCOMES = [
  'Completed',
  'Refundable',
  'Refunded',
  'Expired',
  'Cancelled',
] as const satisfies readonly DonationOutcome[]
export type FinalOutcome = (typeof FINAL_OUTCOMES)[number]

export const isFinalOutcome = (outcome: DonationOutcome): outcome is FinalOutcome =>
  (FINAL_OUTCOMES as readonly string[]).includes(outcome)

/** What a subscription is following: one donation's stages, or a need's stages derived from the need itself. */
export interface Progress {
  stages: DonorStageView[]
  outcome: DonationOutcome
}

export type Milestone = { kind: 'stage'; stage: DonorStageView } | { kind: 'outcome'; outcome: FinalOutcome }

export const milestoneName = (milestone: Milestone): string =>
  milestone.kind === 'stage' ? milestone.stage.stage : milestone.outcome

/** Reached stages in donor order, then the outcome if it is final. */
export const reachedMilestones = (progress: Progress): Milestone[] => {
  const byName = new Map(progress.stages.map((view) => [view.stage, view]))
  const milestones: Milestone[] = []
  for (const stage of DONOR_STAGES) {
    const view = byName.get(stage)
    if (view?.reached) milestones.push({ kind: 'stage', stage: view })
  }
  if (isFinalOutcome(progress.outcome)) milestones.push({ kind: 'outcome', outcome: progress.outcome })
  return milestones
}

/** The value a new subscription's `notifiedStages` starts with, so it is not sent the history it already sees. */
export const reachedNames = (progress: Progress): string[] => reachedMilestones(progress).map(milestoneName)

export const newMilestones = (notified: readonly string[], progress: Progress): Milestone[] => {
  const seen = new Set(notified)
  return reachedMilestones(progress).filter((milestone) => !seen.has(milestoneName(milestone)))
}

/** The furthest stage reached, or null before verification. */
export const currentStage = (progress: Progress): DonorStage | null =>
  [...DONOR_STAGES]
    .reverse()
    .find((stage) => progress.stages.some((view) => view.stage === stage && view.reached)) ?? null

export const trackProgress = (track: DonationTrack): Progress => ({
  stages: track.stages,
  outcome: track.outcome,
})

const VERIFIED_STATUSES: readonly NeedStatus[] = ['Verified', 'Funding', 'Funded', 'InDelivery', 'Completed']
const FUNDED_STATUSES: readonly NeedStatus[] = ['Funded', 'InDelivery', 'Completed']

const stageView = (
  stage: DonorStage,
  reached: boolean,
  evidence: Partial<Pick<DonorStageView, 'at' | 'txHash' | 'attestationUID'>> = {},
): DonorStageView => ({
  stage,
  reached,
  at: reached ? (evidence.at ?? null) : null,
  txHash: reached ? (evidence.txHash ?? null) : null,
  attestationUID: reached ? (evidence.attestationUID ?? null) : null,
  pending: null,
})

/**
 * Need-level stages for subscriptions that follow a whole need rather than one donation. Same five stages, read
 * from the need: verification threshold met, funding closed, a Settlement attestation, a donor-approved delivery, an
 * unrevoked impact report. Refunds are per donation, so a need's final outcome is only Completed, Expired or
 * Cancelled.
 */
export const needProgress = (need: NeedDetail): Progress => {
  const settlement = need.settlements[0]
  const delivered = need.deliveries.find((delivery) => delivery.status === 'Approved')
  const impact = need.impactReport && !need.impactReport.revoked ? need.impactReport : null
  const verified =
    VERIFIED_STATUSES.includes(need.status) ||
    (need.verificationsRequired > 0 && need.verificationCount >= need.verificationsRequired)

  const outcome: DonationOutcome =
    need.status === 'Completed' || need.status === 'Expired' || need.status === 'Cancelled'
      ? need.status
      : 'InProgress'

  return {
    stages: [
      stageView('Verified', verified),
      stageView('Funded', FUNDED_STATUSES.includes(need.status)),
      stageView('Settled', Boolean(settlement), {
        at: settlement?.timestamp,
        txHash: settlement?.txHash,
        attestationUID: settlement?.uid,
      }),
      // The approving vote that crossed the threshold is the last approving vote recorded.
      stageView('Delivered', Boolean(delivered), {
        at: delivered?.decidedAt ?? undefined,
        txHash: delivered?.votes.filter((vote) => vote.approve).at(-1)?.txHash,
      }),
      stageView('ImpactConfirmed', Boolean(impact), { at: impact?.timestamp, attestationUID: impact?.uid }),
    ],
    outcome,
  }
}
