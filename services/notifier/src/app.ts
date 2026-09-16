import cors from '@fastify/cors'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import Fastify, { type FastifyInstance } from 'fastify'
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod'
import { z } from 'zod'
import { loadConfig } from './config.js'
import { createDeps, type NotifierDeps } from './deps.js'
import { registerErrorHandler } from './errors.js'
import { registerSubscriptionRoutes } from './routes/subscriptions.js'
import { registerWebhookRoutes } from './routes/webhooks.js'

/** Unsubscribe links carry a token in the query string; it must not end up in the request log. */
const redactUrl = (url: string): string => url.replace(/([?&]token=)[^&]*/gi, '$1[redacted]')

/**
 * Builds the server without listening, so tests can drive it through `fastify.inject()`. The worker is not part
 * of the app: `server.ts` starts it next to the listener, and tests call the poller and dispatcher directly.
 */
export const buildApp = async (deps: NotifierDeps = createDeps(loadConfig())): Promise<FastifyInstance> => {
  const { config } = deps
  const app = Fastify({
    logger: {
      level: config.logLevel,
      serializers: {
        req: (request) => ({ method: request.method, url: redactUrl(request.url), id: request.id }),
        res: (reply) => ({ statusCode: reply.statusCode }),
      },
    },
  })

  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  registerErrorHandler(app)

  await app.register(cors, {
    origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(','),
    methods: ['GET', 'POST', 'DELETE'],
  })
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Proof of Aid — notifier',
        description:
          'Donation alerts keyed by a public tracking reference (no accounts; email addresses envelope-encrypted ' +
          'and crypto-shredded on unsubscribe) and HMAC-signed outbound webhooks on timeline events for integrators.',
        version: '0.1.0',
      },
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    },
    transform: jsonSchemaTransform,
  })
  await app.register(swaggerUi, { routePrefix: '/docs' })

  if (deps.kekSource === 'file-created') {
    app.log.warn(
      { path: config.kekPath },
      'created a new notifier KEK — back it up, stored email addresses are unreadable without it',
    )
  }
  if (!config.adminToken) app.log.warn('NOTIFIER_ADMIN_TOKEN is unset: the webhook admin API is disabled')
  if (deps.email.name === 'outbox') {
    app.log.warn('EMAIL_API_URL / EMAIL_API_KEY unset: alert emails go to the outbox only (GET /outbox)')
  }
  if (config.production && config.publicBaseUrlIsDefault) {
    app.log.warn('PUBLIC_BASE_URL is unset: unsubscribe links in emails point at localhost')
  }

  app.withTypeProvider<ZodTypeProvider>().get(
    '/health',
    {
      schema: {
        tags: ['ops'],
        summary: 'Liveness and wiring check',
        response: {
          200: z.object({
            status: z.literal('ok'),
            service: z.literal('notifier'),
            indexerUrl: z.string(),
            worker: z.boolean(),
            emailDriver: z.enum(['api', 'outbox']),
            adminApi: z.boolean(),
            production: z.boolean(),
          }),
        },
      },
    },
    async () => ({
      status: 'ok' as const,
      service: 'notifier' as const,
      indexerUrl: config.indexerUrl,
      worker: config.workerEnabled,
      emailDriver: deps.email.name,
      adminApi: Boolean(config.adminToken),
      production: config.production,
    }),
  )

  registerSubscriptionRoutes(app, deps)
  registerWebhookRoutes(app, deps)
  return app
}
