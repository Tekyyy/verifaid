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
  /** ISO 3166-1 alpha-2 country, the prefix of the ISO 3166-2 region ("ES-CM" → "ES"). */
  country: string
  targetAmount: string
  totalDonated: string
  totalReleased: string
  totalRefunded: string
  /** `targetAmount - totalDonated` while funding is open, "0" afterwards. */
  fundingGap: string
  /**
   * What a need does with money it cannot spend yet. `null` on every need whose NGO did not opt in, which is
   * the default and, on a need created before the venue existed, the only possibility.
   */
  idleCapital: IdleCapitalView | null
  status: NeedStatus
  vault: Address | null
  metadataURI: string
  verificationsRequired: number
  verificationCount: number
  /** Unix seconds; null when open-ended. */
  fundingDeadline: number | null
  executionDeadline: number | null
  /** Share of the target that must be raised for the need to go ahead (10000 = all or nothing). */
  minFundingBps: number
  /** Disclosed cap on intermediary costs (conversions, payouts), in basis points. */
  thirdPartyCostBps: number
  expectedOutcomeHash: Hex
  costDisclosureHash: Hex | null
  /** What intermediaries kept: conversions on the way in, and Settlement-attested fees on the way out. */
  fundingFees: string
  settlementFees: string
  createdAt: number
  expiredAt: number | null
  /** Public record of the organisation behind it; see `NeedBadges`. */
  badges: NeedBadges
  /** What the NGO published to present it, or null while it has published nothing. */
  presentation: NeedPresentationView | null
  /** The tax standing of the organisation behind it, as claimed and (maybe) checked. */
  taxStatus: OrgTaxStatusView | null
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
 * CONVERTED: another token (USDC bought with a card, ETH, an exchange withdrawal) was swapped on-chain into the
 *   vault token under the oracle bound, from a wallet or a deposit address.
 */
export type DonationKind = 'DIRECT' | 'CONVERTED'

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
  /** Taken back by the donor while the need was still raising; `amount` is already net of it. */
  withdrawn: string
  id: string
  needId: string
  kind: DonationKind
  donor: Address | null
  /** Set when a deposit address holds the claim itself (the donor gave no wallet). */
  donorRefHash: Hex | null
  /** Amount that counts toward the target (net of conversion costs). */
  amount: string
  receiptId: string | null
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
  /** v4 payment plan (on-chain custody): who the vault pays directly. Empty for off-chain custody. */
  payees: PayeeView[]
  /** Every payment the vault made (or held) to a payee, oldest first. */
  payments: PayeePaymentView[]
  /** Supplier replacements proposed by the NGO, newest first. */
  payeeChanges: PayeeChangeView[]
  /** Photos of the work, published by this need's NGO, newest first. */
  photos: WorkPhotoView[]
}

// ─── payment plans (v4) ───────────────────────────────────────────────────────

/** A registered supplier (SUPPLIER_ROLE): a vetted service provider that vaults may pay directly. */
export interface SupplierView {
  address: Address
  credentialHash: Hex
  /** Public profile JSON (legal name, country, what it supplies). */
  metadataURI: string
  active: boolean
  registeredAt: number
  /** Everything vaults have paid it so far, across needs (vault token base units). */
  totalPaid: string
  /** Needs whose payment plan names it (currently or before a replacement). */
  needIds: string[]
}

/** One payee of a need's payment plan and what the vault has paid it so far. */
export interface PayeeView {
  index: number
  /** Null for the NGO's own share, which goes to its payout Safe. */
  account: Address | null
  /** Public name of the payee and what it provides, as the NGO committed it. */
  label: string
  /** Hash of the contract or quote agreed with this payee. */
  refHash: Hex
  /** Share of each tranche in basis points, aligned with the need's tranches. */
  shareBps: number[]
  /** Share of the whole need in basis points: Σ tranche bps × share / 10 000. */
  needShareBps: number
  paid: string
  /** Released to it but refused by the token (a frozen address); claimable once it can receive. */
  held: string
}

/** One payment out of a vault to a payee, or a payment held because the token refused it. */
export interface PayeePaymentView {
  needId: string
  trancheIndex: number
  payee: Address
  /** Position in the payment plan; null when the payee is not in the plan any more. */
  payeeIndex: number | null
  /** True for the NGO's own share. */
  toNgo: boolean
  amount: string
  held: boolean
  txHash: Hex
  timestamp: number
}

/** A supplier and every payment vaults made to it. */
export interface SupplierDetail extends SupplierView {
  payments: PayeePaymentView[]
}

/**
 * An organisation's tax standing. `verified` means the platform admin signed an attestation saying they
 * checked the claim against the register named in `verifiedSource` — never that this system can tell whether a
 * donation is deductible, which depends on the donor as much as on the organisation.
 */
export interface OrgTaxStatusView {
  org: Address
  /** ISO 3166-1 alpha-2 of the tax authority, e.g. "US". */
  jurisdiction: string
  /** The organisation's public registration number (an EIN for a US 501(c)(3)). Never a donor's. */
  taxId: string
  legalName: string
  source: string
  claimedAt: number
  verified: boolean
  verifiedBy: Address | null
  verifiedSource: string | null
  verifiedAt: number | null
}

/** The donee's signed acknowledgment of one donation, which a donor's receipt document cites. */
export interface DonationAcknowledgmentView {
  receiptId: string
  needId: string
  ngo: Address
  documentHash: Hex
  statement: string
  uid: Hex
  timestamp: number
  txHash: Hex
}

/** How an NGO chose to present a need: a cover image, more images, a summary and a few tags. */
export interface NeedPresentationView {
  coverImage: string
  gallery: string[]
  summary: string
  tags: string[]
  uid: Hex
  timestamp: number
}

/** Photos of finished work an NGO published for one of its needs. */
export interface WorkPhotoView {
  uid: Hex
  needId: string
  photos: string[]
  note: string
  timestamp: number
  txHash: Hex
}

/** A supplier that asked to be registered. An admin still has to grant the role. */
export interface SupplierApplicationView {
  uid: Hex
  supplier: Address
  name: string
  services: string
  uri: string
  credentialHash: Hex
  /** True once the admin granted SUPPLIER_ROLE to this address. */
  registered: boolean
  timestamp: number
  txHash: Hex
}

/**
 * What a need's card can say about the organisation behind it, computed from what actually happened on chain:
 * whether it publishes photos of the work, and whether the money it released reached the payees its plans
 * named. Both are facts, not reputation — nobody awards them.
 */
export interface NeedBadges {
  /** Live (non-revoked) work-photo attestations the need's own NGO published for it. */
  workPhotos: number
  /**
   * Share of everything this NGO ever released that reached a payee, in basis points; null before it has
   * released anything. Below 10000 means a payment is still held because a token refused it.
   */
  payoutAccuracyBps: number | null
  /** Needs of this NGO that reached Completed, and how many it has run in total. */
  needsCompleted: number
  needsTotal: number
}

/** One NGO programme: a Semaphore group, the hash of its published eligibility rules and who is enrolled. */
export interface ProgramView {
  id: string
  ngo: Address
  groupId: string
  enrollmentPolicyHash: Hex
  metadataURI: string
  /** Beneficiaries currently enrolled: the ceiling on a delivery's expected recipients. */
  memberCount: number
  active: boolean
  createdAt: number
}

/** `NeedsRegistry.MIN_PAYEE_CHANGE_APPROVALS`: moving an escrow to another supplier always takes two verifiers. */
export const MIN_PAYEE_CHANGE_APPROVALS = 2

/** Mirrors `NeedsRegistry.payeeChangeApprovalsRequired`: the need's own threshold, but never fewer than two. */
export const payeeChangeApprovalsRequired = (verificationsRequired: number): number =>
  Math.max(verificationsRequired, MIN_PAYEE_CHANGE_APPROVALS)

export type PayeeChangeStatus = 'PENDING' | 'APPLIED' | 'CANCELLED'

/** A supplier replacement: proposed by the NGO, applied after enough independent verifiers approve it. */
export interface PayeeChangeView {
  changeId: string
  index: number
  from: Address
  to: Address
  label: string
  refHash: Hex
  approvals: number
  approvalsRequired: number
  approvedBy: Address[]
  status: PayeeChangeStatus
  proposedAt: number
  resolvedAt: number | null
}

/**
 * Committed money waiting in an ERC-4626 venue. Principal is stated at cost — what the vault put in — never as
 * a share price, and `earned` counts only what has actually come home. A donor is repaid `principal`, never a
 * slice of `earned`: the earnings belong to the need, and `lost` is charged against them before anyone is paid.
 */
export interface IdleCapitalView {
  /** The venue it is waiting in, or null when nothing is lent right now. */
  venue: Address | null
  /** Lent out at this moment, at cost. */
  deployed: string
  /** Realised and brought back into the vault, and the part already handed to the NGO. */
  earned: string
  paidOut: string
  /** Principal a venue did not return. */
  lost: string
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
  | 'DonatedConverted'
  | 'FundingClosed'
  | 'TrancheReleasable'
  | 'TrancheReleased'
  | 'SettlementRecorded'
  | 'Refunded'
  | 'YieldEnabled'
  | 'IdleDeployed'
  | 'IdleUnwound'
  | 'YieldHarvested'
  | 'YieldPaid'
  | 'SleeveLoss'
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
  | 'PayeePaid'
  | 'PaymentHeld'
  | 'HeldPaymentClaimed'
  | 'PayeeChangeProposed'
  | 'PayeeChangeApproved'
  | 'PayeeChanged'
  | 'PayeeChangeCancelled'
  | 'WorkPhotosPublished'
  | 'NeedPresentationPublished'
  | 'DonationAcknowledged'
  | 'DonationWithdrawn'

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
 * Tracking reference: a receipt id for wallet donations ("12"), card ones included, or a deposit address ("0x…"
 * 20 bytes) for money sent from an exchange. Neither identifies the donor.
 */
export type TrackingRefKind = 'receipt' | 'deposit'

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
  /** Who the vault pays and what each has received; this donation's part of each is `paid × shareBps / 10 000`. */
  payees: PayeeView[]
  /** The donee's signed acknowledgment of this donation, once it has made one. */
  acknowledgment: DonationAcknowledgmentView | null
  updatedAt: number
}

/** Classifies a tracking reference, or returns null when it is neither shape. */
export const trackingRefKind = (ref: string): TrackingRefKind | null => {
  if (/^[1-9][0-9]{0,18}$/.test(ref)) return 'receipt'
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
