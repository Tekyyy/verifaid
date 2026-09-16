import type { DonationTrack, NeedDetail, TimelineEvent } from '@poa/shared'
import { type Prisma, prisma } from '@poa/shared/db'
import type { FastifyBaseLogger } from 'fastify'
import {
  contextFromNeed,
  contextFromTrack,
  type DeliveryRow,
  milestoneDelivery,
  webhookDelivery,
} from '../alerts.js'
import type { NotifierDeps } from '../deps.js'
import { endpointMatches } from '../events.js'
import { type Cursor, formatCursor, parseCursor, TIMELINE_PAGE_LIMIT } from '../indexer.js'
import { milestoneName, newMilestones } from '../stages.js'

/**
 * Tails the indexer's global timeline and turns events into queued deliveries.
 *
 * Per page: integrator webhooks for every matching endpoint, then alerts for the needs the page touched. For
 * alerts the event itself is only a trigger: the subscriber's state is re-read from the indexer (each donation
 * track and need fetched once per poll) and diffed against what was already announced, so a missed or reordered
 * event can delay an alert but never lose or duplicate it.
 *
 * Deliveries, the new `notifiedStages` and the cursor are written in one transaction. The cursor therefore never
 * moves past events whose deliveries are not stored (at-least-once), and the unique dedupe key turns a re-run of
 * the same page into a no-op (exactly-once).
 */

export const TIMELINE_CURSOR_ID = 'timeline'
const MAX_PAGES_PER_POLL = 50

export interface PollerDeps extends Pick<NotifierDeps, 'config' | 'indexer'> {
  log?: FastifyBaseLogger
  pageLimit?: number
  maxPages?: number
  now?: () => Date
}

export interface PollResult {
  pages: number
  events: number
  deliveriesCreated: number
  cursor: string | null
}

export const readCursor = async (): Promise<string | null> => {
  const row = await prisma().notifierCursor.findUnique({ where: { id: TIMELINE_CURSOR_ID } })
  return row ? formatCursor(row) : null
}

/** Fetches each donation track and need at most once per poll cycle, even across pages. */
class StateCache {
  private readonly tracks = new Map<string, Promise<DonationTrack | null>>()
  private readonly needs = new Map<string, Promise<NeedDetail | null>>()

  constructor(private readonly deps: PollerDeps) {}

  track(ref: string): Promise<DonationTrack | null> {
    let pending = this.tracks.get(ref)
    if (!pending) {
      pending = this.deps.indexer.donation(ref)
      this.tracks.set(ref, pending)
    }
    return pending
  }

  need(id: string): Promise<NeedDetail | null> {
    let pending = this.needs.get(id)
    if (!pending) {
      pending = this.deps.indexer.need(id)
      this.needs.set(id, pending)
    }
    return pending
  }
}

export const pollOnce = async (deps: PollerDeps): Promise<PollResult> => {
  let cursor = await readCursor()
  const cache = new StateCache(deps)
  const result: PollResult = { pages: 0, events: 0, deliveriesCreated: 0, cursor }
  const maxPages = deps.maxPages ?? MAX_PAGES_PER_POLL

  for (let page = 0; page < maxPages; page++) {
    const timeline = await deps.indexer.timeline(cursor, deps.pageLimit ?? TIMELINE_PAGE_LIMIT)
    const next = timeline.cursor
    if (timeline.events.length === 0 || !next || next === cursor) break
    const parsed = parseCursor(next)
    if (!parsed) throw new Error(`indexer returned a malformed cursor "${next}"`)

    result.deliveriesCreated += await processPage(deps, cache, timeline.events, parsed)
    result.pages += 1
    result.events += timeline.events.length
    cursor = next
    result.cursor = next
  }
  return result
}

const processPage = async (
  deps: PollerDeps,
  cache: StateCache,
  events: TimelineEvent[],
  next: Cursor,
): Promise<number> => {
  const db = prisma()
  const now = deps.now?.() ?? new Date()

  const endpoints = await db.webhookEndpoint.findMany({
    where: { active: true },
    select: { id: true, needId: true, eventTypes: true },
  })
  const rows: DeliveryRow[] = []
  for (const event of events) {
    for (const endpoint of endpoints) {
      if (endpointMatches(endpoint, event)) rows.push(webhookDelivery(endpoint.id, event))
    }
  }

  const alerts = await evaluateAlerts(deps, cache, events, now)
  rows.push(...alerts.rows)

  const operations: Prisma.PrismaPromise<unknown>[] = [
    db.notificationDelivery.createMany({ data: rows, skipDuplicates: true }),
    ...alerts.updates.map(({ id, notifiedStages }) =>
      db.alertSubscription.updateMany({ where: { id, unsubscribedAt: null }, data: { notifiedStages } }),
    ),
    db.notifierCursor.upsert({
      where: { id: TIMELINE_CURSOR_ID },
      create: { id: TIMELINE_CURSOR_ID, blockNumber: next.blockNumber, logIndex: next.logIndex },
      update: { blockNumber: next.blockNumber, logIndex: next.logIndex },
    }),
  ]
  const [created] = (await db.$transaction(operations)) as [Prisma.BatchPayload, ...unknown[]]
  return created.count
}

interface AlertBatch {
  rows: DeliveryRow[]
  updates: { id: string; notifiedStages: string[] }[]
}

const evaluateAlerts = async (
  deps: PollerDeps,
  cache: StateCache,
  events: TimelineEvent[],
  now: Date,
): Promise<AlertBatch> => {
  const batch: AlertBatch = { rows: [], updates: [] }
  const needIds = [...new Set(events.map((event) => event.needId).filter(Boolean))]
  if (needIds.length === 0) return batch

  const subscriptions = await prisma().alertSubscription.findMany({
    where: { needId: { in: needIds }, unsubscribedAt: null },
    select: { id: true, trackingRef: true, needId: true, channel: true, notifiedStages: true },
    orderBy: { createdAt: 'asc' },
  })
  if (subscriptions.length === 0) return batch

  // Fetch every distinct donation and need concurrently; an indexer failure aborts the page (cursor unmoved).
  const refs = subscriptions.flatMap((sub) => (sub.trackingRef ? [sub.trackingRef] : []))
  const wholeNeeds = subscriptions.flatMap((sub) => (sub.trackingRef ? [] : [sub.needId]))
  const [byRef, byNeed] = await Promise.all([
    loadAll(refs, async (ref) => {
      const track = await cache.track(ref)
      return track ? contextFromTrack(track) : null
    }),
    loadAll(wholeNeeds, async (needId) => {
      const need = await cache.need(needId)
      return need ? contextFromNeed(need) : null
    }),
  ])

  for (const subscription of subscriptions) {
    const context = subscription.trackingRef
      ? byRef.get(subscription.trackingRef)
      : byNeed.get(subscription.needId)
    if (!context) {
      deps.log?.warn({ subscriptionId: subscription.id }, 'indexer no longer knows this subscription target')
      continue
    }
    const fresh = newMilestones(subscription.notifiedStages, context.progress)
    if (fresh.length === 0) continue
    for (const milestone of fresh) {
      batch.rows.push(milestoneDelivery(deps.config, subscription, context, milestone, now))
    }
    batch.updates.push({
      id: subscription.id,
      notifiedStages: [...subscription.notifiedStages, ...fresh.map(milestoneName)],
    })
  }
  return batch
}

const loadAll = async <T>(keys: string[], load: (key: string) => Promise<T>): Promise<Map<string, T>> =>
  new Map(await Promise.all([...new Set(keys)].map(async (key) => [key, await load(key)] as const)))
