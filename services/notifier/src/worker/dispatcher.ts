import { signWebhookBody } from '@poa/shared'
import { type NotificationDelivery, prisma, type WebhookEndpoint } from '@poa/shared/db'
import type { FastifyBaseLogger } from 'fastify'
import type { DeliveryStatus } from '../alerts.js'
import { alertWebhookSecret, openEmail, openWebhookSecret, unsubscribeLinkToken } from '../crypto.js'
import type { NotifierDeps } from '../deps.js'
import { UNSUBSCRIBE_URL_PLACEHOLDER, unsubscribeUrl } from '../messages.js'
import { checkWebhookUrl } from '../urls.js'

/**
 * Sends queued deliveries and records the outcome.
 *
 * Each due row is claimed by moving its `nextAttemptAt` forward with a compare-and-set, so two dispatchers (or a
 * kick overlapping a poll) cannot send the same row twice. Failures back off 1 min, 5 min, 30 min, 2 h, 12 h; the
 * sixth failed attempt marks the row FAILED. A delivery whose subscription was cancelled or whose endpoint was
 * disabled fails immediately without being sent.
 */

export const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000] as const
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1
/** How long a claimed row is hidden from other dispatchers; comfortably longer than any send timeout. */
const CLAIM_LEASE_MS = 2 * 60_000
const CONCURRENCY = 4
const MAX_ERROR_LENGTH = 500

export const USER_AGENT = 'ProofOfAid-Notifier/1'

/** After failed attempt number `attempts` (1-based): when to retry, or null to give up. */
export const retryAt = (attempts: number, now: Date): Date | null => {
  const delay = BACKOFF_MS[attempts - 1]
  if (attempts >= MAX_ATTEMPTS || delay === undefined) return null
  return new Date(now.getTime() + delay)
}

export type DispatcherDeps = Pick<NotifierDeps, 'config' | 'kek' | 'email' | 'fetch'> & {
  log?: FastifyBaseLogger
}

export interface DispatchResult {
  sent: number
  retrying: number
  failed: number
}

type Attempt = { ok: true } | { ok: false; permanent: boolean; error: string }

const sent: Attempt = { ok: true }
const permanent = (error: string): Attempt => ({ ok: false, permanent: true, error })
const transient = (error: string): Attempt => ({ ok: false, permanent: false, error })

type DueDelivery = NotificationDelivery & { endpoint: WebhookEndpoint | null }

export const dispatchDue = async (
  deps: DispatcherDeps,
  options: { now?: Date; limit?: number } = {},
): Promise<DispatchResult> => {
  const now = options.now ?? new Date()
  const db = prisma()
  const due = await db.notificationDelivery.findMany({
    where: { status: 'PENDING', nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: 'asc' },
    take: options.limit ?? 50,
    include: { endpoint: true },
  })

  const result: DispatchResult = { sent: 0, retrying: 0, failed: 0 }
  for (let start = 0; start < due.length; start += CONCURRENCY) {
    const outcomes = await Promise.all(
      due.slice(start, start + CONCURRENCY).map((delivery) => dispatchOne(deps, delivery, now)),
    )
    for (const status of outcomes) {
      if (status === 'SENT') result.sent += 1
      else if (status === 'FAILED') result.failed += 1
      else if (status === 'PENDING') result.retrying += 1
    }
  }
  return result
}

/** Returns the row's new status, or null when another dispatcher claimed it first. */
const dispatchOne = async (
  deps: DispatcherDeps,
  delivery: DueDelivery,
  now: Date,
): Promise<DeliveryStatus | null> => {
  const db = prisma()
  const claim = await db.notificationDelivery.updateMany({
    where: { id: delivery.id, status: 'PENDING', nextAttemptAt: delivery.nextAttemptAt },
    data: { nextAttemptAt: new Date(now.getTime() + CLAIM_LEASE_MS) },
  })
  if (claim.count === 0) return null

  let attempt: Attempt
  try {
    attempt = await send(deps, delivery)
  } catch (error) {
    // A decryption or rendering failure will not fix itself on retry.
    attempt = permanent(error instanceof Error ? error.message : String(error))
  }

  if (attempt.ok) {
    await db.notificationDelivery.update({
      where: { id: delivery.id },
      data: { status: 'SENT', attempts: delivery.attempts + 1, lastError: null },
    })
    return 'SENT'
  }

  const lastError = attempt.error.slice(0, MAX_ERROR_LENGTH)
  if (attempt.permanent) {
    await db.notificationDelivery.update({
      where: { id: delivery.id },
      data: { status: 'FAILED', lastError },
    })
    deps.log?.warn({ deliveryId: delivery.id, kind: delivery.kind, error: lastError }, 'delivery dropped')
    return 'FAILED'
  }

  const attempts = delivery.attempts + 1
  const next = retryAt(attempts, now)
  await db.notificationDelivery.update({
    where: { id: delivery.id },
    data: next ? { attempts, lastError, nextAttemptAt: next } : { attempts, lastError, status: 'FAILED' },
  })
  deps.log?.warn(
    {
      deliveryId: delivery.id,
      kind: delivery.kind,
      attempts,
      error: lastError,
      retryAt: next?.toISOString(),
    },
    next ? 'delivery failed, will retry' : 'delivery failed permanently',
  )
  return next ? 'PENDING' : 'FAILED'
}

const send = async (deps: DispatcherDeps, delivery: DueDelivery): Promise<Attempt> => {
  const payload = delivery.payload as Record<string, unknown>

  if (delivery.kind === 'WEBHOOK') {
    const endpoint = delivery.endpoint
    if (!endpoint?.active) return permanent('webhook endpoint disabled')
    const secret = openWebhookSecret(deps.kek, endpoint.id, endpoint.sealedSecret)
    return postSigned(deps, endpoint.url, delivery.id, String(payload.type ?? 'event'), payload, secret)
  }

  const subscription = delivery.subscriptionId
    ? await prisma().alertSubscription.findUnique({ where: { id: delivery.subscriptionId } })
    : null
  if (!subscription || subscription.unsubscribedAt) return permanent('subscription cancelled')

  if (delivery.kind === 'ALERT_WEBHOOK') {
    if (!subscription.webhookUrl) return permanent('subscription has no webhook URL')
    const secret = alertWebhookSecret(deps.kek, subscription.id)
    return postSigned(deps, subscription.webhookUrl, delivery.id, String(payload.type), payload, secret)
  }

  if (delivery.kind === 'ALERT_EMAIL') {
    const { subject, text } = payload
    if (typeof subject !== 'string' || typeof text !== 'string') return permanent('malformed email payload')
    // Decrypted here, used for this one call, never logged or stored.
    const to = openEmail(deps.kek, subscription)
    if (!to) return permanent('subscription cancelled')
    const link = unsubscribeUrl(deps.config, subscription.id, unsubscribeLinkToken(deps.kek, subscription.id))
    try {
      await deps.email.send({ to, subject, text: text.replaceAll(UNSUBSCRIBE_URL_PLACEHOLDER, link) })
      return sent
    } catch (error) {
      return transient(error instanceof Error ? error.message : String(error))
    }
  }

  return permanent(`unknown delivery kind ${delivery.kind}`)
}

const postSigned = async (
  deps: DispatcherDeps,
  url: string,
  deliveryId: string,
  eventType: string,
  payload: unknown,
  secret: string,
): Promise<Attempt> => {
  // Re-checked at send time: the rules may be stricter now than when the URL was registered.
  const target = checkWebhookUrl(url, { production: deps.config.production })
  if (!target.ok) return permanent(`webhook URL refused: ${target.reason}`)

  const body = JSON.stringify(payload)
  let response: Response
  try {
    response = await deps.fetch(target.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
        'x-poa-event': eventType,
        'x-poa-delivery': deliveryId,
        'x-poa-timestamp': String(Math.floor(Date.now() / 1000)),
        'x-poa-signature': signWebhookBody(secret, body),
      },
      body,
      // A redirect could point anywhere, including past the SSRF guard; a 3xx counts as a failure.
      redirect: 'manual',
      signal: AbortSignal.timeout(deps.config.webhookTimeoutMs),
    })
  } catch (error) {
    return transient(describeFetchError(error, deps.config.webhookTimeoutMs))
  }
  await response.body?.cancel().catch(() => {})
  if (response.status >= 200 && response.status < 300) return sent
  return transient(`HTTP ${response.status}`)
}

const describeFetchError = (error: unknown, timeoutMs: number): string => {
  if (!(error instanceof Error)) return String(error)
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return `timed out after ${timeoutMs} ms`
  const cause = (error as Error & { cause?: { code?: string; message?: string } }).cause
  return `network error: ${cause?.code ?? cause?.message ?? error.message}`
}
