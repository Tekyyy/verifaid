import { randomUUID } from 'node:crypto'
import { prisma } from '@poa/shared/db'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { requireAdmin } from '../auth.js'
import { newWebhookSecret, sealWebhookSecret } from '../crypto.js'
import type { NotifierDeps } from '../deps.js'
import { badRequest, ErrorBody, notFound } from '../errors.js'
import { TIMELINE_EVENT_TYPES } from '../events.js'
import { redactedText } from '../messages.js'
import { checkWebhookUrl } from '../urls.js'

/**
 * Admin API for integrators (integration levels 2-3): register an HTTPS endpoint, get a signing secret once, and
 * receive every timeline event (optionally one need, optionally some event types) as a signed POST. Plus the
 * outbox, where rendered alert emails can be read in a demo that has no email provider.
 */

const EndpointView = z.object({
  id: z.string(),
  url: z.string(),
  needId: z.string().nullable(),
  eventTypes: z.array(z.string()),
  active: z.boolean(),
  createdAt: z.string(),
  deliveries: z.object({ pending: z.number(), sent: z.number(), failed: z.number() }),
})

const OutboxEntry = z.object({
  id: z.string(),
  subscriptionId: z.string().nullable(),
  status: z.string(),
  attempts: z.number(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  payload: z.object({
    template: z.string(),
    subject: z.string(),
    text: z.string(),
    needId: z.string(),
    trackingRef: z.string().nullable(),
    milestone: z.string().nullable(),
  }),
})

export const registerWebhookRoutes = (app: FastifyInstance, deps: NotifierDeps): void => {
  const typed = app.withTypeProvider<ZodTypeProvider>()
  const onRequest = requireAdmin(deps.config)
  const security = [{ bearerAuth: [] }]

  typed.post(
    '/webhooks',
    {
      onRequest,
      schema: {
        tags: ['admin'],
        summary: 'Register an integrator webhook',
        description: [
          'Timeline events are POSTed as JSON, signed with `x-poa-signature: sha256=<hex HMAC-SHA256 of the raw',
          'body>` under the returned `secret`, which is shown once and stored sealed. `needId` limits delivery to',
          'one need; `eventTypes` to some event types (empty = all).',
        ].join(' '),
        security,
        body: z.object({
          url: z.string().trim().max(2048),
          needId: z
            .string()
            .regex(/^[0-9]{1,78}$/, 'must be a decimal need id')
            .optional(),
          eventTypes: z.array(z.enum(TIMELINE_EVENT_TYPES)).max(TIMELINE_EVENT_TYPES.length).optional(),
        }),
        response: {
          201: z.object({
            id: z.string(),
            url: z.string(),
            needId: z.string().nullable(),
            eventTypes: z.array(z.string()),
            secret: z.string(),
            createdAt: z.string(),
          }),
          400: ErrorBody,
          401: ErrorBody,
          503: ErrorBody,
        },
      },
    },
    async (request, reply) => {
      const check = checkWebhookUrl(request.body.url, { production: deps.config.production })
      if (!check.ok) throw badRequest(`url refused: ${check.reason}`, 'INVALID_WEBHOOK_URL')

      const id = randomUUID()
      const secret = newWebhookSecret()
      const eventTypes = [...new Set(request.body.eventTypes ?? [])]
      const endpoint = await prisma().webhookEndpoint.create({
        data: {
          id,
          url: check.url,
          needId: request.body.needId ?? null,
          eventTypes,
          sealedSecret: sealWebhookSecret(deps.kek, id, secret),
        },
      })
      request.log.info({ endpointId: id, needId: endpoint.needId }, 'webhook endpoint registered')
      reply.status(201)
      return {
        id,
        url: endpoint.url,
        needId: endpoint.needId,
        eventTypes: endpoint.eventTypes,
        secret,
        createdAt: endpoint.createdAt.toISOString(),
      }
    },
  )

  typed.get(
    '/webhooks',
    {
      onRequest,
      schema: {
        tags: ['admin'],
        summary: 'List integrator webhooks with delivery counts',
        security,
        response: { 200: z.object({ webhooks: z.array(EndpointView) }), 401: ErrorBody, 503: ErrorBody },
      },
    },
    async () => {
      const db = prisma()
      const [endpoints, counts] = await Promise.all([
        db.webhookEndpoint.findMany({ orderBy: { createdAt: 'desc' } }),
        db.notificationDelivery.groupBy({
          by: ['endpointId', 'status'],
          where: { kind: 'WEBHOOK', endpointId: { not: null } },
          _count: { _all: true },
        }),
      ])
      const countOf = (endpointId: string, status: string): number =>
        counts.find((row) => row.endpointId === endpointId && row.status === status)?._count._all ?? 0
      return {
        webhooks: endpoints.map((endpoint) => ({
          id: endpoint.id,
          url: endpoint.url,
          needId: endpoint.needId,
          eventTypes: endpoint.eventTypes,
          active: endpoint.active,
          createdAt: endpoint.createdAt.toISOString(),
          deliveries: {
            pending: countOf(endpoint.id, 'PENDING'),
            sent: countOf(endpoint.id, 'SENT'),
            failed: countOf(endpoint.id, 'FAILED'),
          },
        })),
      }
    },
  )

  typed.delete(
    '/webhooks/:id',
    {
      onRequest,
      schema: {
        tags: ['admin'],
        summary: 'Delete an integrator webhook',
        description: 'Deletes the endpoint, its sealed secret and its delivery history.',
        security,
        params: z.object({ id: z.string().min(1).max(64) }),
        response: { 204: z.null().describe('Deleted'), 401: ErrorBody, 404: ErrorBody, 503: ErrorBody },
      },
    },
    async (request, reply) => {
      const { count } = await prisma().webhookEndpoint.deleteMany({ where: { id: request.params.id } })
      if (count === 0) throw notFound('No such webhook endpoint')
      request.log.info({ endpointId: request.params.id }, 'webhook endpoint deleted')
      reply.status(204).send(null)
    },
  )

  typed.get(
    '/outbox',
    {
      onRequest,
      schema: {
        tags: ['admin'],
        summary: 'Recent alert emails, as rendered',
        description:
          'For demos without an email provider. Payloads never contain the recipient address, and the ' +
          'unsubscribe link token is redacted.',
        security,
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
        response: {
          200: z.object({ driver: z.enum(['api', 'outbox']), deliveries: z.array(OutboxEntry) }),
          401: ErrorBody,
          503: ErrorBody,
        },
      },
    },
    async (request) => {
      const rows = await prisma().notificationDelivery.findMany({
        where: { kind: 'ALERT_EMAIL' },
        orderBy: { createdAt: 'desc' },
        take: request.query.limit,
      })
      return {
        driver: deps.email.name,
        deliveries: rows.map((row) => {
          const payload = row.payload as Record<string, unknown>
          const text = typeof payload.text === 'string' ? payload.text : ''
          return {
            id: row.id,
            subscriptionId: row.subscriptionId,
            status: row.status,
            attempts: row.attempts,
            lastError: row.lastError,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
            payload: {
              template: String(payload.template ?? ''),
              subject: String(payload.subject ?? ''),
              text: redactedText(deps.config, row.subscriptionId, text),
              needId: String(payload.needId ?? ''),
              trackingRef: typeof payload.trackingRef === 'string' ? payload.trackingRef : null,
              milestone: typeof payload.milestone === 'string' ? payload.milestone : null,
            },
          }
        }),
      }
    },
  )
}
