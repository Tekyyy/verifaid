import type {
  DeliveryView,
  DepositAddressView,
  DonationTrack,
  DonationView,
  DonorStage,
  DonorStageView,
  DonorTrace,
  DonorTrancheSlice,
  ImpactSummary,
  NeedDetail,
  NeedSummary,
  PayeePaymentView,
  PayeeView,
  ProgramMembersResponse,
  ProviderView,
  SettlementView,
  SupplierDetail,
  SupplierView,
  TimelineEvent,
  TrancheView,
} from '@poa/shared'
import {
  categoryHash,
  categoryLabel,
  countryOf,
  DONOR_STAGES,
  depositRefHash,
  getDeployment,
  hasDeployment,
  regionLabel,
} from '@poa/shared'
import { type Address, getAddress, type Hex, keccak256, stringToHex } from 'viem'
import { network } from './config'
import type { NeedFilters, Result } from './indexer'

/**
 * Sample data shaped exactly like the indexer contract, used when `NEXT_PUBLIC_USE_FIXTURES=1`.
 * It exists so the UI can be exercised (and reviewed) while the Ponder indexer is not running; it is never
 * used as a silent fallback, because a dashboard that invents numbers is worse than one that says it is offline.
 */

const NGO = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address
const FIELD_AGENT = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address
const VERIFIER = '0x90F79bf6EB2c4f870365E785982E1f101E93b906' as Address
const DONOR = '0x976EA74026E726554dB657fA54763abd0C3a0aa9' as Address
const PROVIDER = '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955' as Address
/** The NGO's payout Safe: where its own disclosed share of a tranche goes. */
const NGO_PAYOUT = '0xBcd4042DE499D14e55001CcbB24a551F3b954096' as Address
const PROVIDER_RETIRED = '0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f' as Address
const VAULT_1 = '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707' as Address
const VAULT_2 = '0xa513E6E4b8f2a923D98304ec87F64353C4D5C853' as Address
const VAULT_4 = '0x8A791620dd6260079BF849Dc5567aDC3F2FdC318' as Address
const LEDGER_5 = '0x610178dA211FEF7D417bC0e6FeD39F05609AD788' as Address
const VAULT_6 = '0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e' as Address
const VAULT_7 = '0x0DCd1Bf9A1b36cE34237eEaFef220932846BCD82' as Address

const region = (code: string): Hex => stringToHex(code, { size: 32 })
const tx = (n: number): Hex => `0x${n.toString(16).padStart(64, 'a')}` as Hex
const uid = (n: number): Hex => `0x${n.toString(16).padStart(64, 'e')}` as Hex
const hashText = (text: string): Hex => keccak256(stringToHex(text))

/** The payment reference the sandbox checkout would return for the card donation to need #5. */
export const FIXTURE_PAYMENT_REF = hashText('fixture-payment-ref-need-5-card')

/** A deposit address that has swept euros into need #7, and one that is deployed but still waiting for funds. */
export const FIXTURE_DEPOSIT_ADDRESS = getAddress('0x5ce1a0de9f7b2c4d6e8f0a1b3c5d7e9f2a4b6c8d')
export const FIXTURE_WAITING_DEPOSIT_ADDRESS = getAddress('0x7a11ed5a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e')
const REFUND_SIGNER = getAddress('0x1f2e3d4c5b6a79880a1b2c3d4e5f60718293a4b5')

/** EURC as the bundled deployment knows it, so symbols resolve the way they would against the indexer. */
const EURC: Address =
  (hasDeployment(network) ? getDeployment(network).external.EURC : undefined) ??
  getAddress('0x808456652fdb597867f38412077a9182bf77359f')

interface Terms {
  custodyMode?: NeedSummary['custodyMode']
  custodian?: Address | null
  fundingDeadline?: number | null
  executionDeadline?: number | null
  minFundingBps?: number
  thirdPartyCostBps?: number
  fundingFees?: string
  settlementFees?: string
  totalRefunded?: string
  expiredAt?: number | null
}

const OPEN_STATUSES: NeedSummary['status'][] = ['Pending', 'Verified', 'Funding']

const summary = (
  id: string,
  category: string,
  regionText: string,
  target: string,
  donated: string,
  released: string,
  status: NeedSummary['status'],
  vault: Address | null,
  createdAt: number,
  terms: Terms = {},
): NeedSummary => {
  const costBps = terms.thirdPartyCostBps ?? 0
  return {
    id,
    ngo: NGO,
    ngoName: 'Aurora Relief',
    programId: '1',
    category: categoryHash(category),
    categoryLabel: categoryLabel(categoryHash(category)),
    regionCode: region(regionText),
    regionLabel: regionLabel(region(regionText)),
    country: countryOf(regionText),
    targetAmount: target,
    totalDonated: donated,
    totalReleased: released,
    totalRefunded: terms.totalRefunded ?? '0',
    fundingGap: OPEN_STATUSES.includes(status) ? (BigInt(target) - BigInt(donated)).toString() : '0',
    status,
    custodyMode: terms.custodyMode ?? 'OnChain',
    vault,
    metadataURI: `ipfs://demo/need-${id}.json`,
    verificationsRequired: 1,
    verificationCount: status === 'Pending' ? 0 : 1,
    fundingDeadline: terms.fundingDeadline ?? null,
    executionDeadline: terms.executionDeadline ?? null,
    minFundingBps: terms.minFundingBps ?? 10_000,
    thirdPartyCostBps: costBps,
    expectedOutcomeHash: hashText(`Expected outcome of need ${id}`),
    costDisclosureHash: costBps > 0 ? hashText(`Cost disclosure of need ${id}`) : null,
    custodian: terms.custodian ?? null,
    fundingFees: terms.fundingFees ?? '0',
    settlementFees: terms.settlementFees ?? '0',
    createdAt,
    expiredAt: terms.expiredAt ?? null,
  }
}

const NEEDS: NeedSummary[] = [
  summary(
    '1',
    'FOOD',
    'ES-CM',
    '12000000000',
    '12000000000',
    '3600000000',
    'InDelivery',
    VAULT_1,
    1_757_000_000,
    {
      fundingDeadline: 1_757_600_000,
      executionDeadline: 1_795_000_000,
      thirdPartyCostBps: 150,
      settlementFees: '18000000',
    },
  ),
  summary('2', 'WATER', 'ES-AN', '6000000000', '2400000000', '0', 'Funding', VAULT_2, 1_757_300_000, {
    fundingDeadline: 1_792_000_000,
    executionDeadline: 1_800_000_000,
    minFundingBps: 6000,
  }),
  summary('3', 'MEDICAL', 'MA-07', '9000000000', '0', '0', 'Pending', null, 1_757_600_000, {
    fundingDeadline: 1_794_000_000,
  }),
  summary(
    '4',
    'SHELTER',
    'ES-CM',
    '4000000000',
    '4000000000',
    '4000000000',
    'Completed',
    VAULT_4,
    1_756_100_000,
  ),
  summary('5', 'CASH', 'PT-11', '5000000000', '1450000000', '0', 'Funding', LEDGER_5, 1_758_000_000, {
    custodyMode: 'OffChain',
    custodian: PROVIDER,
    fundingDeadline: 1_791_000_000,
    executionDeadline: 1_799_000_000,
    minFundingBps: 8000,
    thirdPartyCostBps: 300,
    fundingFees: '7250000',
  }),
  summary('6', 'EDUCATION', 'ES-CM', '8000000000', '1200000000', '0', 'Expired', VAULT_6, 1_755_000_000, {
    fundingDeadline: 1_760_000_000,
    totalRefunded: '400000000',
    expiredAt: 1_760_010_000,
  }),
  summary('7', 'FOOD', 'MA-04', '3000000000', '2100000000', '0', 'Funding', VAULT_7, 1_770_000_000, {
    fundingDeadline: 1_890_000_000,
    executionDeadline: 1_900_000_000,
    minFundingBps: 7000,
    thirdPartyCostBps: 100,
    // The two conversion costs below, counted against the 1% cap.
    fundingFees: '810000',
  }),
]

const needAt = (index: number): NeedSummary => NEEDS[index] as NeedSummary

const tranche = (
  index: number,
  bps: number,
  amount: string,
  status: TrancheView['status'],
  deliveryId: string | null,
): TrancheView => ({
  index,
  bps,
  amount,
  status,
  deliveryId,
  releasedAt: status === 'Released' ? 1_757_100_000 + index * 3600 : null,
  releaseTxHash: status === 'Released' ? tx(10 + index) : null,
})

const DELIVERIES: DeliveryView[] = [
  {
    id: '1',
    needId: '1',
    trancheIndex: 1,
    fieldAgent: FIELD_AGENT,
    expectedRecipients: 120,
    confirmations: 97,
    confirmationRatio: 0.808,
    status: 'Challengeable',
    evidenceUID: uid(1),
    evidenceCID: 'bafybeigdyrztdemofoodkitdelivery0001',
    verifierUID: uid(2),
    verifier: VERIFIER,
    challengeDeadline: 1_757_900_000,
  },
  {
    id: '2',
    needId: '1',
    trancheIndex: 2,
    fieldAgent: FIELD_AGENT,
    expectedRecipients: 120,
    confirmations: 14,
    confirmationRatio: 0.117,
    status: 'Open',
    evidenceUID: uid(3),
    evidenceCID: 'bafybeigdyrztdemofoodkitdelivery0002',
    verifierUID: null,
    verifier: null,
    challengeDeadline: null,
  },
]

const SETTLEMENTS_1: SettlementView[] = [
  {
    uid: uid(42),
    needId: '1',
    trancheIndex: 0,
    attester: NGO,
    gross: '3600000000',
    fee: '18000000',
    net: '3582000000',
    supplierRefHash: hashText('INV-2025-0917 Harinas del Sur'),
    fxRef: hashText('EUR/EUR'),
    txHash: tx(15),
    timestamp: 1_757_150_000,
  },
]

const donation = (
  fields: Partial<DonationView> & Pick<DonationView, 'id' | 'needId' | 'kind' | 'amount'>,
) => ({
  donor: null,
  donorRefHash: null,
  paymentRefHash: null,
  gross: null,
  fee: null,
  currency: null,
  receiptId: null,
  attestationUID: null,
  conversion: null,
  txHash: tx(Number(fields.id)),
  timestamp: 1_757_010_000,
  ...fields,
})

const DONATIONS_1: DonationView[] = [
  donation({ id: '1', needId: '1', kind: 'DIRECT', donor: DONOR, amount: '9000000000', receiptId: '1' }),
  donation({
    id: '2',
    needId: '1',
    kind: 'FIAT',
    donorRefHash: uid(7),
    paymentRefHash: uid(8),
    amount: '3000000000',
    gross: '3000000000',
    fee: '0',
    currency: 'EUR',
    attestationUID: uid(9),
    timestamp: 1_757_020_000,
  }),
]

const DONATIONS_5: DonationView[] = [
  donation({
    id: '50',
    needId: '5',
    kind: 'OFFCHAIN',
    donorRefHash: uid(51),
    paymentRefHash: FIXTURE_PAYMENT_REF,
    amount: '492750000',
    gross: '500000000',
    fee: '7250000',
    currency: 'EUR',
    attestationUID: uid(52),
    timestamp: 1_758_100_000,
  }),
  donation({
    id: '53',
    needId: '5',
    kind: 'OFFCHAIN',
    donorRefHash: uid(54),
    paymentRefHash: uid(55),
    amount: '957250000',
    gross: '957250000',
    fee: '0',
    currency: 'EUR',
    attestationUID: uid(56),
    timestamp: 1_758_200_000,
  }),
]

const DONATIONS_6: DonationView[] = [
  donation({ id: '60', needId: '6', kind: 'DIRECT', donor: DONOR, amount: '800000000', receiptId: '7' }),
  donation({ id: '61', needId: '6', kind: 'DIRECT', donor: NGO, amount: '400000000', receiptId: '8' }),
]

/**
 * Need #7: 500 EURC converted from a wallet (worth 540 USDC at EUR/USD 1.08, 0.27 USDC conversion cost),
 * 1,000 EURC swept from a deposit address, and a direct USDC donation.
 */
const DONATIONS_7: DonationView[] = [
  donation({
    id: '70',
    needId: '7',
    kind: 'CONVERTED',
    donor: DONOR,
    amount: '539730000',
    receiptId: '9',
    conversion: {
      tokenIn: EURC,
      tokenInSymbol: 'EURC',
      amountIn: '500000000',
      amountOut: '539730000',
      fairValue: '540000000',
      conversionFee: '270000',
      via: DONOR,
      viaDepositAddress: false,
    },
    timestamp: 1_770_100_000,
  }),
  donation({
    id: '71',
    needId: '7',
    kind: 'CONVERTED',
    donorRefHash: depositRefHash(FIXTURE_DEPOSIT_ADDRESS),
    amount: '1079460000',
    conversion: {
      tokenIn: EURC,
      tokenInSymbol: 'EURC',
      amountIn: '1000000000',
      amountOut: '1079460000',
      fairValue: '1080000000',
      conversionFee: '540000',
      via: FIXTURE_DEPOSIT_ADDRESS,
      viaDepositAddress: true,
    },
    timestamp: 1_770_200_000,
  }),
  donation({ id: '72', needId: '7', kind: 'DIRECT', donor: NGO, amount: '480810000', receiptId: '10' }),
]

const DEPOSITS: Record<string, DepositAddressView> = {
  [FIXTURE_DEPOSIT_ADDRESS.toLowerCase()]: {
    address: FIXTURE_DEPOSIT_ADDRESS,
    needId: '7',
    receiptTo: null,
    refundTo: null,
    refundSigner: REFUND_SIGNER,
    salt: uid(73),
    deployedAt: 1_770_150_000,
    sweeps: [
      {
        tokenIn: EURC,
        amountIn: '1000000000',
        converted: '1079460000',
        fairValue: '1080000000',
        deposited: '1079460000',
        conversionFee: '540000',
        txHash: tx(71),
        timestamp: 1_770_200_000,
      },
    ],
    refunds: [],
  },
  [FIXTURE_WAITING_DEPOSIT_ADDRESS.toLowerCase()]: {
    address: FIXTURE_WAITING_DEPOSIT_ADDRESS,
    needId: '7',
    receiptTo: DONOR,
    refundTo: null,
    refundSigner: REFUND_SIGNER,
    salt: uid(74),
    deployedAt: 1_770_300_000,
    sweeps: [],
    refunds: [],
  },
}

/** Two vetted suppliers (SUPPLIER_ROLE) and one that was removed: what a vault may be told to pay. */
export const SUPPLIER_FOOD: Address = getAddress('0x9d4454b023096f34b160d6b654540c56a1f81688')
export const SUPPLIER_TRANSPORT: Address = getAddress('0x2b5ad5c4795c026514f8317c7a215e218dccd6cf')
const SUPPLIER_REMOVED: Address = getAddress('0x6813eb9362372eef6200f3b1dbc3f819671cba69')

/** Need #1's plan: food from one supplier, transport from another, and 10% of the pre-financing for the NGO. */
const PAYEES_1: PayeeView[] = [
  {
    index: 0,
    account: SUPPLIER_FOOD,
    label: 'Food parcels (Cooperativa La Vega)',
    refHash: uid(84),
    shareBps: [7000, 6000, 10_000],
    needShareBps: 7500,
    paid: '2520000000',
    held: '0',
  },
  {
    index: 1,
    account: SUPPLIER_TRANSPORT,
    label: 'Cold-chain transport (Transportes Aljarafe)',
    refHash: uid(85),
    shareBps: [2000, 4000, 0],
    needShareBps: 2200,
    paid: '720000000',
    held: '0',
  },
  {
    index: 2,
    account: null,
    label: 'Field team and logistics (the NGO itself)',
    refHash: uid(86),
    shareBps: [1000, 0, 0],
    needShareBps: 300,
    paid: '360000000',
    held: '0',
  },
]

/** The pre-financing tranche, split by that plan the moment it was released. */
const PAYMENTS_1: PayeePaymentView[] = [
  {
    needId: '1',
    trancheIndex: 0,
    payee: SUPPLIER_FOOD,
    payeeIndex: 0,
    toNgo: false,
    amount: '2520000000',
    held: false,
    txHash: tx(184),
    timestamp: 1_757_030_000,
  },
  {
    needId: '1',
    trancheIndex: 0,
    payee: SUPPLIER_TRANSPORT,
    payeeIndex: 1,
    toNgo: false,
    amount: '720000000',
    held: false,
    txHash: tx(184),
    timestamp: 1_757_030_000,
  },
  {
    needId: '1',
    trancheIndex: 0,
    payee: NGO_PAYOUT,
    payeeIndex: 2,
    toNgo: true,
    amount: '360000000',
    held: false,
    txHash: tx(184),
    timestamp: 1_757_030_000,
  },
]

const detail = (index: number, rest: Partial<NeedDetail>): NeedDetail => ({
  ...needAt(index),
  payees: [],
  payments: [],
  payeeChanges: [],
  tranches: [],
  deliveries: [],
  donations: [],
  settlements: [],
  impactReport: null,
  ...rest,
})

const DETAILS: Record<string, NeedDetail> = {
  '1': detail(0, {
    payees: PAYEES_1,
    payments: PAYMENTS_1,
    tranches: [
      tranche(0, 3000, '3600000000', 'Released', null),
      tranche(1, 4000, '4800000000', 'Releasable', '1'),
      tranche(2, 3000, '3600000000', 'Locked', null),
    ],
    deliveries: DELIVERIES,
    donations: DONATIONS_1,
    settlements: SETTLEMENTS_1,
  }),
  '2': detail(1, {
    tranches: [tranche(0, 5000, '0', 'Locked', null), tranche(1, 5000, '0', 'Locked', null)],
  }),
  '3': detail(2, {}),
  '4': detail(3, {
    tranches: [tranche(0, 10000, '4000000000', 'Released', null)],
    impactReport: {
      needId: '4',
      uid: uid(20),
      beneficiariesServed: 340,
      kpiHash: uid(21),
      reportCID: 'bafybeidemoimpactreport0004',
      revoked: false,
      timestamp: 1_756_900_000,
    },
  }),
  '5': detail(4, {
    tranches: [tranche(0, 2000, '0', 'Locked', null), tranche(1, 8000, '0', 'Locked', null)],
    donations: DONATIONS_5,
  }),
  '6': detail(5, {
    tranches: [tranche(0, 10000, '0', 'Locked', null)],
    donations: DONATIONS_6,
  }),
  '7': detail(6, {
    tranches: [tranche(0, 4000, '0', 'Locked', null), tranche(1, 6000, '0', 'Locked', null)],
    donations: DONATIONS_7,
  }),
}

const event = (
  needId: string,
  n: number,
  type: TimelineEvent['type'],
  data: TimelineEvent['data'],
  blockNumber: number,
  timestamp: number,
  attestationUID: Hex | null = null,
): TimelineEvent => ({
  id: `${needId}-${n}`,
  needId,
  type,
  data,
  attestationUID,
  txHash: tx(blockNumber),
  blockNumber,
  logIndex: n % 3,
  timestamp,
})

const TIMELINES: Record<string, TimelineEvent[]> = {
  '1': [
    event(
      '1',
      1,
      'NeedCreated',
      { ngo: NGO, targetAmount: '12000000000', category: 'FOOD' },
      150,
      1_757_000_000,
    ),
    event('1', 2, 'NeedVerified', { verifier: VERIFIER, approved: true }, 161, 1_757_004_000, uid(30)),
    event('1', 3, 'Donated', { donor: DONOR, amount: '9000000000', receiptId: '1' }, 178, 1_757_010_000),
    event('1', 4, 'DonatedOnBehalf', { amount: '3000000000', kind: 'FIAT' }, 180, 1_757_020_000, uid(9)),
    event('1', 5, 'FundingClosed', { totalDonated: '12000000000' }, 184, 1_757_030_000),
    event('1', 6, 'TrancheReleased', { index: 0, amount: '3600000000', to: NGO }, 190, 1_757_100_000),
    event(
      '1',
      7,
      'SettlementRecorded',
      { trancheIndex: 0, gross: '3600000000', fee: '18000000', net: '3582000000' },
      196,
      1_757_150_000,
      uid(42),
    ),
    event(
      '1',
      8,
      'DeliveryOpened',
      { deliveryId: '1', trancheIndex: 1, expectedRecipients: 120 },
      201,
      1_757_200_000,
    ),
    event(
      '1',
      9,
      'DeliveryEvidenceLinked',
      { deliveryId: '1', itemsDelivered: 120 },
      205,
      1_757_210_000,
      uid(1),
    ),
    event('1', 10, 'ReceiptConfirmed', { deliveryId: '1', confirmations: 97 }, 240, 1_757_300_000),
    event(
      '1',
      11,
      'DeliveryVerifiedLinked',
      { deliveryId: '1', verifier: VERIFIER, approved: true },
      250,
      1_757_400_000,
      uid(2),
    ),
    event(
      '1',
      12,
      'DeliveryChallengeable',
      { deliveryId: '1', challengeDeadline: 1_757_900_000 },
      250,
      1_757_400_000,
    ),
  ],
  '5': [
    event(
      '5',
      1,
      'NeedCreated',
      { ngo: NGO, targetAmount: '5000000000', category: 'CASH' },
      300,
      1_758_000_000,
    ),
    event('5', 2, 'NeedVerified', { verifier: VERIFIER, approved: true }, 305, 1_758_050_000, uid(57)),
    event(
      '5',
      3,
      'FundingRecorded',
      { provider: PROVIDER, gross: '500000000', fee: '7250000', net: '492750000', currency: 'EUR' },
      310,
      1_758_100_000,
      uid(52),
    ),
    event(
      '5',
      4,
      'FundingRecorded',
      { provider: PROVIDER, gross: '957250000', fee: '0', net: '957250000', currency: 'EUR' },
      320,
      1_758_200_000,
      uid(56),
    ),
  ],
  '6': [
    event(
      '6',
      1,
      'NeedCreated',
      { ngo: NGO, targetAmount: '8000000000', category: 'EDUCATION' },
      90,
      1_755_000_000,
    ),
    event('6', 2, 'NeedVerified', { verifier: VERIFIER, approved: true }, 95, 1_755_100_000, uid(61)),
    event('6', 3, 'Donated', { donor: DONOR, amount: '800000000', receiptId: '7' }, 100, 1_755_200_000),
    event('6', 4, 'Donated', { donor: NGO, amount: '400000000', receiptId: '8' }, 101, 1_755_300_000),
    event('6', 5, 'NeedExpired', { from: 'Funding', raised: '1200000000' }, 130, 1_760_010_000),
    event('6', 6, 'Refunded', { account: NGO, amount: '400000000' }, 131, 1_760_020_000),
  ],
  '7': [
    event(
      '7',
      1,
      'NeedCreated',
      { ngo: NGO, targetAmount: '3000000000', category: 'FOOD' },
      400,
      1_770_000_000,
    ),
    event('7', 2, 'NeedVerified', { verifier: VERIFIER, approved: true }, 405, 1_770_050_000, uid(75)),
    event(
      '7',
      3,
      'DonatedConverted',
      {
        donor: DONOR,
        depositAddress: null,
        tokenIn: EURC,
        tokenInSymbol: 'EURC',
        amountIn: '500000000',
        converted: '539730000',
        fairValue: '540000000',
        amount: '539730000',
        conversionFee: '270000',
        receiptId: '9',
      },
      410,
      1_770_100_000,
    ),
    event(
      '7',
      4,
      'DonatedConverted',
      {
        donor: null,
        depositAddress: FIXTURE_DEPOSIT_ADDRESS,
        tokenIn: EURC,
        tokenInSymbol: 'EURC',
        amountIn: '1000000000',
        converted: '1079460000',
        fairValue: '1080000000',
        amount: '1079460000',
        conversionFee: '540000',
        receiptId: null,
      },
      420,
      1_770_200_000,
    ),
    event('7', 5, 'Donated', { donor: NGO, amount: '480810000', receiptId: '10' }, 425, 1_770_250_000),
  ],
}

export const impactSummary: ImpactSummary = {
  totals: {
    needs: NEEDS.length,
    needsCompleted: 1,
    donated: '24150000000',
    released: '7600000000',
    refunded: '400000000',
    deliveriesFinalized: 1,
    confirmations: 111,
    beneficiariesServed: 340,
  },
  byCategory: [
    {
      key: categoryHash('FOOD'),
      label: 'FOOD',
      needs: 2,
      donated: '14100000000',
      released: '3600000000',
      deliveriesFinalized: 1,
      beneficiariesServed: 0,
    },
    {
      key: categoryHash('WATER'),
      label: 'WATER',
      needs: 1,
      donated: '2400000000',
      released: '0',
      deliveriesFinalized: 0,
      beneficiariesServed: 0,
    },
    {
      key: categoryHash('SHELTER'),
      label: 'SHELTER',
      needs: 1,
      donated: '4000000000',
      released: '4000000000',
      deliveriesFinalized: 0,
      beneficiariesServed: 340,
    },
    {
      key: categoryHash('CASH'),
      label: 'CASH',
      needs: 1,
      donated: '1450000000',
      released: '0',
      deliveriesFinalized: 0,
      beneficiariesServed: 0,
    },
    {
      key: categoryHash('EDUCATION'),
      label: 'EDUCATION',
      needs: 1,
      donated: '1200000000',
      released: '0',
      deliveriesFinalized: 0,
      beneficiariesServed: 0,
    },
    {
      key: categoryHash('MEDICAL'),
      label: 'MEDICAL',
      needs: 1,
      donated: '0',
      released: '0',
      deliveriesFinalized: 0,
      beneficiariesServed: 0,
    },
  ],
  byRegion: [
    {
      key: region('ES-CM'),
      label: 'ES-CM',
      needs: 3,
      donated: '17200000000',
      released: '7600000000',
      deliveriesFinalized: 1,
      beneficiariesServed: 340,
    },
    {
      key: region('ES-AN'),
      label: 'ES-AN',
      needs: 1,
      donated: '2400000000',
      released: '0',
      deliveriesFinalized: 0,
      beneficiariesServed: 0,
    },
    {
      key: region('PT-11'),
      label: 'PT-11',
      needs: 1,
      donated: '1450000000',
      released: '0',
      deliveriesFinalized: 0,
      beneficiariesServed: 0,
    },
    {
      key: region('MA-04'),
      label: 'MA-04',
      needs: 1,
      donated: '2100000000',
      released: '0',
      deliveriesFinalized: 0,
      beneficiariesServed: 0,
    },
    {
      key: region('MA-07'),
      label: 'MA-07',
      needs: 1,
      donated: '0',
      released: '0',
      deliveriesFinalized: 0,
      beneficiariesServed: 0,
    },
  ],
}

/** 8 demo commitments: enough to exceed the minimum group size without bloating the page. */
const MEMBERS = [
  '10175086346684478871242894262760765330219553131134272132849394069158901073404',
  '4996230331519012424958163671242168851089531285172473301335738471387923444195',
  '11720748509993441551243276848549069024102172026275707413400163767677427364135',
  '17544178556213330729537477829200478324434021760066274006936651131872246566748',
  '9216651255216313236112317200612116244146651266118120304115271139206175371224',
  '13004168302921100416100219116020011291141026019206200510041501610260140118201',
  '2059817360421012011730120411300119210410730160110011021041111602061103001191',
  '18446744073709551616123456789012345678901234567890123456789012345678901234567',
]

const isOpen = (need: NeedSummary, now: number): boolean =>
  need.status === 'Funding' &&
  (need.fundingDeadline === null || need.fundingDeadline > now) &&
  (need.executionDeadline === null || need.executionDeadline > now)

const byGapDesc = (a: NeedSummary, b: NeedSummary): number => {
  const diff = BigInt(b.fundingGap) - BigInt(a.fundingGap)
  return diff > 0n ? 1 : diff < 0n ? -1 : 0
}

const SORTS: Record<NonNullable<NeedFilters['sort']>, (a: NeedSummary, b: NeedSummary) => number> = {
  urgency: (a, b) =>
    (a.fundingDeadline ?? Number.POSITIVE_INFINITY) - (b.fundingDeadline ?? Number.POSITIVE_INFINITY) ||
    byGapDesc(a, b),
  gap: byGapDesc,
  newest: (a, b) => b.createdAt - a.createdAt,
}

export const filterNeeds = (filters: NeedFilters): NeedSummary[] => {
  const now = Math.floor(Date.now() / 1000)
  const matches = NEEDS.filter(
    (need) =>
      (!filters.status || need.status === filters.status) &&
      (!filters.category || need.category === filters.category || need.categoryLabel === filters.category) &&
      (!filters.region || need.regionCode === filters.region || need.regionLabel === filters.region) &&
      (!filters.country || need.country === filters.country.toUpperCase()) &&
      (!filters.custody || need.custodyMode === filters.custody) &&
      (!filters.open || isOpen(need, now)),
  )
  return filters.sort ? [...matches].sort(SORTS[filters.sort]) : matches
}

const notFound = { ok: false, error: { kind: 'http', status: 404, detail: 'Not found' } } as const

export const needDetail = (id: string): Result<NeedDetail> => {
  const found = DETAILS[id]
  return found ? { ok: true, data: found } : notFound
}

export const timeline = (id: string): TimelineEvent[] => TIMELINES[id] ?? []

export const filterDeliveries = (status?: string): DeliveryView[] =>
  status ? DELIVERIES.filter((delivery) => delivery.status === status) : DELIVERIES

const withDonorShare = (tranches: TrancheView[], shareBps: number): DonorTrancheSlice[] =>
  tranches.map((item) => ({
    ...item,
    donorShare: ((BigInt(item.amount) * BigInt(shareBps)) / 10_000n).toString(),
  }))

/** This demo donor funded 75% of need #1, so every slice is 7500 bps of the full tranche. */
const DONOR_SHARE_BPS = 7500

export const donorTrace = (address: string): DonorTrace => ({
  donor: address as Address,
  totalDonated: '9800000000',
  receipts: [
    {
      receiptId: '1',
      needId: '1',
      needStatus: 'InDelivery',
      category: categoryHash('FOOD'),
      regionCode: region('ES-CM'),
      amount: '9000000000',
      shareBps: DONOR_SHARE_BPS,
      releasedToNgo: '2700000000',
      refunded: '0',
      tranches: withDonorShare(DETAILS['1']?.tranches ?? [], DONOR_SHARE_BPS),
      deliveries: DELIVERIES,
    },
    {
      receiptId: '7',
      needId: '6',
      needStatus: 'Expired',
      category: categoryHash('EDUCATION'),
      regionCode: region('ES-CM'),
      amount: '800000000',
      shareBps: 6666,
      releasedToNgo: '0',
      refunded: '0',
      tranches: withDonorShare(DETAILS['6']?.tranches ?? [], 6666),
      deliveries: [],
    },
  ],
})

export const programMembers = (programId: string): Result<ProgramMembersResponse> => ({
  ok: true,
  data: { programId, groupId: '0', memberCount: MEMBERS.length, members: MEMBERS, merkleTreeDepth: 3 },
})

export const suppliers: SupplierView[] = [
  {
    address: SUPPLIER_FOOD,
    credentialHash: uid(81),
    metadataURI: 'ipfs://bafybeidemosupplierfood',
    active: true,
    registeredAt: 1_756_100_000,
    totalPaid: '2520000000',
    needIds: ['1'],
  },
  {
    address: SUPPLIER_TRANSPORT,
    credentialHash: uid(82),
    metadataURI: 'ipfs://bafybeidemosuppliertransport',
    active: true,
    registeredAt: 1_756_200_000,
    totalPaid: '720000000',
    needIds: ['1'],
  },
  {
    address: SUPPLIER_REMOVED,
    credentialHash: uid(83),
    metadataURI: 'ipfs://bafybeidemosupplierremoved',
    active: false,
    registeredAt: 1_755_000_000,
    totalPaid: '0',
    needIds: [],
  },
]

export const supplier = (address: string): Result<SupplierDetail> => {
  const row = suppliers.find((item) => item.address.toLowerCase() === address.toLowerCase())
  if (!row) return notFound
  return {
    ok: true,
    data: { ...row, payments: PAYMENTS_1.filter((payment) => payment.payee === row.address) },
  }
}

export const providers: ProviderView[] = [
  { address: PROVIDER, active: true, registeredAt: 1_756_000_000 },
  { address: PROVIDER_RETIRED, active: false, registeredAt: 1_755_000_000 },
]

const stages = (reached: Partial<Record<DonorStage, Omit<DonorStageView, 'stage'>>>): DonorStageView[] =>
  DONOR_STAGES.map(
    (stage) =>
      ({
        stage,
        reached: false,
        at: null,
        txHash: null,
        attestationUID: null,
        pending: null,
        ...reached[stage],
      }) satisfies DonorStageView,
  )

const reachedAt = (at: number, txHash: Hex, attestationUID: Hex | null = null) => ({
  reached: true,
  at,
  txHash,
  attestationUID,
  pending: null,
})

const TRACKS: Record<string, DonationTrack> = {
  '1': {
    ref: '1',
    refKind: 'receipt',
    donation: DONATIONS_1[0] as DonationView,
    need: needAt(0),
    shareBps: DONOR_SHARE_BPS,
    stages: stages({
      Verified: reachedAt(1_757_004_000, tx(161), uid(30)),
      Funded: reachedAt(1_757_030_000, tx(184)),
      Settled: reachedAt(1_757_150_000, tx(196), uid(42)),
      Delivered: {
        reached: false,
        at: null,
        txHash: null,
        attestationUID: null,
        pending: 'Delivery #1 was verified and is in its challenge window until 2025-09-15 01:33 UTC.',
      },
    }),
    currentStage: 'Settled',
    outcome: 'InProgress',
    releasedToNgo: '2700000000',
    refunded: '0',
    tranches: withDonorShare(DETAILS['1']?.tranches ?? [], DONOR_SHARE_BPS),
    deliveries: DELIVERIES,
    settlements: SETTLEMENTS_1,
    impactReport: null,
    deposit: null,
    payees: PAYEES_1,
    updatedAt: 1_757_400_000,
  },
  [FIXTURE_PAYMENT_REF.toLowerCase()]: {
    ref: FIXTURE_PAYMENT_REF,
    refKind: 'payment',
    donation: DONATIONS_5[0] as DonationView,
    need: needAt(4),
    shareBps: 3398,
    stages: stages({
      Verified: reachedAt(1_758_050_000, tx(305), uid(57)),
      Funded: {
        reached: false,
        at: null,
        txHash: null,
        attestationUID: null,
        pending: '1,450.00 of 5,000.00 raised; funding closes when the target or the deadline is reached.',
      },
    }),
    currentStage: 'Verified',
    outcome: 'InProgress',
    releasedToNgo: '0',
    refunded: '0',
    tranches: withDonorShare(DETAILS['5']?.tranches ?? [], 3398),
    deliveries: [],
    settlements: [],
    impactReport: null,
    deposit: null,
    payees: [],
    updatedAt: 1_758_200_000,
  },
  '7': {
    ref: '7',
    refKind: 'receipt',
    donation: DONATIONS_6[0] as DonationView,
    need: needAt(5),
    shareBps: 6666,
    stages: stages({ Verified: reachedAt(1_755_100_000, tx(95), uid(61)) }),
    currentStage: 'Verified',
    outcome: 'Refundable',
    releasedToNgo: '0',
    refunded: '0',
    tranches: withDonorShare(DETAILS['6']?.tranches ?? [], 6666),
    deliveries: [],
    settlements: [],
    impactReport: null,
    deposit: null,
    payees: [],
    updatedAt: 1_760_010_000,
  },
  [FIXTURE_DEPOSIT_ADDRESS.toLowerCase()]: {
    ref: FIXTURE_DEPOSIT_ADDRESS,
    refKind: 'deposit',
    donation: DONATIONS_7[1] as DonationView,
    need: needAt(6),
    shareBps: 5140,
    stages: stages({ Verified: reachedAt(1_770_050_000, tx(405), uid(75)) }),
    currentStage: 'Verified',
    outcome: 'InProgress',
    releasedToNgo: '0',
    refunded: '0',
    tranches: withDonorShare(DETAILS['7']?.tranches ?? [], 5140),
    deliveries: [],
    settlements: [],
    impactReport: null,
    deposit: DEPOSITS[FIXTURE_DEPOSIT_ADDRESS.toLowerCase()] ?? null,
    payees: [],
    updatedAt: 1_770_250_000,
  },
}

export const depositAddress = (address: string): Result<DepositAddressView> => {
  const found = DEPOSITS[address.toLowerCase()]
  return found ? { ok: true, data: found } : notFound
}

export const donationTrack = (ref: string): Result<DonationTrack> => {
  const found = TRACKS[ref.toLowerCase()]
  return found ? { ok: true, data: found } : notFound
}
