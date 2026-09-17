import { randomUUID } from 'node:crypto'
import { trackingRefKind } from '@poa/shared'
import { prisma } from '@poa/shared/db'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { bearerToken } from '../auth.js'
import { type Channel, contextFromNeed, contextFromTrack, subscribedDelivery } from '../alerts.js'
import {
  alertWebhookSecret,
  hashToken,
  newUnsubscribeToken,
  sealEmail,
  subscriptionTokenMatches,
} from '../crypto.js'
import type { NotifierDeps } from '../deps.js'
import { badGateway, badRequest, ErrorBody, HttpError, notFound, unauthorized } from '../errors.js'
import { IndexerError } from '../indexer.js'
import type { AlertContext } from '../messages.js'
import { reachedNames } from '../stages.js'
import { checkWebhookUrl } from '../urls.js'

/**
 * Donation alerts without accounts. Whoever subscribes gets an unsubscribe token once; the service keeps its
 * sha256. An email address is envelope-encrypted under a fresh data key, and unsubscribing destroys that key and
 * the ciphertext (crypto-shredding), so the address cannot be recovered afterwards, not even from a backup that
 * lacks the KEK.
 */

const SubscribeBody = z
  .object({
    trackingRef: z.string().trim().min(1).max(80).optional(),
    needId: z
      .string()
      .regex(/^[0-9]{1,78}$/, 'must be a decimal need id')
      .optional(),
    channel: z.enum(['email', 'webhook']),
    email: z.string().trim().max(254).optional(),
    webhookUrl: z.string().trim().max(2048).optional(),
  })
  .superRefine((body, ctx) => {
    if (Boolean(body.trackingRef) === Boolean(body.needId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['trackingRef'],
        message: 'give exactly one of trackingRef or needId',
      })
    }
    if (body.channel === 'email' && !z.email().safeParse(body.email).success) {
      ctx.addIssue({ code: 'custom', path: ['email'], message: 'a valid email address is required' })
    }
    if (body.channel === 'webhook' && !body.webhookUrl) {
      ctx.addIssue({ code: 'custom', path: ['webhookUrl'], message: 'webhookUrl is required' })
    }
  })

const SubscriptionCreated = z.object({
  id: z.string(),
  unsubscribeToken: z.string(),
  needId: z.string(),
  trackingRef: z.string().nullable(),
  channel: z.enum(['email', 'webhook']),
  webhookSecret: z
    .string()
    .optional()
    .describe('Webhook channel only, shown once: verify `x-poa-signature` with it.'),
})

export const registerSubscriptionRoutes = (app: FastifyInstance, deps: NotifierDeps): void => {
  const typed = app.withTypeProvider<ZodTypeProvider>()

  typed.post(
    '/subscriptions',
    {
      schema: {
        tags: ['alerts'],
        summary: 'Subscribe to alerts for a donation or a need',
        description: [
          'Keyed by a tracking reference (receipt id or 0x payment reference) or a need id; no account.',
          'Stages already reached are recorded as notified, so only new ones are sent. An email subscription',
          'gets one confirmation message. Keep `unsubscribeToken`: it is the only way to cancel via the API.',
        ].join(' '),
        body: SubscribeBody,
        response: { 201: SubscriptionCreated, 400: ErrorBody, 404: ErrorBody, 502: ErrorBody },
      },
    },
    async (request, reply) => {
      const body = request.body
      if (body.trackingRef && !trackingRefKind(body.trackingRef)) {
        throw badRequest(
          'trackingRef must be a receipt id or a 0x-prefixed 32-byte payment reference',
          'INVALID_TRACKING_REF',
        )
      }
      let webhookUrl: string | null = null
      if (body.channel === 'webhook') {
        const check = checkWebhookUrl(body.webhookUrl ?? '', { production: deps.config.production })
        if (!check.ok) throw badRequest(`webhookUrl refused: ${check.reason}`, 'INVALID_WEBHOOK_URL')
        webhookUrl = check.url
      }

      const trackingRef = body.trackingRef ? canonicalRef(body.trackingRef) : null
      const context = await resolveTarget(deps, trackingRef, body.needId)
      const needId = context.need.id

      const id = randomUUID()
      const unsubscribeToken = newUnsubscribeToken()
      const channel: Channel = body.channel === 'email' ? 'EMAIL' : 'WEBHOOK'
      const target = { id, trackingRef, needId }

      await prisma().$transaction(async (tx) => {
        await tx.alertSubscription.create({
          data: {
            id,
            trackingRef,
            needId,
            channel,
            webhookUrl,
            tokenHash: hashToken(unsubscribeToken),
            notifiedStages: reachedNames(context.progress),
            ...(channel === 'EMAIL' && body.email ? sealEmail(deps.kek, id, body.email) : {}),
          },
        })
        if (channel === 'EMAIL') {
          await tx.notificationDelivery.create({ data: subscribedDelivery(deps.config, target, context) })
        }
      })
      if (channel === 'EMAIL') deps.onEnqueued()

      request.log.info({ subscriptionId: id, needId, channel }, 'alert subscription created')
      reply.status(201)
      return {
        id,
        unsubscribeToken,
        needId,
        trackingRef,
        channel: body.channel,
        ...(channel === 'WEBHOOK' ? { webhookSecret: alertWebhookSecret(deps.kek, id) } : {}),
      }
    },
  )

  typed.delete(
    '/subscriptions/:id',
    {
      schema: {
        tags: ['alerts'],
        summary: 'Unsubscribe and destroy the stored address',
        description:
          'Requires `authorization: Bearer <unsubscribeToken>`. Destroys the data key and the ciphertext of the ' +
          'email address and cancels queued alerts. Idempotent.',
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string().min(1).max(64) }),
        response: { 204: z.null().describe('Unsubscribed'), 401: ErrorBody, 404: ErrorBody },
      },
    },
    async (request, reply) => {
      const token = bearerToken(request.headers.authorization)
      if (!token) throw unauthorized('Send the unsubscribe token as a bearer token')
      await unsubscribe(deps, request.params.id, token)
      request.log.info({ subscriptionId: request.params.id }, 'alert subscription cancelled')
      reply.status(204).send(null)
    },
  )

  typed.get(
    '/unsubscribe',
    {
      schema: {
        tags: ['alerts'],
        summary: 'One-click unsubscribe from an email link',
        description: 'Same effect as `DELETE /subscriptions/:id`; answers with a small HTML page.',
        querystring: z.object({ id: z.string().max(64).optional(), token: z.string().max(200).optional() }),
      },
    },
    async (request, reply) => {
      const { id, token } = request.query
      try {
        if (!id || !token) throw notFound('missing id or token')
        await unsubscribe(deps, id, token)
      } catch (error) {
        if (error instanceof HttpError && (error.statusCode === 404 || error.statusCode === 401)) {
          return sendPage(reply, 404, 'Link not valid', INVALID_LINK_TEXT)
        }
        throw error
      }
      request.log.info({ subscriptionId: id }, 'alert subscription cancelled from email link')
      return sendPage(reply, 200, 'You are unsubscribed', UNSUBSCRIBED_TEXT)
    },
  )
}

/** Payment refs and deposit addresses are hex: one spelling, so the poller's per-reference batching sees one key. */
const canonicalRef = (ref: string): string => (trackingRefKind(ref) === 'receipt' ? ref : ref.toLowerCase())

const resolveTarget = async (
  deps: NotifierDeps,
  trackingRef: string | null,
  needId: string | undefined,
): Promise<AlertContext> => {
  try {
    if (trackingRef) {
      const track = await deps.indexer.donation(trackingRef)
      if (!track) throw notFound('No donation with that tracking reference', 'UNKNOWN_TRACKING_REF')
      return contextFromTrack(track)
    }
    const need = await deps.indexer.need(needId ?? '')
    if (!need) throw notFound('No need with that id', 'UNKNOWN_NEED')
    return contextFromNeed(need)
  } catch (error) {
    if (error instanceof IndexerError)
      throw badGateway('The indexer is unavailable; try again shortly', 'INDEXER_UNAVAILABLE')
    throw error
  }
}

const unsubscribe = async (deps: NotifierDeps, id: string, token: string): Promise<void> => {
  const db = prisma()
  const subscription = await db.alertSubscription.findUnique({
    where: { id },
    select: { id: true, tokenHash: true, unsubscribedAt: true },
  })
  if (!subscription) throw notFound('No such subscription', 'UNKNOWN_SUBSCRIPTION')
  if (!subscriptionTokenMatches(deps.kek, subscription, token)) {
    throw unauthorized('The token does not match this subscription', 'INVALID_TOKEN')
  }
  await db.$transaction([
    // Crypto-shredding: without the wrapped data key the address is gone for good; the ciphertext goes too.
    db.alertSubscription.update({
      where: { id },
      data: {
        unsubscribedAt: subscription.unsubscribedAt ?? new Date(),
        wrappedDek: null,
        emailCiphertext: null,
      },
    }),
    db.notificationDelivery.updateMany({
      where: { subscriptionId: id, status: 'PENDING' },
      data: { status: 'FAILED', lastError: 'subscription cancelled' },
    }),
  ])
}

const UNSUBSCRIBED_TEXT =
  'You will not receive any more alerts for this subscription. If it was an email subscription, the address has ' +
  'been destroyed: its encryption key no longer exists.'
const INVALID_LINK_TEXT =
  'This unsubscribe link is not valid. It may be incomplete; copy the whole link and try again.'

const sendPage = (reply: FastifyReply, status: number, title: string, text: string): FastifyReply =>
  reply
    .status(status)
    .header('content-type', 'text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .header('referrer-policy', 'no-referrer')
    .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
    .send(page(title, text))

/** Static text only: nothing from the request is reflected into the page. */
const page = (title: string, text: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Proof of Aid</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5;color:#1a1a1a;background:#fff}h1{font-size:1.4rem}@media (prefers-color-scheme:dark){body{color:#eee;background:#111}}</style>
</head><body><h1>${title}</h1><p>${text}</p><p>Proof of Aid</p></body></html>`
