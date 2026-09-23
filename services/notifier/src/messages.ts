import {
  type DonationOutcome,
  type DonationView,
  type DonorStage,
  formatAmount,
  type NeedSummary,
  shortHex,
  trackingRefKind,
} from '@poa/shared'
import type { NotifierConfig } from './config.js'
import { currentStage, type Milestone, milestoneName, type Progress } from './stages.js'

/**
 * Rendering of alert emails and alert webhook bodies. Everything rendered here is persisted in
 * `NotificationDelivery.payload` and shown on `/outbox`, so it must never contain an email address or a token:
 * the unsubscribe link is a placeholder that the dispatcher fills in, in memory, at send time.
 */

export const UNSUBSCRIBE_URL_PLACEHOLDER = '{{unsubscribe_url}}'

type Urls = Pick<NotifierConfig, 'appBaseUrl' | 'publicBaseUrl'>

export interface AlertTarget {
  id: string
  trackingRef: string | null
  needId: string
}

export interface AlertContext {
  progress: Progress
  need: NeedSummary
  /** The tracked donation; null for a need-level subscription. */
  donation: DonationView | null
}

export interface AlertEmailPayload {
  template: 'subscribed' | 'stage' | 'outcome'
  subject: string
  text: string
  needId: string
  trackingRef: string | null
  milestone: string | null
}

export interface AlertWebhookBody {
  type: 'alert.stage' | 'alert.outcome'
  subscriptionId: string
  trackingRef: string | null
  needId: string
  /** The stage or outcome this alert announces; with the subscription id it is unique per alert. */
  milestone: string
  stage: DonorStage | null
  currentStage: DonorStage | null
  outcome: DonationOutcome
  reachedAt: number | null
  txHash: string | null
  attestationUID: string | null
  pending: string | null
  trackUrl: string
  need: {
    id: string
    category: string
    categoryLabel: string
    regionCode: string
    regionLabel: string
    country: string
    status: string
    targetAmount: string
    totalDonated: string
    totalReleased: string
    totalRefunded: string
  }
  donation: { kind: string; amount: string; receiptId: string | null } | null
  createdAt: string
}

const STAGE_LABEL: Record<DonorStage, string> = {
  Verified: 'Verified',
  Funded: 'Funded',
  Settled: 'Settled',
  Delivered: 'Delivered',
  ImpactConfirmed: 'Impact confirmed',
}

const STAGE_MEANING: Record<DonorStage, string> = {
  Verified: 'Independent verifiers confirmed that the need is real.',
  Funded: 'Funding closed: the money raised is committed to this need.',
  Settled: 'A payout to the supplier was reconciled on-chain by a Settlement attestation.',
  Delivered:
    'The NGO showed how a tranche was spent (photos, receipts, bank statements) and donors who gave at least 30% of the money approved it.',
  ImpactConfirmed: 'The NGO published its impact report.',
}

const OUTCOME_MEANING: Record<DonationOutcome, string> = {
  InProgress: 'In progress.',
  Completed:
    'The need is complete: every tranche was paid, each after donors approved how the previous one was spent.',
  Refundable: 'The need did not go ahead as planned: this donation can be refunded.',
  Refunded: 'This donation was refunded.',
  Expired: 'The need expired before reaching its funding threshold; refunds are open.',
  Cancelled: 'The need was cancelled; refunds are open.',
}

export const trackUrl = (urls: Urls, target: Pick<AlertTarget, 'trackingRef' | 'needId'>): string =>
  target.trackingRef
    ? `${urls.appBaseUrl}/en/track/${encodeURIComponent(target.trackingRef)}`
    : `${urls.appBaseUrl}/en/needs/${encodeURIComponent(target.needId)}`

export const unsubscribeUrl = (urls: Urls, subscriptionId: string, token: string): string =>
  `${urls.publicBaseUrl}/unsubscribe?id=${encodeURIComponent(subscriptionId)}&token=${encodeURIComponent(token)}`

/** What `/outbox` shows in place of the unsubscribe link: the real token only ever reaches the recipient. */
export const redactedText = (urls: Urls, subscriptionId: string | null, text: string): string =>
  text.replaceAll(
    UNSUBSCRIBE_URL_PLACEHOLDER,
    `${urls.publicBaseUrl}/unsubscribe?id=${encodeURIComponent(subscriptionId ?? '')}&token=[redacted]`,
  )

const refLabel = (target: AlertTarget): string => {
  if (!target.trackingRef) return `need #${target.needId}`
  const kind = trackingRefKind(target.trackingRef)
  if (kind === 'deposit') return `deposit address ${shortHex(target.trackingRef, 4)}`
  return `donation #${target.trackingRef}`
}

const utc = (seconds: number): string =>
  `${new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`

const needLines = (context: AlertContext): string[] => {
  const { need, donation } = context
  const lines = [
    `Need #${need.id}: ${need.categoryLabel} in ${need.regionLabel}`,
    `Raised ${formatAmount(need.totalDonated)} of ${formatAmount(need.targetAmount)}, ` +
      `released to the NGO ${formatAmount(need.totalReleased)}`,
  ]
  if (donation) {
    lines.push(`This donation: ${formatAmount(donation.amount)}`)
  }
  return lines
}

const footer = (urls: Urls, target: AlertTarget): string[] => [
  `Follow every step: ${trackUrl(urls, target)}`,
  `Manage alerts: ${trackUrl(urls, target)}#alerts`,
  '',
  `You receive this because this address was subscribed to alerts for ${refLabel(target)}. There is no account:`,
  'the address is stored encrypted and its key is destroyed when you unsubscribe.',
  `Unsubscribe: ${UNSUBSCRIBE_URL_PLACEHOLDER}`,
]

export const subscribedEmail = (
  urls: Urls,
  target: AlertTarget,
  context: AlertContext,
): AlertEmailPayload => {
  const stage = currentStage(context.progress)
  const text = [
    `Alerts are on for ${refLabel(target)}.`,
    '',
    ...needLines(context),
    `Current stage: ${stage ? STAGE_LABEL[stage] : 'not verified yet'}`,
    `Outcome so far: ${OUTCOME_MEANING[context.progress.outcome]}`,
    '',
    'You will get one email for each new stage (Verified, Funded, Settled, Delivered, Impact confirmed) and one',
    'if it reaches a final outcome. Stages already reached are not sent again.',
    '',
    ...footer(urls, target),
  ].join('\n')
  return {
    template: 'subscribed',
    subject: `VerifAid · ${refLabel(target)}: alerts are on`,
    text,
    needId: target.needId,
    trackingRef: target.trackingRef,
    milestone: null,
  }
}

export const milestoneEmail = (
  urls: Urls,
  target: AlertTarget,
  context: AlertContext,
  milestone: Milestone,
): AlertEmailPayload => {
  const detail: string[] = []
  let headline: string
  if (milestone.kind === 'stage') {
    const view = milestone.stage
    headline = `${refLabel(target)} reached the stage "${STAGE_LABEL[view.stage]}".`
    detail.push(STAGE_MEANING[view.stage])
    if (view.at) detail.push(`When: ${utc(view.at)}`)
    if (view.txHash) detail.push(`Transaction: ${view.txHash}`)
    if (view.attestationUID) detail.push(`Attestation: ${view.attestationUID}`)
    if (view.pending) detail.push(`Still pending: ${view.pending}`)
  } else {
    headline = `${refLabel(target)}: ${milestone.outcome}.`
    detail.push(OUTCOME_MEANING[milestone.outcome])
  }
  const name = milestoneName(milestone)
  const label = milestone.kind === 'stage' ? STAGE_LABEL[milestone.stage.stage] : milestone.outcome
  return {
    template: milestone.kind,
    subject: `VerifAid · ${refLabel(target)}: ${label}`,
    text: [
      headline.charAt(0).toUpperCase() + headline.slice(1),
      '',
      ...needLines(context),
      '',
      ...detail,
      '',
      ...footer(urls, target),
    ].join('\n'),
    needId: target.needId,
    trackingRef: target.trackingRef,
    milestone: name,
  }
}

export const milestoneWebhookBody = (
  urls: Urls,
  target: AlertTarget,
  context: AlertContext,
  milestone: Milestone,
  now: Date,
): AlertWebhookBody => {
  const view = milestone.kind === 'stage' ? milestone.stage : null
  const { need, donation } = context
  return {
    type: milestone.kind === 'stage' ? 'alert.stage' : 'alert.outcome',
    subscriptionId: target.id,
    trackingRef: target.trackingRef,
    needId: target.needId,
    milestone: milestoneName(milestone),
    stage: view?.stage ?? null,
    currentStage: currentStage(context.progress),
    outcome: context.progress.outcome,
    reachedAt: view?.at ?? null,
    txHash: view?.txHash ?? null,
    attestationUID: view?.attestationUID ?? null,
    pending: view?.pending ?? null,
    trackUrl: trackUrl(urls, target),
    need: {
      id: need.id,
      category: need.category,
      categoryLabel: need.categoryLabel,
      regionCode: need.regionCode,
      regionLabel: need.regionLabel,
      country: need.country,
      status: need.status,
      targetAmount: need.targetAmount,
      totalDonated: need.totalDonated,
      totalReleased: need.totalReleased,
      totalRefunded: need.totalRefunded,
    },
    donation: donation
      ? {
          kind: donation.kind,
          amount: donation.amount,
          receiptId: donation.receiptId,
        }
      : null,
    createdAt: now.toISOString(),
  }
}
