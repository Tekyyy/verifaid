import type schema from 'ponder:schema'
import {
  categoryLabel,
  type ConversionView,
  type CustodyMode,
  type DepositAddressView,
  type DeliveryStatus,
  type DeliveryView,
  type DonationKind,
  type DonationView,
  type DonorTrancheSlice,
  getDeployment,
  type ImpactReportView,
  type NeedStatus,
  type NeedSummary,
  type PayeeChangeStatus,
  type PayeeChangeView,
  type PayeePaymentView,
  type PayeeView,
  regionLabel,
  resolveNetwork,
  type SettlementView,
  type SupplierApplicationView,
  type SupplierView,
  type TimelineEvent,
  type TimelineEventType,
  type TrancheStatus,
  tokenSymbolOf,
  type TrancheView,
  type WorkPhotoView,
} from '@poa/shared'
import { type Address, type Hex, zeroAddress } from 'viem'

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
export type DepositAddressRow = typeof schema.depositAddress.$inferSelect
export type PayeeRow = typeof schema.payee.$inferSelect
export type PayeePaymentRow = typeof schema.payeePayment.$inferSelect
export type PayeeChangeRow = typeof schema.payeeChange.$inferSelect
export type SupplierRow = typeof schema.supplier.$inferSelect
export type DepositRefundRow = typeof schema.depositRefund.$inferSelect
export type WorkPhotosRow = typeof schema.workPhotos.$inferSelect
export type SupplierApplicationRow = typeof schema.supplierApplication.$inferSelect

const deployment = getDeployment(resolveNetwork(process.env.PONDER_NETWORK ?? 'anvil'))

/** What is still missing to reach the target, while funding is open; zero once it is not. */
export const fundingGapOf = (row: NeedRow): bigint =>
  row.status === 'Funding' && row.targetAmount > row.totalDonated ? row.targetAmount - row.totalDonated : 0n

export const toNeedSummary = (row: NeedRow): Omit<NeedSummary, 'badges'> => ({
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

export const toWorkPhotoView = (row: WorkPhotosRow): WorkPhotoView => ({
  uid: row.uid as Hex,
  needId: row.needId.toString(),
  photos: (row.photos as string[]) ?? [],
  note: row.note,
  timestamp: row.timestamp,
  txHash: row.txHash as Hex,
})

export const toSupplierApplicationView = (
  row: SupplierApplicationRow,
  registered: boolean,
): SupplierApplicationView => ({
  uid: row.uid as Hex,
  supplier: row.supplier as Address,
  name: row.name,
  services: row.services,
  uri: row.uri,
  credentialHash: row.credentialHash as Hex,
  registered,
  timestamp: row.timestamp,
  txHash: row.txHash as Hex,
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

/** What the swap did for a CONVERTED donation; null for every other kind. */
export const toConversionView = (row: DonationRow): ConversionView | null => {
  if (row.kind !== 'CONVERTED') return null
  const tokenIn = (row.tokenIn as Address | null) ?? zeroAddress
  return {
    tokenIn,
    // Until the swap event of the same transaction is indexed the input is unknown; it never stays that way.
    tokenInSymbol: row.tokenIn ? tokenSymbolOf(deployment, tokenIn) : '',
    amountIn: (row.amountIn ?? 0n).toString(),
    amountOut: (row.converted ?? 0n).toString(),
    fairValue: (row.fairValue ?? 0n).toString(),
    conversionFee: (row.conversionFee ?? 0n).toString(),
    via: (row.via as Address | null) ?? zeroAddress,
    viaDepositAddress: row.viaDepositAddress ?? false,
  }
}

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
  conversion: toConversionView(row),
  txHash: row.txHash as Hex,
  timestamp: row.timestamp,
})

export const toDepositAddressView = (
  row: DepositAddressRow,
  sweeps: DonationRow[],
  refunds: DepositRefundRow[],
): DepositAddressView => ({
  address: row.address as Address,
  needId: row.needId.toString(),
  receiptTo: (row.receiptTo as Address | null) ?? null,
  refundTo: (row.refundTo as Address | null) ?? null,
  refundSigner: (row.refundSigner as Address | null) ?? null,
  salt: row.salt as Hex,
  deployedAt: row.deployedAt,
  sweeps: sweeps.map((sweep) => ({
    tokenIn: (sweep.tokenIn as Address | null) ?? zeroAddress,
    amountIn: (sweep.amountIn ?? 0n).toString(),
    converted: (sweep.converted ?? 0n).toString(),
    fairValue: (sweep.fairValue ?? 0n).toString(),
    deposited: sweep.amount.toString(),
    conversionFee: (sweep.conversionFee ?? 0n).toString(),
    txHash: sweep.txHash as Hex,
    timestamp: sweep.timestamp,
  })),
  refunds: refunds.map((refund) => ({
    kind: refund.kind as 'LEFTOVER' | 'VAULT',
    token: (refund.token as Address | null) ?? null,
    to: refund.to as Address,
    amount: refund.amount.toString(),
    txHash: refund.txHash as Hex,
    timestamp: refund.timestamp,
  })),
})

/**
 * One tracking view per deposit address: its sweeps add up to a single donation. Input amounts are summed only
 * when every sweep gave the same token (otherwise the input is left blank); per-sweep detail is in `deposit.sweeps`.
 */
export const combineSweeps = (sweeps: DonationRow[]): DonationRow => {
  const [first] = sweeps
  if (!first) throw new Error('combineSweeps needs at least one sweep')
  const sum = (pick: (row: DonationRow) => bigint | null) =>
    sweeps.reduce((total, row) => total + (pick(row) ?? 0n), 0n)
  const sameToken = sweeps.every((row) => row.tokenIn === first.tokenIn)
  return {
    ...first,
    amount: sum((row) => row.amount),
    converted: sum((row) => row.converted),
    fairValue: sum((row) => row.fairValue),
    conversionFee: sum((row) => row.conversionFee),
    tokenIn: sameToken ? first.tokenIn : null,
    amountIn: sameToken ? sum((row) => row.amountIn) : null,
  }
}

export const toPayeeView = (row: PayeeRow): PayeeView => ({
  index: row.index,
  account: (row.account as Address | null) ?? null,
  label: row.label,
  refHash: row.refHash as Hex,
  shareBps: row.shareBps as number[],
  needShareBps: row.needShareBps,
  paid: row.paid.toString(),
  held: row.held.toString(),
})

export const toPayeePaymentView = (row: PayeePaymentRow): PayeePaymentView => ({
  needId: row.needId.toString(),
  trancheIndex: row.trancheIndex,
  payee: row.payee as Address,
  payeeIndex: row.payeeIndex,
  toNgo: row.toNgo,
  amount: row.amount.toString(),
  held: row.held,
  txHash: row.txHash as Hex,
  timestamp: row.timestamp,
})

/** Independent approvals a change needs: the need's own verification threshold, but never fewer than two. */
export const toPayeeChangeView = (row: PayeeChangeRow, approvalsRequired: number): PayeeChangeView => ({
  changeId: row.changeId.toString(),
  index: row.index,
  from: row.from as Address,
  to: row.to as Address,
  label: row.label,
  refHash: row.refHash as Hex,
  approvals: row.approvals,
  approvalsRequired,
  approvedBy: row.approvedBy as Address[],
  status: row.status as PayeeChangeStatus,
  proposedAt: row.proposedAt,
  resolvedAt: row.resolvedAt,
})

export const toSupplierView = (row: SupplierRow, needIds: string[]): SupplierView => ({
  address: row.address as Address,
  credentialHash: row.credentialHash as Hex,
  metadataURI: row.metadataURI,
  active: row.active,
  registeredAt: row.registeredAt,
  totalPaid: row.totalPaid.toString(),
  needIds,
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
