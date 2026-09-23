import { type NeedDetail, type TimelineEvent, vaultCurrency } from '@poa/shared'
import { chain, deployment, network } from '../config'
import { amount, bpsOf, bpsPercent, timestamp } from '../format'
import { isZeroUid } from '../links'
import { PdfReport } from '../pdf'

/**
 * The donor / funder / audit report for one need (gap plan C2). It is a rendering of indexer data that is
 * itself derived from chain events, so every row carries the transaction hash or attestation UID an auditor
 * needs to check it independently. English only: it is an audit artefact, not a localized page.
 */

/** Every figure in the report is in the currency the vaults hold. */
const UNIT = deployment ? vaultCurrency(deployment).symbol : 'USDC'
const money = (value: string | bigint | null | undefined): string =>
  value === null || value === undefined ? '-' : `${amount(value)} ${UNIT}`

const deadline = (seconds: number | null, none: string): string => (seconds ? timestamp(seconds) : none)

const eventDetails = (event: TimelineEvent): string =>
  Object.entries(event.data)
    .filter(([, value]) => value !== null && value !== '')
    .map(([key, value]) => `${key}=${value}`)
    .join(', ')

export const renderNeedReport = async (need: NeedDetail, timeline: TimelineEvent[]): Promise<Uint8Array> => {
  const report = await PdfReport.create({
    title: `VerifAid - Need #${need.id}`,
    subject: 'Donor, funder and audit report',
  })

  report.title(
    `VerifAid - Need #${need.id}`,
    `${need.categoryLabel} - ${need.regionLabel}${need.ngoName ? ` - ${need.ngoName}` : ''}`,
  )
  report.keyValues([
    ['Generated at', timestamp(Math.floor(Date.now() / 1000))],
    ['Source', 'Indexer view of on-chain events and EAS attestations'],
  ])

  report.heading('Chain and contracts')
  report.keyValues([
    ['Network', `${chain.name} (chain id ${chain.id}, ${network})`],
    ['NeedsRegistry', deployment?.contracts.NeedsRegistry],
    ['DeliveryManager', deployment?.contracts.DeliveryManager],
    ['ProofOfAidResolver', deployment?.contracts.ProofOfAidResolver],
    ['EAS', deployment?.external.EAS],
    ['Stablecoin', deployment?.external.Token],
    ['Vault', need.vault],
    ['NGO', need.ngo],
  ])

  report.heading('Need')
  report.keyValues([
    ['Status', need.status],
    ['Category', need.categoryLabel],
    ['Region', `${need.regionLabel} (country ${need.country})`],
    ['Program', `#${need.programId}`],
    ['Verifications', `${need.verificationCount} of ${need.verificationsRequired}`],
    ['Created', timestamp(need.createdAt)],
    ['Metadata URI', need.metadataURI],
    ...(need.expiredAt ? ([['Expired', timestamp(need.expiredAt)]] as [string, string][]) : []),
  ])

  report.heading('Terms committed at creation')
  report.keyValues([
    ['Custody', "On-chain escrow in the need's own vault"],
    ['Funding deadline', deadline(need.fundingDeadline, 'Open-ended')],
    ['Execution deadline', deadline(need.executionDeadline, 'None')],
    [
      'Minimum funding',
      need.minFundingBps >= 10_000
        ? '100% - all or nothing'
        : `${bpsPercent(need.minFundingBps)}% - partial execution allowed, tranches scale to what was raised`,
    ],
    ['Third-party cost cap', `${bpsPercent(need.thirdPartyCostBps)}% of what donors paid`],
    ['Cost disclosure hash', need.costDisclosureHash],
    ['Expected outcome hash', need.expectedOutcomeHash],
  ])

  const fees = BigInt(need.fundingFees) + BigInt(need.settlementFees)
  const paidByDonors = BigInt(need.totalDonated) + BigInt(need.fundingFees)
  report.heading('Funding summary')
  report.keyValues([
    ['Target', money(need.targetAmount)],
    ['Raised (counts toward target)', money(need.totalDonated)],
    ['Funding gap', money(need.fundingGap)],
    ['Fees on the way in', money(need.fundingFees)],
    ['Fees on the way out', money(need.settlementFees)],
    ['Fees in total', `${money(fees)} (${bpsPercent(bpsOf(fees, paidByDonors))}% of what donors paid)`],
    ['Released to the NGO', money(need.totalReleased)],
    ['Refunded to donors', money(need.totalRefunded)],
  ])

  report.heading('Tranches')
  report.table(
    [
      { header: '#', width: 0.05 },
      { header: 'Share', width: 0.08, align: 'right' },
      { header: 'Amount', width: 0.16, align: 'right' },
      { header: 'Status', width: 0.1 },
      { header: 'Delivery', width: 0.08 },
      { header: 'Released at', width: 0.16 },
      { header: 'Release tx', width: 0.37, mono: true },
    ],
    need.tranches.map((tranche) => [
      tranche.index,
      `${bpsPercent(tranche.bps)}%`,
      amount(tranche.amount),
      tranche.status,
      tranche.deliveryId ? `#${tranche.deliveryId}` : null,
      tranche.releasedAt ? timestamp(tranche.releasedAt) : null,
      tranche.releaseTxHash,
    ]),
    'No tranches yet: they are fixed when funding closes.',
  )

  report.heading('Settlements')
  report.table(
    [
      { header: 'Tranche', width: 0.08 },
      { header: 'Gross', width: 0.12, align: 'right' },
      { header: 'Fee', width: 0.1, align: 'right' },
      { header: 'Net', width: 0.12, align: 'right' },
      { header: 'Supplier ref hash / attestation UID', width: 0.43, mono: true },
      { header: 'Recorded', width: 0.15 },
    ],
    need.settlements.map((settlement) => [
      settlement.trancheIndex,
      amount(settlement.gross),
      amount(settlement.fee),
      amount(settlement.net),
      `${settlement.supplierRefHash} ${settlement.uid}`,
      timestamp(settlement.timestamp),
    ]),
    'No Settlement attestations yet.',
  )

  report.heading('Donations')
  report.table(
    [
      { header: 'Kind', width: 0.09 },
      { header: 'Counted', width: 0.12, align: 'right' },
      { header: 'Conversion cost', width: 0.15, align: 'right' },
      { header: 'Receipt / deposit address', width: 0.2, mono: true },
      { header: 'Transaction', width: 0.29, mono: true },
      { header: 'When', width: 0.15 },
    ],
    need.donations.map((donation) => [
      donation.kind,
      amount(donation.amount),
      donation.conversion ? amount(donation.conversion.conversionFee) : null,
      donation.receiptId
        ? `#${donation.receiptId}`
        : donation.conversion?.viaDepositAddress
          ? donation.conversion.via
          : null,
      donation.txHash,
      timestamp(donation.timestamp),
    ]),
    'No donations yet.',
  )

  report.heading('Deliveries')
  if (need.deliveries.length === 0) report.paragraph('No evidence filed yet.', { size: 8.5 })
  for (const delivery of need.deliveries) {
    report.paragraph(
      `Delivery #${delivery.id} - accounts for tranche ${delivery.trancheIndex - 1}, unlocks tranche ${delivery.trancheIndex} - ${delivery.status}`,
      { bold: true },
    )
    if (delivery.manifest?.note) report.paragraph(delivery.manifest.note, { size: 8.5 })
    const donorVotes = delivery.votes.filter((vote) => vote.voice === 'Donor')
    report.keyValues([
      [
        'Donor approval',
        delivery.requiredAmount === '0'
          ? null
          : `${amount(delivery.approvedAmount)} of ${amount(delivery.requiredAmount)} ${UNIT} required (${donorVotes.filter((vote) => vote.approve).length} donors)`,
      ],
      [
        'Donor rejection',
        delivery.rejectionAmount === '0'
          ? null
          : `${amount(delivery.rejectedAmount)} of ${amount(delivery.rejectionAmount)} ${UNIT} needed to reject`,
      ],
      [
        'Verifiers',
        delivery.requiredVerifiers === 0
          ? null
          : `${delivery.verifierApprovals} of ${delivery.requiredVerifiers} approved, ${delivery.verifierRejections} rejected`,
      ],
      ['Filed', timestamp(delivery.submittedAt)],
      [
        delivery.status === 'Rejected' ? 'Rejected' : 'Approved',
        delivery.decidedAt ? timestamp(delivery.decidedAt) : null,
      ],
      ['Manifest hash (on chain)', delivery.evidenceHash],
      ['Transaction', delivery.txHash],
      ...(delivery.manifest?.files ?? []).map((file): [string, string] => [
        `${file.kind.replace('_', ' ')}: ${file.name}`,
        file.cid ? `sha256 ${file.sha256}, IPFS ${file.cid}` : `sha256 ${file.sha256}`,
      ]),
    ])
    report.spacer(4)
  }

  report.heading('Impact report')
  if (need.impactReport) {
    report.keyValues([
      ['Beneficiaries served', need.impactReport.beneficiariesServed],
      ['Attestation UID', need.impactReport.uid],
      ['KPI hash', need.impactReport.kpiHash],
      ['Report CID', need.impactReport.reportCID],
      ['Published', timestamp(need.impactReport.timestamp)],
      ['Revoked', need.impactReport.revoked ? 'Yes' : 'No'],
    ])
  } else {
    report.paragraph('No impact report published yet.', { size: 8.5 })
  }

  report.heading('Full timeline')
  report.table(
    [
      { header: 'When / block', width: 0.14 },
      { header: 'Event', width: 0.21 },
      { header: 'Details', width: 0.28 },
      { header: 'Tx hash / attestation UID', width: 0.37, mono: true },
    ],
    timeline.map((event) => [
      `${timestamp(event.timestamp)} #${event.blockNumber}`,
      event.type,
      eventDetails(event),
      isZeroUid(event.attestationUID) ? event.txHash : `${event.txHash} ${event.attestationUID}`,
    ]),
    'No events indexed yet.',
  )

  return report.finish(`VerifAid - Need #${need.id} - Every figure is verifiable on-chain`)
}
