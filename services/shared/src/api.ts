import type { Address, Hex } from 'viem'
import type { DeliveryStatus, NeedStatus, SchemaName, TrancheStatus } from './types.js'

/**
 * The contract between the Ponder indexer and everything that reads it (dashboard, demo runner).
 * All amounts are decimal strings in token base units (6 decimals), because JSON has no bigint.
 */

export interface NeedSummary {
  id: string
  ngo: Address
  ngoName?: string | null
  programId: string
  category: string
  categoryLabel: string
  regionCode: string
  regionLabel: string
  targetAmount: string
  totalDonated: string
  totalReleased: string
  status: NeedStatus
  vault: Address | null
  metadataURI: string
  verificationsRequired: number
  verificationCount: number
  createdAt: number
}

export interface TrancheView {
  index: number
  bps: number
  amount: string
  status: TrancheStatus
  deliveryId: string | null
  releasedAt: number | null
  releaseTxHash: Hex | null
}

export interface DeliveryView {
  id: string
  needId: string
  trancheIndex: number
  fieldAgent: Address
  expectedRecipients: number
  confirmations: number
  confirmationRatio: number
  status: DeliveryStatus
  evidenceUID: Hex | null
  evidenceCID: string | null
  verifierUID: Hex | null
  verifier: Address | null
  challengeDeadline: number | null
}

export interface DonationView {
  id: string
  needId: string
  kind: 'DIRECT' | 'FIAT'
  donor: Address | null
  donorRefHash: Hex | null
  paymentRefHash: Hex | null
  amount: string
  receiptId: string | null
  attestationUID: Hex | null
  txHash: Hex
  timestamp: number
}

export interface NeedDetail extends NeedSummary {
  tranches: TrancheView[]
  deliveries: DeliveryView[]
  donations: DonationView[]
  impactReport: ImpactReportView | null
}

export type TimelineEventType =
  | 'NeedCreated'
  | 'NeedVerificationRecorded'
  | 'NeedVerified'
  | 'NeedStatusChanged'
  | 'NeedCancelled'
  | 'VerificationRevoked'
  | 'Donated'
  | 'DonatedOnBehalf'
  | 'FundingClosed'
  | 'TrancheReleasable'
  | 'TrancheReleased'
  | 'Refunded'
  | 'DeliveryOpened'
  | 'DeliveryEvidenceLinked'
  | 'ReceiptConfirmed'
  | 'DeliveryVerifiedLinked'
  | 'DeliveryChallengeable'
  | 'DeliveryChallenged'
  | 'DisputeResolved'
  | 'DeliveryFinalized'
  | 'DeliveryRejected'
  | 'ImpactReportPublished'

export interface TimelineEvent {
  id: string
  needId: string
  type: TimelineEventType
  /** Event-specific fields, already stringified where they were bigints. */
  data: Record<string, string | number | boolean | null>
  attestationUID: Hex | null
  txHash: Hex
  blockNumber: number
  timestamp: number
}

export interface AttestationView {
  uid: Hex
  schemaName: SchemaName
  attester: Address
  recipient: Address
  refUID: Hex | null
  revoked: boolean
  decoded: Record<string, string | number | boolean>
  txHash: Hex
  timestamp: number
}

export interface ImpactReportView {
  needId: string
  uid: Hex
  beneficiariesServed: number
  kpiHash: Hex
  reportCID: string
  revoked: boolean
  timestamp: number
}

/** "Follow my money": what one donor's contribution actually paid for. */
export interface DonorTrace {
  donor: Address
  totalDonated: string
  receipts: DonorReceiptTrace[]
}

/**
 * One tranche as it appears in a donor's trace: the tranche's real amount plus this donor's pro-rata slice of
 * it. Both numbers are given explicitly, because showing one where the reader expects the other is exactly the
 * kind of misleading number this project exists to avoid.
 */
export interface DonorTrancheSlice extends TrancheView {
  /** This donor's pro-rata share of `amount`, in token base units. */
  donorShare: string
}

export interface DonorReceiptTrace {
  receiptId: string
  needId: string
  needStatus: NeedStatus
  category: string
  regionCode: string
  amount: string
  /** Donor's share of the need's funding, in basis points. */
  shareBps: number
  /** Sum of this donor's slices of the tranches that have actually been released to the NGO. */
  releasedToNgo: string
  refunded: string
  /** `amount` is the full tranche; `donorShare` is this donor's part of it. */
  tranches: DonorTrancheSlice[]
  deliveries: DeliveryView[]
}

export interface ImpactSummary {
  totals: {
    needs: number
    needsCompleted: number
    donated: string
    released: string
    refunded: string
    deliveriesFinalized: number
    confirmations: number
    beneficiariesServed: number
  }
  byCategory: ImpactBucket[]
  byRegion: ImpactBucket[]
}

export interface ImpactBucket {
  key: string
  label: string
  needs: number
  donated: string
  released: string
  deliveriesFinalized: number
  beneficiariesServed: number
}

export interface ProgramMembersResponse {
  programId: string
  groupId: string
  memberCount: number
  /** Identity commitments as decimal strings, in insertion order — the order that reproduces the Merkle root. */
  members: string[]
  merkleTreeDepth: number
}
