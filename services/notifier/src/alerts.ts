import type { DonationTrack, NeedDetail } from '@poa/shared'
import type { Prisma } from '@poa/shared/db'
import type { NotifierConfig } from './config.js'
import {
  type AlertContext,
  type AlertTarget,
  milestoneEmail,
  milestoneWebhookBody,
  subscribedEmail,
} from './messages.js'
import { type Milestone, milestoneName, needProgress, trackProgress } from './stages.js'

/**
 * Glue between the pure pieces (stages, messages) and the database rows the poller and the routes write.
 *
 * Dedupe keys are the exactly-once guarantee: `<kind>:<subscription id>:<stage or outcome>` for alerts and
 * `WEBHOOK:<endpoint id>:<event id>` for integrator webhooks. Re-running a poll over the same events can only ever
 * collide on the unique index, never produce a second message.
 */

export type Channel = 'EMAIL' | 'WEBHOOK'
export type DeliveryKind = 'ALERT_EMAIL' | 'ALERT_WEBHOOK' | 'WEBHOOK'
export type DeliveryStatus = 'PENDING' | 'SENT' | 'FAILED'

export type DeliveryRow = Prisma.NotificationDeliveryCreateManyInput

export const toJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue

export const contextFromTrack = (track: DonationTrack): AlertContext => ({
  progress: trackProgress(track),
  need: track.need,
  donation: track.donation,
})

export const contextFromNeed = (need: NeedDetail): AlertContext => ({
  progress: needProgress(need),
  need,
  donation: null,
})

export const alertKind = (channel: string): DeliveryKind =>
  channel === 'EMAIL' ? 'ALERT_EMAIL' : 'ALERT_WEBHOOK'

export const milestoneDelivery = (
  config: NotifierConfig,
  subscription: AlertTarget & { channel: string },
  context: AlertContext,
  milestone: Milestone,
  now: Date,
): DeliveryRow => {
  const kind = alertKind(subscription.channel)
  return {
    dedupeKey: `${kind}:${subscription.id}:${milestoneName(milestone)}`,
    kind,
    subscriptionId: subscription.id,
    payload: toJson(
      kind === 'ALERT_EMAIL'
        ? milestoneEmail(config, subscription, context, milestone)
        : milestoneWebhookBody(config, subscription, context, milestone, now),
    ),
  }
}

export const subscribedDelivery = (
  config: NotifierConfig,
  subscription: AlertTarget,
  context: AlertContext,
): DeliveryRow => ({
  dedupeKey: `ALERT_EMAIL:${subscription.id}:Subscribed`,
  kind: 'ALERT_EMAIL',
  subscriptionId: subscription.id,
  payload: toJson(subscribedEmail(config, subscription, context)),
})

export const webhookDelivery = (endpointId: string, event: { id: string }): DeliveryRow => ({
  dedupeKey: `WEBHOOK:${endpointId}:${event.id}`,
  kind: 'WEBHOOK',
  endpointId,
  payload: toJson(event),
})
