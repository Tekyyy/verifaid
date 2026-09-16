import cors from '@fastify/cors'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod'
import { z } from 'zod'
import { createChain, isBankPartner } from './chain.js'
import { type BankConfig, loadConfig } from './config.js'
import { registerErrorHandler } from './errors.js'
import { registerRoutes } from './routes.js'

/**
 * Builds the server without listening, so tests can drive it through `fastify.inject()`.
 *
 * The JSON parser keeps the raw body around because the webhook signature covers the exact bytes the bank sent;
 * re-serialising the parsed object would change key order and whitespace and break every signature.
 */
export const buildApp = async (config: BankConfig = loadConfig()): Promise<FastifyInstance> => {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      serializers: {
        req: (request) => ({ method: request.method, url: request.url, id: request.id }),
        res: (reply) => ({ statusCode: reply.statusCode }),
      },
    },
  })

  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  registerErrorHandler(app)

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    ;(request as FastifyRequest & { rawBody?: string }).rawBody = body as string
    try {
      done(null, JSON.parse(body as string))
    } catch {
      done(new Error('Body is not valid JSON'), undefined)
    }
  })

  await app.register(cors, { origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',') })
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Proof of Aid — bank connector',
        description:
          'Mock SEPA integration: converts a settled fiat transfer into a stablecoin deposit on a need’s vault ' +
          'and attests it, keying everything on a salted hash of the payment reference.',
        version: '0.1.0',
      },
    },
    transform: jsonSchemaTransform,
  })
  await app.register(swaggerUi, { routePrefix: '/docs' })

  const chain = createChain(config)
  if (!config.webhookSecret) {
    app.log.warn('BANK_WEBHOOK_SECRET is unset: SEPA webhooks are accepted unsigned — development only')
  }
  if (config.refSaltIsDevDefault) {
    app.log.warn('BANK_REF_SALT is unset: payment reference hashes use a public development salt')
  }
  if (config.partnerKeyIsDevDefault) {
    app.log.warn('BANK_PARTNER_PRIVATE_KEY is unset: using the well-known demo mnemonic — development only')
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
            service: z.literal('bank-connector'),
            network: z.string(),
            chainId: z.number(),
            partner: z.string(),
            partnerRegistered: z.boolean(),
            webhookAuthenticated: z.boolean(),
          }),
        },
      },
    },
    async () => ({
      status: 'ok' as const,
      service: 'bank-connector' as const,
      network: config.network,
      chainId: config.chainId,
      partner: chain.account.address,
      // Surfaced because a partner without the role can accept webhooks but can never settle them.
      partnerRegistered: await isBankPartner(chain, chain.account.address).catch(() => false),
      webhookAuthenticated: Boolean(config.webhookSecret),
    }),
  )

  registerRoutes(app, { config, chain })
  return app
}
