import type { TimelineEvent, TimelineEventType } from '@poa/shared'

/**
 * Runtime list of the indexer's timeline event types, for validating an integrator's filter. `@poa/shared` only
 * exports the union type; the assertion below fails the build if the two drift apart.
 */
export const TIMELINE_EVENT_TYPES = [
  'NeedCreated',
  'NeedVerificationRecorded',
  'NeedVerified',
  'NeedStatusChanged',
  'NeedCancelled',
  'NeedExpired',
  'PartialFundingAccepted',
  'VerificationRevoked',
  'Donated',
  'DonatedOnBehalf',
  'FundingRecorded',
  'FundingClosed',
  'TrancheReleasable',
  'TrancheReleased',
  'SettlementRecorded',
  'Refunded',
  'DeliveryOpened',
  'DeliveryEvidenceLinked',
  'ReceiptConfirmed',
  'DeliveryVerifiedLinked',
  'DeliveryChallengeable',
  'DeliveryChallenged',
  'DisputeResolved',
  'DeliveryFinalized',
  'DeliveryRejected',
  'ImpactReportPublished',
] as const satisfies readonly TimelineEventType[]

type MissingEventTypes = Exclude<TimelineEventType, (typeof TIMELINE_EVENT_TYPES)[number]>
const everyEventTypeListed: [MissingEventTypes] extends [never] ? true : MissingEventTypes = true
void everyEventTypeListed

export interface EndpointFilter {
  needId: string | null
  eventTypes: string[]
}

/** An endpoint gets an event when it follows that need (or every need) and that type (or every type). */
export const endpointMatches = (
  endpoint: EndpointFilter,
  event: Pick<TimelineEvent, 'needId' | 'type'>,
): boolean =>
  (endpoint.needId === null || endpoint.needId === event.needId) &&
  (endpoint.eventTypes.length === 0 || endpoint.eventTypes.includes(event.type))
