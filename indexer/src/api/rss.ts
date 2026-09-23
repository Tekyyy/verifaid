import { formatAmount, shortHex } from '@poa/shared'
import type { NeedRow, TimelineRow } from './views.js'

/**
 * RSS 2.0 feeds: the zero-infrastructure alert channel. Any feed reader, Slack or email-to-RSS bridge can follow
 * a need or a donation without an account, and nothing about the reader is ever sent to us.
 */

const escapeXml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const amount = (data: Record<string, unknown>, key: string): string => {
  const value = data[key]
  return typeof value === 'string' && /^\d+$/.test(value) ? formatAmount(value) : '—'
}

/** A one-line, human-readable title per timeline event type. */
export const timelineTitle = (row: TimelineRow): string => {
  const data = row.data as Record<string, unknown>
  switch (row.type) {
    case 'NeedCreated':
      return `Need registered, target ${amount(data, 'targetAmount')}`
    case 'NeedVerificationRecorded':
      return data.approved ? 'Independent verification recorded' : 'Verification rejected the need'
    case 'NeedVerified':
      return 'Need verified: funding is open'
    case 'NeedStatusChanged':
      return `Status: ${String(data.from)} → ${String(data.to)}`
    case 'NeedCancelled':
      return 'Need cancelled'
    case 'NeedExpired':
      return `Deadline passed: need expired with ${amount(data, 'raised')} raised`
    case 'PartialFundingAccepted':
      return `Deadline passed above the threshold: going ahead with ${amount(data, 'raised')}`
    case 'VerificationRevoked':
      return 'A verification was revoked'
    case 'Donated':
      return `Donation of ${amount(data, 'amount')}`
    case 'FundingClosed':
      return `Funding closed at ${amount(data, 'totalDonated')}`
    case 'TrancheReleasable':
      return `Tranche ${String(data.index)} ready to release`
    case 'TrancheReleased':
      return `Tranche ${String(data.index)} released: ${amount(data, 'amount')}`
    case 'SettlementRecorded':
      return `Tranche ${String(data.trancheIndex)} settled: ${amount(data, 'net')} to suppliers, fees ${amount(data, 'fee')}`
    case 'Refunded':
      return `Refund of ${amount(data, 'amount')}`
    case 'DeliveryOpened':
      return `Delivery #${String(data.deliveryId ?? '')} started`
    case 'DeliveryEvidenceLinked':
      return 'Field evidence filed'
    case 'ReceiptConfirmed':
      return 'Anonymous beneficiary confirmation'
    case 'DeliveryVerifiedLinked':
      return data.approved
        ? 'Delivery signed off by an independent verifier'
        : 'Delivery rejected by a verifier'
    case 'DeliveryChallengeable':
      return 'Delivery verified: challenge window open'
    case 'DeliveryChallenged':
      return 'Delivery challenged'
    case 'DisputeResolved':
      return data.upheld ? 'Challenge upheld: delivery rejected' : 'Challenge dismissed'
    case 'DeliveryFinalized':
      return 'Delivery finalized'
    case 'DeliveryRejected':
      return 'Delivery rejected'
    case 'ImpactReportPublished':
      return `Impact report published: ${String(data.beneficiariesServed)} beneficiaries served`
    default:
      return row.type
  }
}

export interface FeedOptions {
  title: string
  link: string
  description: string
  selfUrl: string
  itemLink: string
  need: NeedRow
  rows: TimelineRow[]
}

/** Newest first, capped: feed readers only ever need the recent past. */
export const renderRss = (options: FeedOptions): string => {
  const items = [...options.rows]
    .sort((a, b) =>
      a.blockNumber === b.blockNumber ? b.logIndex - a.logIndex : Number(b.blockNumber - a.blockNumber),
    )
    // A delivery can collect hundreds of confirmations; one item per confirmation would drown the feed.
    .filter((row) => row.type !== 'ReceiptConfirmed')
    .slice(0, 100)
    .map(
      (row) => `    <item>
      <title>${escapeXml(timelineTitle(row))}</title>
      <link>${escapeXml(options.itemLink)}</link>
      <guid isPermaLink="false">${escapeXml(row.id)}</guid>
      <pubDate>${new Date(row.timestamp * 1000).toUTCString()}</pubDate>
      <description>${escapeXml(`Transaction ${shortHex(row.txHash)}${row.attestationUID ? `, attestation ${shortHex(row.attestationUID)}` : ''}`)}</description>
    </item>`,
    )
    .join('\n')

  const lastBuild = options.rows.reduce(
    (latest, row) => Math.max(latest, row.timestamp),
    options.need.createdAt,
  )

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(options.title)}</title>
    <link>${escapeXml(options.link)}</link>
    <description>${escapeXml(options.description)}</description>
    <atom:link href="${escapeXml(options.selfUrl)}" rel="self" type="application/rss+xml"/>
    <lastBuildDate>${new Date(lastBuild * 1000).toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>
`
}
