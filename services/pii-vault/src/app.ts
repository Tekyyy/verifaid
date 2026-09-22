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
import { registerAuthRoutes } from './auth.js'
import { registerBeneficiaryRoutes } from './beneficiaries.js'
import { createChain } from './chain.js'
import { loadConfig, type VaultConfig } from './config.js'
import { registerDossierRoutes } from './dossiers.js'
import { registerErrorHandler } from './errors.js'
import { loadMasterKey } from './keys.js'

/**
 * Builds the server without listening, so tests can drive it through `fastify.inject()`.
 * Request logging records the route and nothing else: every interesting body in this service is a person.
 */
export const buildApp = async (config: VaultConfig = loadConfig()): Promise<FastifyInstance> => {
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

  await app.register(cors, { origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',') })
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'VerifAid — PII vault',
        description:
          'Envelope-encrypted beneficiary records and needs assessments. Personal data never reaches the chain; ' +
          'erasure is performed by destroying a record’s data key.',
        version: '0.1.0',
      },
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    },
    transform: jsonSchemaTransform,
  })
  await app.register(swaggerUi, { routePrefix: '/docs' })

  const chain = createChain(config)
  const { key: masterKey, created } = loadMasterKey(config.kekPath)
  if (created) {
    app.log.warn(
      { path: config.kekPath },
      'created a new master KEK — back it up, records are lost without it',
    )
  }
  if (config.sessionSecretIsEphemeral) {
    app.log.warn('SESSION_SECRET is unset: sessions are signed with a random key and die with this process')
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
            service: z.literal('pii-vault'),
            network: z.string(),
            chainId: z.number(),
            beneficiaryGroups: z.string(),
          }),
        },
      },
    },
    async () => ({
      status: 'ok' as const,
      service: 'pii-vault' as const,
      network: config.network,
      chainId: config.chainId,
      beneficiaryGroups: chain.deployment.contracts.BeneficiaryGroups,
    }),
  )

  registerAuthRoutes(app, config, chain)
  const deps = { config, chain, masterKey }
  registerBeneficiaryRoutes(app, deps)
  registerDossierRoutes(app, deps)

  return app
}
