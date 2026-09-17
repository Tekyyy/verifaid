import type { Address, Hex } from 'viem'
import type { CustodyMode, DeliveryStatus, NeedStatus, SchemaName, TrancheStatus } from './types.js'

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
  /** ISO 3166-1 alpha-2 country, the prefix of the ISO 3166-2 region ("ES-CM" → "ES"). */
  country: string
  targetAmount: string
  totalDonated: string
  totalReleased: string
  totalRefunded: string
  /** `targetAmount - totalDonated` while funding is open, "0" afterwards. */
  fundingGap: string
  status: NeedStatus
  custodyMode: CustodyMode
  vault: Address | null
  metadataURI: string
  verificationsRequired: number
  verificationCount: number
  /** Unix seconds; null when open-ended. */
  fundingDeadline: number | null
  executionDeadline: number | null
  /** Share of the target that must be raised for the need to go ahead (10000 = all or nothing). */
  minFundingBps: number
  /** Disclosed cap on intermediary costs (payment, FX, banking), in basis points. */
  thirdPartyCostBps: number
  expectedOutcomeHash: Hex
  costDisclosureHash: Hex | null
  /** Off-chain custody only: the payment provider that holds the money. */
  custodian: Address | null
  /** Fees intermediaries kept, as attested: on the way in (FundingRecorded) and out (Settlement). */
  fundingFees: string
  settlementFees: string
  createdAt: number
  expiredAt: number | null
}

/** Ways to order the needs list. `urgency` = soonest funding deadline first, then the largest funding gap. */
export const NEED_SORTS = ['urgency', 'gap', 'newest'] as const
export type NeedSort = (typeof NEED_SORTS)[number]

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

/**
 * DIRECT: a wallet donated stablecoin to the vault (gets a receipt NFT).
 * FIAT: a payment provider converted a bank or card payment and deposited it in the vault.
 * OFFCHAIN: a payment provider holds the money and recorded it by attestation (non-custodial need).
 * CONVERTED: another token (USDC bought with a card, ETH, an exchange withdrawal) was swapped on-chain into the
 *   vault token under the oracle bound, from a wallet or a deposit address.
 */
export type DonationKind = 'DIRECT' | 'FIAT' | 'OFFCHAIN' | 'CONVERTED'

/** What happened on-chain when a donation arrived in another token. */
export interface ConversionView {
  /** Token given; the zero address for ETH. */
  tokenIn: Address
  tokenInSymbol: string
  /** In `tokenIn` base units. */
  amountIn: string
  /** What the swap produced, in the vault token. */
  amountOut: string
  /** What the input was worth at Chainlink prices, in the vault token. */
  fairValue: string
  /** Fair value minus output, attributed to the donated part; counted against the need's cost cap. */
  conversionFee: string
  /** The wallet (direct path) or deposit address (forwarder) the conversion ran for. */
  via: Address
  viaDepositAddress: boolean
}

export interface DonationView {
  id: string
  needId: string
  kind: DonationKind
  donor: Address | null
  donorRefHash: Hex | null
  paymentRefHash: Hex | null
  /** Amount that counts toward the target (net of fees). */
  amount: string
  /** What the donor paid and what intermediaries kept, when a provider attested them. */
  gross: string | null
  fee: string | null
  currency: string | null
  receiptId: string | null
  attestationUID: Hex | null
  /** Set for CONVERTED donations. */
  conversion: ConversionView | null
  txHash: Hex
  timestamp: number
}

/** A tranche payout reconciled by a Settlement attestation: what reached the supplier and what fees took. */
export interface SettlementView {
  uid: Hex
  needId: string
  trancheIndex: number
  attester: Address
  gross: string
  fee: string
  net: string
  supplierRefHash: Hex
  fxRef: Hex
  txHash: Hex
  timestamp: number
}

export interface NeedDetail extends NeedSummary {
  tranches: TrancheView[]
  deliveries: DeliveryView[]
  donations: DonationView[]
  settlements: SettlementView[]
  impactReport: ImpactReportView | null
}

export type TimelineEventType =
  | 'NeedCreated'
  | 'NeedVerificationRecorded'
  | 'NeedVerified'
  | 'NeedStatusChanged'
  | 'NeedCancelled'
  | 'NeedExpired'
  | 'PartialFundingAccepted'
  | 'VerificationRevoked'
  | 'Donated'
  | 'DonatedOnBehalf'
  | 'DonatedConverted'
  | 'FundingRecorded'
  | 'FundingClosed'
  | 'TrancheReleasable'
  | 'TrancheReleased'
  | 'SettlementRecorded'
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
  logIndex: number
  timestamp: number
}

/**
 * A page of the global timeline, oldest first, for consumers that follow every need (the notifier, integrators).
 * `cursor` is "<blockNumber>:<logIndex>" of the last event; pass it back as `?after=` to continue.
 */
export interface TimelinePage {
  events: TimelineEvent[]
  cursor: string | null
}

/** A registered payment provider (BANK_PARTNER_ROLE): who can deposit fiat or hold off-chain custody. */
export interface ProviderView {
  address: Address
  active: boolean
  registeredAt: number
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

// ─── per-donation tracking (the proposal's "track this donation" link) ─────────

/**
 * The five stages a donor follows, as the proposal names them, each backed by on-chain evidence:
 * Verified = NeedVerified attestations reached the threshold; Funded = funding closed;
 * Settled = a tranche payout was reconciled by a Settlement attestation; Delivered = a delivery passed the
 * three-signal gate and its challenge window; ImpactConfirmed = the NGO's ImpactReport, chained to the last
 * verified delivery.
 */
export const DONOR_STAGES = ['Verified', 'Funded', 'Settled', 'Delivered', 'ImpactConfirmed'] as const
export type DonorStage = (typeof DONOR_STAGES)[number]

export interface DonorStageView {
  stage: DonorStage
  reached: boolean
  /** When the stage was reached (unix seconds). */
  at: number | null
  txHash: Hex | null
  attestationUID: Hex | null
  /**
   * A stage can be partly there: e.g. a tranche was released on-chain but its Settlement attestation has not
   * been filed yet. The UI shows this instead of pretending the stage is either done or not started.
   */
  pending: string | null
}

/** How a donation ended up, independent of the stage it reached. */
export type DonationOutcome = 'InProgress' | 'Completed' | 'Refundable' | 'Refunded' | 'Expired' | 'Cancelled'

/**
 * Tracking reference: a receipt id for wallet donations ("12"), the salted payment reference hash a payment
 * provider returned for bank and card donations ("0x…" 32 bytes), or a deposit address ("0x…" 20 bytes) for money
 * sent from an exchange. None of them identifies the donor.
 */
export type TrackingRefKind = 'receipt' | 'payment' | 'deposit'

export interface DonationTrack {
  ref: string
  refKind: TrackingRefKind
  donation: DonationView
  need: NeedSummary
  /** This donation's share of everything raised for the need, in basis points. */
  shareBps: number
  stages: DonorStageView[]
  currentStage: DonorStage | null
  outcome: DonationOutcome
  /** This donation's pro-rata slice of the tranches released so far. */
  releasedToNgo: string
  refunded: string
  tranches: DonorTrancheSlice[]
  deliveries: DeliveryView[]
  settlements: SettlementView[]
  impactReport: ImpactReportView | null
  /** Set when the reference is a deposit address: every sweep and refund it made. */
  deposit: DepositAddressView | null
  updatedAt: number
}

/** Classifies a tracking reference, or returns null when it is neither shape. */
export const trackingRefKind = (ref: string): TrackingRefKind | null => {
  if (/^[1-9][0-9]{0,18}$/.test(ref)) return 'receipt'
  if (/^0x[0-9a-fA-F]{64}$/.test(ref)) return 'payment'
  // A deposit address (DonationForwarder): the address itself is the tracking reference.
  if (/^0x[0-9a-fA-F]{40}$/.test(ref)) return 'deposit'
  return null
}

// ─── deposit addresses (v3) ───────────────────────────────────────────────────

/** A DonationForwarder: a deposit address for money sent from somewhere that cannot call a contract. */
export interface DepositAddressView {
  address: Address
  needId: string
  /** Wallet credited with the donations and their receipts; null when the deposit address holds the claim. */
  receiptTo: Address | null
  refundTo: Address | null
  /** Key that can direct refunds by EIP-712 signature (the donor's downloaded refund key). */
  refundSigner: Address | null
  salt: Hex
  deployedAt: number
  sweeps: DepositSweepView[]
  refunds: DepositRefundView[]
}

export interface DepositSweepView {
  tokenIn: Address
  amountIn: string
  converted: string
  fairValue: string
  deposited: string
  conversionFee: string
  txHash: Hex
  timestamp: number
}

export interface DepositRefundView {
  /** LEFTOVER: undonated funds sent back; VAULT: the vault refund of a cancelled or expired need. */
  kind: 'LEFTOVER' | 'VAULT'
  token: Address | null
  to: Address
  amount: string
  txHash: Hex
  timestamp: number
}
