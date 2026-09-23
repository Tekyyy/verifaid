import {
  type DepositAddressView,
  type DonationOutcome,
  type DonationTrack,
  type DonorStage,
  type DonorStageView,
  formatAmount,
  type NeedBadges,
  type NeedPresentationView,
  type OrgTaxStatusView,
  type TrackingRefKind,
} from '@poa/shared'
import type { Hex } from 'viem'
import {
  type AcknowledgmentRow,
  type DeliveryApprovalRow,
  type DeliveryRow,
  type DonationRow,
  type ImpactReportRow,
  liveReport,
  type NeedRow,
  type PayeePaymentRow,
  type PayeeRow,
  type RefundRow,
  type SettlementRow,
  type TimelineRow,
  type TrancheRow,
  toAcknowledgmentView,
  toDeliveryView,
  toDonationView,
  toDonorTrancheSlice,
  toImpactReportView,
  toNeedSummary,
  toPayeeView,
  toSettlementView,
} from './views.js'

/**
 * Builds the public tracking view of one donation: the five stages the proposal promises donors, each backed by
 * the on-chain evidence that reached it, and what happened to this donation's share of the money.
 *
 * Every stage is a fact about the need, but the view is per donation because shares, refunds and the outcome
 * are. `pending` explains a stage that is partly there instead of pretending it is done or not started.
 */

export interface TrackInputs {
  ref: string
  refKind: TrackingRefKind
  donation: DonationRow
  need: NeedRow
  /** All donations to the same need by the same donor (address or salted reference), for refund attribution. */
  sameDonorDonations: DonationRow[]
  tranches: TrancheRow[]
  deliveries: DeliveryRow[]
  /** Donor approvals of those deliveries. */
  approvals: DeliveryApprovalRow[]
  settlements: SettlementRow[]
  reports: ImpactReportRow[]
  refunds: RefundRow[]
  timeline: TimelineRow[]
  /** The deposit address behind a 'deposit' reference, with its sweeps and refunds. */
  deposit: DepositAddressView | null
  /** The public record of the NGO behind the need, computed by the route that loaded it. */
  badges: NeedBadges
  /** How the NGO presents the need, or null when it published nothing. */
  presentation: NeedPresentationView | null
  /** The organisation's tax standing, and the donee's acknowledgment of this donation. */
  taxStatus: OrgTaxStatusView | null
  acknowledgment: AcknowledgmentRow | null
  /** The payment plan and the vault's payments to it. */
  payees: PayeeRow[]
  payments: PayeePaymentRow[]
}

const firstOfType = (timeline: TimelineRow[], type: string): TimelineRow | undefined =>
  timeline.find((row) => row.type === type)

const stage = (
  name: DonorStage,
  reached:
    | TimelineRow
    | { timestamp: number; txHash: string | null; attestationUID: string | null }
    | undefined,
  pending: string | null,
  attestationUID?: string | null,
): DonorStageView => ({
  stage: name,
  reached: Boolean(reached),
  at: reached?.timestamp ?? null,
  txHash: (reached?.txHash as Hex | null | undefined) ?? null,
  attestationUID: ((attestationUID ?? reached?.attestationUID) as Hex | null | undefined) ?? null,
  pending: reached ? null : pending,
})

export const buildDonationTrack = (inputs: TrackInputs): DonationTrack => {
  const { donation, need, tranches, deliveries, settlements, reports, refunds, timeline } = inputs

  // ── Verified ──
  const verified = firstOfType(timeline, 'NeedVerified')
  const lastApproval = [...timeline]
    .reverse()
    .find((row) => row.type === 'NeedVerificationRecorded' && (row.data as { approved?: boolean }).approved)
  const verifiedStage = stage(
    'Verified',
    verified,
    `${need.verificationCount} of ${need.verificationsRequired} independent verifications`,
    lastApproval?.attestationUID ?? null,
  )

  // ── Funded ──
  const funded = firstOfType(timeline, 'FundingClosed')
  const fundedStage = stage(
    'Funded',
    funded,
    need.status === 'Funding'
      ? `${formatAmount(need.totalDonated)} of ${formatAmount(need.targetAmount)} raised`
      : null,
  )

  // ── Settled ──
  // A vault paying the payment plan's suppliers directly is a settlement in itself: the transfer is the proof.
  // An NGO's Settlement attestation, when it files one, reconciles the same tranche from its side.
  const firstReport = [...settlements].sort((a, b) => a.timestamp - b.timestamp)[0]
  const firstPayment = inputs.payments.filter((payment) => !payment.held)[0]
  const firstSettlement =
    firstPayment && (!firstReport || firstPayment.timestamp < firstReport.timestamp)
      ? { timestamp: firstPayment.timestamp, txHash: firstPayment.txHash, uid: null }
      : firstReport
  const released = tranches.filter((tranche) => tranche.status === 'Released')
  const releasable = tranches.filter((tranche) => tranche.status === 'Releasable')
  let settledPending: string | null = null
  if (!firstSettlement) {
    if (released.length > 0) {
      settledPending = `Tranche ${released[0]?.index} released to the NGO; settlement report not yet filed`
    } else if (releasable.length > 0) {
      settledPending = `Tranche ${releasable[0]?.index} ready to be released to the NGO`
    }
  }
  const settledStage = stage(
    'Settled',
    firstSettlement
      ? {
          timestamp: firstSettlement.timestamp,
          txHash: firstSettlement.txHash,
          attestationUID: firstSettlement.uid,
        }
      : undefined,
    settledPending,
  )

  // ── Delivered ──
  // The first delivery the donors approved: they have seen, and accepted, how the money was spent.
  const approved = deliveries
    .filter((delivery) => delivery.status === 'Approved' && delivery.approvedAt !== null)
    .sort((a, b) => (a.approvedAt ?? 0) - (b.approvedAt ?? 0))[0]
  const approvedEvent = approved
    ? timeline.find(
        (row) =>
          row.type === 'DeliveryApproved' &&
          (row.data as { deliveryId?: string }).deliveryId === approved.id.toString(),
      )
    : undefined
  const active = deliveries.find((delivery) => delivery.status === 'Open')
  const pct = (part: bigint, whole: bigint) => (whole === 0n ? 0 : Number((part * 100n) / whole))
  const deliveredPending = active
    ? `Delivery #${active.id}: donors who gave ${pct(active.approvedAmount, need.totalDonated)}% of the raised amount have approved; ${pct(active.requiredAmount, need.totalDonated)}% is needed`
    : null
  const deliveredStage = stage(
    'Delivered',
    approved
      ? {
          timestamp: approved.approvedAt ?? approvedEvent?.timestamp ?? 0,
          txHash: approvedEvent?.txHash ?? null,
          attestationUID: null,
        }
      : undefined,
    deliveredPending,
  )

  // ── Impact confirmed ──
  const report = liveReport(reports)
  const reportEvent =
    report && !report.revoked
      ? timeline.find((row) => row.type === 'ImpactReportPublished' && row.attestationUID === report.uid)
      : undefined
  const impactStage = stage(
    'ImpactConfirmed',
    reportEvent,
    need.status === 'Completed' ? 'Need completed; impact report not yet published' : null,
  )

  const stages = [verifiedStage, fundedStage, settledStage, deliveredStage, impactStage]
  const currentStage = [...stages].reverse().find((view) => view.reached)?.stage ?? null

  // ── this donation's money ──
  const funding = need.totalDonated
  const share = (amount: bigint): bigint => (funding === 0n ? 0n : (amount * donation.amount) / funding)
  let releasedToNgo = 0n
  const donorTranches = tranches.map((tranche) => {
    const slice = share(tranche.amount)
    if (tranche.status === 'Released') releasedToNgo += slice
    return toDonorTrancheSlice(tranche, slice)
  })

  // A refund is paid per donor (address or salted reference), not per donation: attribute it pro rata.
  const donorTotal = inputs.sameDonorDonations.reduce((sum, row) => sum + row.amount, 0n)
  const refundedToDonor = refunds.reduce((sum, row) => sum + row.amount, 0n)
  const refunded = donorTotal === 0n ? 0n : (refundedToDonor * donation.amount) / donorTotal

  let outcome: DonationOutcome = 'InProgress'
  if (need.status === 'Completed') outcome = 'Completed'
  else if (need.status === 'Cancelled' || need.status === 'Expired') {
    if (refunded > 0n) outcome = 'Refunded'
    else if (funding > need.totalReleased) outcome = 'Refundable'
    else outcome = need.status
  }

  const updatedAt = timeline.reduce((latest, row) => Math.max(latest, row.timestamp), donation.timestamp)

  return {
    ref: inputs.ref,
    refKind: inputs.refKind,
    donation: toDonationView(donation),
    need: {
      ...toNeedSummary(need),
      badges: inputs.badges,
      presentation: inputs.presentation,
      taxStatus: inputs.taxStatus,
    },
    acknowledgment: inputs.acknowledgment ? toAcknowledgmentView(inputs.acknowledgment) : null,
    shareBps: funding === 0n ? 0 : Number((donation.amount * 10_000n) / funding),
    stages,
    currentStage,
    outcome,
    releasedToNgo: releasedToNgo.toString(),
    refunded: refunded.toString(),
    tranches: donorTranches,
    deliveries: deliveries.map((delivery) => toDeliveryView(delivery, inputs.approvals)),
    settlements: settlements.map(toSettlementView),
    impactReport: report ? toImpactReportView(report) : null,
    deposit: inputs.deposit,
    payees: inputs.payees.map(toPayeeView),
    updatedAt,
  }
}
