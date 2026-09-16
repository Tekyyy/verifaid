import type {
  DeliveryView,
  DonorTrace,
  DonorTrancheSlice,
  ImpactSummary,
  NeedDetail,
  NeedSummary,
  ProgramMembersResponse,
  TimelineEvent,
  TrancheView,
} from '@poa/shared'
import { categoryHash, categoryLabel, regionLabel } from '@poa/shared'
import { type Address, type Hex, stringToHex } from 'viem'
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
const VAULT_1 = '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707' as Address
const VAULT_2 = '0xa513E6E4b8f2a923D98304ec87F64353C4D5C853' as Address

const region = (code: string): Hex => stringToHex(code, { size: 32 })
const tx = (n: number): Hex => `0x${n.toString(16).padStart(64, 'a')}` as Hex
const uid = (n: number): Hex => `0x${n.toString(16).padStart(64, 'e')}` as Hex

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
): NeedSummary => ({
  id,
  ngo: NGO,
  ngoName: 'Aurora Relief',
  programId: '1',
  category: categoryHash(category),
  categoryLabel: categoryLabel(categoryHash(category)),
  regionCode: region(regionText),
  regionLabel: regionLabel(region(regionText)),
  targetAmount: target,
  totalDonated: donated,
  totalReleased: released,
  status,
  vault,
  metadataURI: `ipfs://demo/need-${id}.json`,
  verificationsRequired: 1,
  verificationCount: status === 'Pending' ? 0 : 1,
  createdAt,
})

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
  ),
  summary('2', 'WATER', 'ES-AN', '6000000000', '2400000000', '0', 'Funding', VAULT_2, 1_757_300_000),
  summary('3', 'MEDICAL', 'MA-07', '9000000000', '0', '0', 'Pending', null, 1_757_600_000),
  summary(
    '4',
    'SHELTER',
    'ES-CM',
    '4000000000',
    '4000000000',
    '4000000000',
    'Completed',
    VAULT_1,
    1_756_100_000,
  ),
]

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

const DETAILS: Record<string, NeedDetail> = {
  '1': {
    ...(NEEDS[0] as NeedSummary),
    tranches: [
      tranche(0, 3000, '3600000000', 'Released', null),
      tranche(1, 4000, '4800000000', 'Releasable', '1'),
      tranche(2, 3000, '3600000000', 'Locked', null),
    ],
    deliveries: DELIVERIES,
    donations: [
      {
        id: '1',
        needId: '1',
        kind: 'DIRECT',
        donor: DONOR,
        donorRefHash: null,
        paymentRefHash: null,
        amount: '9000000000',
        receiptId: '1',
        attestationUID: null,
        txHash: tx(1),
        timestamp: 1_757_010_000,
      },
      {
        id: '2',
        needId: '1',
        kind: 'FIAT',
        donor: null,
        donorRefHash: uid(7),
        paymentRefHash: uid(8),
        amount: '3000000000',
        receiptId: null,
        attestationUID: uid(9),
        txHash: tx(2),
        timestamp: 1_757_020_000,
      },
    ],
    impactReport: null,
  },
  '2': {
    ...(NEEDS[1] as NeedSummary),
    tranches: [tranche(0, 5000, '0', 'Locked', null), tranche(1, 5000, '0', 'Locked', null)],
    deliveries: [],
    donations: [],
    impactReport: null,
  },
  '3': {
    ...(NEEDS[2] as NeedSummary),
    tranches: [],
    deliveries: [],
    donations: [],
    impactReport: null,
  },
  '4': {
    ...(NEEDS[3] as NeedSummary),
    tranches: [tranche(0, 10000, '4000000000', 'Released', null)],
    deliveries: [],
    donations: [],
    impactReport: {
      needId: '4',
      uid: uid(20),
      beneficiariesServed: 340,
      kpiHash: uid(21),
      reportCID: 'bafybeidemoimpactreport0004',
      revoked: false,
      timestamp: 1_756_900_000,
    },
  },
}

const TIMELINES: Record<string, TimelineEvent[]> = {
  '1': [
    {
      id: '1-1',
      needId: '1',
      type: 'NeedCreated',
      data: { ngo: NGO, targetAmount: '12000000000', category: 'FOOD' },
      attestationUID: null,
      txHash: tx(1),
      blockNumber: 150,
      timestamp: 1_757_000_000,
    },
    {
      id: '1-2',
      needId: '1',
      type: 'NeedVerified',
      data: { verifier: VERIFIER, approved: true },
      attestationUID: uid(30),
      txHash: tx(3),
      blockNumber: 161,
      timestamp: 1_757_004_000,
    },
    {
      id: '1-3',
      needId: '1',
      type: 'Donated',
      data: { donor: DONOR, amount: '9000000000', receiptId: '1' },
      attestationUID: null,
      txHash: tx(4),
      blockNumber: 178,
      timestamp: 1_757_010_000,
    },
    {
      id: '1-4',
      needId: '1',
      type: 'DonatedOnBehalf',
      data: { amount: '3000000000', kind: 'FIAT' },
      attestationUID: uid(9),
      txHash: tx(5),
      blockNumber: 180,
      timestamp: 1_757_020_000,
    },
    {
      id: '1-5',
      needId: '1',
      type: 'FundingClosed',
      data: { totalDonated: '12000000000' },
      attestationUID: null,
      txHash: tx(6),
      blockNumber: 184,
      timestamp: 1_757_030_000,
    },
    {
      id: '1-6',
      needId: '1',
      type: 'TrancheReleased',
      data: { index: 0, amount: '3600000000', to: NGO },
      attestationUID: null,
      txHash: tx(10),
      blockNumber: 190,
      timestamp: 1_757_100_000,
    },
    {
      id: '1-7',
      needId: '1',
      type: 'DeliveryOpened',
      data: { deliveryId: '1', trancheIndex: 1, expectedRecipients: 120 },
      attestationUID: null,
      txHash: tx(11),
      blockNumber: 201,
      timestamp: 1_757_200_000,
    },
    {
      id: '1-8',
      needId: '1',
      type: 'DeliveryEvidenceLinked',
      data: { deliveryId: '1', itemsDelivered: 120 },
      attestationUID: uid(1),
      txHash: tx(12),
      blockNumber: 205,
      timestamp: 1_757_210_000,
    },
    {
      id: '1-9',
      needId: '1',
      type: 'ReceiptConfirmed',
      data: { deliveryId: '1', confirmations: 97 },
      attestationUID: null,
      txHash: tx(13),
      blockNumber: 240,
      timestamp: 1_757_300_000,
    },
    {
      id: '1-10',
      needId: '1',
      type: 'DeliveryVerifiedLinked',
      data: { deliveryId: '1', verifier: VERIFIER, approved: true },
      attestationUID: uid(2),
      txHash: tx(14),
      blockNumber: 250,
      timestamp: 1_757_400_000,
    },
    {
      id: '1-11',
      needId: '1',
      type: 'DeliveryChallengeable',
      data: { deliveryId: '1', challengeDeadline: 1_757_900_000 },
      attestationUID: null,
      txHash: tx(14),
      blockNumber: 250,
      timestamp: 1_757_400_000,
    },
  ],
}

export const impactSummary: ImpactSummary = {
  totals: {
    needs: 4,
    needsCompleted: 1,
    donated: '18400000000',
    released: '7600000000',
    refunded: '0',
    deliveriesFinalized: 1,
    confirmations: 111,
    beneficiariesServed: 340,
  },
  byCategory: [
    {
      key: categoryHash('FOOD'),
      label: 'FOOD',
      needs: 1,
      donated: '12000000000',
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
      needs: 2,
      donated: '16000000000',
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

export const filterNeeds = (filters: NeedFilters): NeedSummary[] =>
  NEEDS.filter(
    (need) =>
      (!filters.status || need.status === filters.status) &&
      (!filters.category || need.category === filters.category || need.categoryLabel === filters.category) &&
      (!filters.region || need.regionCode === filters.region || need.regionLabel === filters.region),
  )

export const needDetail = (id: string): Result<NeedDetail> => {
  const detail = DETAILS[id]
  return detail
    ? { ok: true, data: detail }
    : { ok: false, error: { kind: 'http', status: 404, detail: 'Not found' } }
}

export const timeline = (id: string): TimelineEvent[] => TIMELINES[id] ?? []

export const filterDeliveries = (status?: string): DeliveryView[] =>
  status ? DELIVERIES.filter((delivery) => delivery.status === status) : DELIVERIES

/** This demo donor funded 75% of need #1, so every slice is 7500 bps of the full tranche. */
const DONOR_SHARE_BPS = 7500n

const withDonorShare = (tranches: TrancheView[]): DonorTrancheSlice[] =>
  tranches.map((tranche) => ({
    ...tranche,
    donorShare: ((BigInt(tranche.amount) * DONOR_SHARE_BPS) / 10_000n).toString(),
  }))

export const donorTrace = (address: string): DonorTrace => ({
  donor: address as Address,
  totalDonated: '9000000000',
  receipts: [
    {
      receiptId: '1',
      needId: '1',
      needStatus: 'InDelivery',
      category: categoryHash('FOOD'),
      regionCode: region('ES-CM'),
      amount: '9000000000',
      shareBps: Number(DONOR_SHARE_BPS),
      releasedToNgo: '2700000000',
      refunded: '0',
      tranches: withDonorShare(DETAILS['1']?.tranches ?? []),
      deliveries: DELIVERIES,
    },
  ],
})

export const programMembers = (programId: string): Result<ProgramMembersResponse> => ({
  ok: true,
  data: { programId, groupId: '0', memberCount: MEMBERS.length, members: MEMBERS, merkleTreeDepth: 3 },
})
