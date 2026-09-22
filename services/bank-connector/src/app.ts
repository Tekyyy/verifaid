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
import { createChain, isBankPartner } from './chain.js'
import { type BankConfig, loadConfig } from './config.js'
import { registerErrorHandler } from './errors.js'
import { registerRoutes } from './routes.js'
import type { RequestWithRawBody } from './signature.js'

/**
 * Builds the server without listening, so tests can drive it through `fastify.inject()`.
 *
 * The JSON and CSV parsers keep the raw body around because the HMAC signature covers the exact bytes the bank
 * sent; re-serialising the parsed object would change key order and whitespace and break every signature.
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
    ;(request as RequestWithRawBody).rawBody = body as string
    try {
      done(null, JSON.parse(body as string))
    } catch {
      done(
        Object.assign(new Error('Body is not valid JSON'), { statusCode: 400, code: 'INVALID_JSON' }),
        undefined,
      )
    }
  })
  // CSV imports: kept as text; the route parses it after the signature has been checked.
  app.addContentTypeParser(
    ['text/csv', 'application/csv'],
    { parseAs: 'string', bodyLimit: config.imports.maxBytes },
    (request, body, done) => {
      ;(request as RequestWithRawBody).rawBody = body as string
      done(null, body)
    },
  )

  await app.register(cors, {
    origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(','),
    // The checkout is called from the donor's browser, which may only read these if they are exposed.
    exposedHeaders: ['idempotent-replayed', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'retry-after'],
  })
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'VerifAid — payment provider (bank connector)',
        description:
          'Mock payment provider. Records fiat funding for a need — from a SEPA webhook, a card/bank checkout ' +
          'sandbox or a CSV import — as a `FundingRecorded` attestation (plus a stablecoin deposit when the need ' +
          'is held on-chain), and reports tranche payouts of off-chain needs as `Settlement` attestations. ' +
          'Everything is keyed on salted hashes of the payment references; amounts are 6-decimal base units.',
        version: '0.2.0',
      },
    },
    transform: jsonSchemaTransform,
  })
  await app.register(swaggerUi, { routePrefix: '/docs' })

  const chain = createChain(config)
  if (!config.webhookSecret) {
    app.log.warn(
      'BANK_WEBHOOK_SECRET is unset: SEPA webhooks, CSV imports and settlements are accepted unsigned — development only',
    )
  }
  if (config.checkout.enabled) {
    app.log.warn(
      'The checkout mock is enabled: anyone can record sandbox funding — never on a production deployment',
    )
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
            checkoutEnabled: z.boolean(),
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
      checkoutEnabled: config.checkout.enabled,
    }),
  )

  registerRoutes(app, { config, chain })
  return app
}
