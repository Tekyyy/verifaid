import type schema from 'ponder:schema'
import {
  categoryLabel,
  type CustodyMode,
  type DeliveryStatus,
  type DeliveryView,
  type DonationKind,
  type DonationView,
  type DonorTrancheSlice,
  type ImpactReportView,
  type NeedStatus,
  type NeedSummary,
  regionLabel,
  type SettlementView,
  type TimelineEvent,
  type TimelineEventType,
  type TrancheStatus,
  type TrancheView,
} from '@poa/shared'
import type { Address, Hex } from 'viem'

/**
 * Row → API type mappers. Every response is one of the types exported by @poa/shared, with bigints serialized
 * as decimal strings in token base units (6 decimals).
 */

export type NeedRow = typeof schema.need.$inferSelect
export type TrancheRow = typeof schema.tranche.$inferSelect
export type DeliveryRow = typeof schema.delivery.$inferSelect
export type DonationRow = typeof schema.donation.$inferSelect
export type SettlementRow = typeof schema.settlement.$inferSelect
export type RefundRow = typeof schema.refund.$inferSelect
export type TimelineRow = typeof schema.timelineEvent.$inferSelect
export type ImpactReportRow = typeof schema.impactReport.$inferSelect

/** What is still missing to reach the target, while funding is open; zero once it is not. */
export const fundingGapOf = (row: NeedRow): bigint =>
  row.status === 'Funding' && row.targetAmount > row.totalDonated ? row.targetAmount - row.totalDonated : 0n

export const toNeedSummary = (row: NeedRow): NeedSummary => ({
  id: row.id.toString(),
  ngo: row.ngo as Address,
  // The NGO's display name lives in the off-chain profile JSON at metadataURI; only the URI is on-chain.
  ngoName: null,
  programId: row.programId.toString(),
  category: row.category,
  categoryLabel: categoryLabel(row.category as Hex),
  regionCode: row.regionCode,
  regionLabel: regionLabel(row.regionCode as Hex),
  country: row.country,
  targetAmount: row.targetAmount.toString(),
  totalDonated: row.totalDonated.toString(),
  totalReleased: row.totalReleased.toString(),
  totalRefunded: row.totalRefunded.toString(),
  fundingGap: fundingGapOf(row).toString(),
  status: row.status as NeedStatus,
  custodyMode: row.custodyMode as CustodyMode,
  vault: (row.vault as Address | null) ?? null,
  metadataURI: row.metadataURI,
  verificationsRequired: row.verificationsRequired,
  verificationCount: row.verificationCount,
  fundingDeadline: row.fundingDeadline,
  executionDeadline: row.executionDeadline,
  minFundingBps: row.minFundingBps,
  thirdPartyCostBps: row.thirdPartyCostBps,
  expectedOutcomeHash: row.expectedOutcomeHash as Hex,
  costDisclosureHash: (row.costDisclosureHash as Hex | null) ?? null,
  custodian: (row.custodian as Address | null) ?? null,
  fundingFees: row.fundingFees.toString(),
  settlementFees: row.settlementFees.toString(),
  createdAt: row.createdAt,
  expiredAt: row.expiredAt,
})

export const toTrancheView = (row: TrancheRow): TrancheView => ({
  index: row.index,
  bps: row.bps,
  amount: row.amount.toString(),
  status: row.status as TrancheStatus,
  deliveryId: row.deliveryId?.toString() ?? null,
  releasedAt: row.releasedAt,
  releaseTxHash: (row.releaseTxHash as Hex | null) ?? null,
})

/** `amount` stays the real tranche; `donorShare` is this donor's slice of it. Never conflate the two. */
export const toDonorTrancheSlice = (row: TrancheRow, donorShare: bigint): DonorTrancheSlice => ({
  ...toTrancheView(row),
  donorShare: donorShare.toString(),
})

export const toDeliveryView = (row: DeliveryRow): DeliveryView => ({
  id: row.id.toString(),
  needId: row.needId.toString(),
  trancheIndex: row.trancheIndex,
  fieldAgent: row.fieldAgent as Address,
  expectedRecipients: row.expectedRecipients,
  confirmations: row.confirmations,
  confirmationRatio:
    row.expectedRecipients === 0
      ? 0
      : Math.round((row.confirmations / row.expectedRecipients) * 10_000) / 10_000,
  status: row.status as DeliveryStatus,
  evidenceUID: (row.evidenceUID as Hex | null) ?? null,
  evidenceCID: row.evidenceCID,
  verifierUID: (row.verifierUID as Hex | null) ?? null,
  verifier: (row.verifier as Address | null) ?? null,
  challengeDeadline: row.challengeDeadline,
})

export const toDonationView = (row: DonationRow): DonationView => ({
  id: row.id,
  needId: row.needId.toString(),
  kind: row.kind as DonationKind,
  donor: (row.donor as Address | null) ?? null,
  donorRefHash: (row.donorRefHash as Hex | null) ?? null,
  paymentRefHash: (row.paymentRefHash as Hex | null) ?? null,
  amount: row.amount.toString(),
  gross: row.gross?.toString() ?? null,
  fee: row.fee?.toString() ?? null,
  currency: row.currency,
  receiptId: row.receiptId?.toString() ?? null,
  attestationUID: (row.attestationUID as Hex | null) ?? null,
  txHash: row.txHash as Hex,
  timestamp: row.timestamp,
})

export const toSettlementView = (row: SettlementRow): SettlementView => ({
  uid: row.uid as Hex,
  needId: row.needId.toString(),
  trancheIndex: row.trancheIndex,
  attester: row.attester as Address,
  gross: row.gross.toString(),
  fee: row.fee.toString(),
  net: row.net.toString(),
  supplierRefHash: row.supplierRefHash as Hex,
  fxRef: row.fxRef as Hex,
  txHash: row.txHash as Hex,
  timestamp: row.timestamp,
})

export const toTimelineEvent = (row: TimelineRow): TimelineEvent => ({
  id: row.id,
  needId: row.needId.toString(),
  type: row.type as TimelineEventType,
  data: row.data as TimelineEvent['data'],
  attestationUID: (row.attestationUID as Hex | null) ?? null,
  txHash: row.txHash as Hex,
  blockNumber: Number(row.blockNumber),
  logIndex: row.logIndex,
  timestamp: row.timestamp,
})

export const toImpactReportView = (row: ImpactReportRow): ImpactReportView => ({
  needId: row.needId.toString(),
  uid: row.uid as Hex,
  beneficiariesServed: row.beneficiariesServed,
  kpiHash: row.kpiHash as Hex,
  reportCID: row.reportCID,
  revoked: row.revoked,
  timestamp: row.timestamp,
})

/** The live report if there is one, otherwise the latest revoked one (kept for the audit trail). */
export const liveReport = (reports: ImpactReportRow[]): ImpactReportRow | undefined =>
  reports.find((report) => !report.revoked) ?? reports[0]
