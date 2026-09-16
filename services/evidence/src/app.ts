import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
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
import { createChain } from './chain.js'
import { type EvidenceConfig, loadConfig } from './config.js'
import { registerErrorHandler } from './errors.js'
import { createIpfsClient } from './ipfs.js'
import { loadMasterKey } from './keys.js'
import { registerEvidenceRoutes } from './routes.js'

/**
 * Builds the server without listening, so tests can drive it through `fastify.inject()`.
 *
 * Request logging is deliberately narrow: method, url and id only. Bodies here are multipart evidence and
 * decrypted bundles, and spec §8.2 forbids logging either.
 */
export const buildApp = async (config: EvidenceConfig = loadConfig()): Promise<FastifyInstance> => {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      serializers: {
        req: (request) => ({ method: request.method, url: request.url, id: request.id }),
        res: (reply) => ({ statusCode: reply.statusCode }),
      },
    },
    bodyLimit: config.maxFileBytes,
  })

  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  registerErrorHandler(app)

  await app.register(cors, { origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',') })
  await app.register(multipart, {
    limits: { fileSize: config.maxFileBytes, files: config.maxFiles, fields: 8 },
  })
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Proof of Aid — evidence service',
        description:
          'Encrypts delivery evidence, strips image metadata, pins the ciphertext to IPFS and serves it to the ' +
          'NGO, its field agent and independent verifiers. Roles are read from the chain on every request.',
        version: '0.1.0',
      },
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
      },
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

  const ipfs = createIpfsClient(config)

  app.withTypeProvider<ZodTypeProvider>().get(
    '/health',
    {
      schema: {
        tags: ['ops'],
        summary: 'Liveness and wiring check',
        response: {
          200: z.object({
            status: z.literal('ok'),
            service: z.literal('evidence'),
            network: z.string(),
            chainId: z.number(),
            ipfsBackend: z.string(),
            deliveryManager: z.string(),
          }),
        },
      },
    },
    async () => ({
      status: 'ok' as const,
      service: 'evidence' as const,
      network: config.network,
      chainId: config.chainId,
      ipfsBackend: ipfs.backend,
      deliveryManager: chain.deployment.contracts.DeliveryManager,
    }),
  )

  registerAuthRoutes(app, config, chain)
  registerEvidenceRoutes(app, { config, chain, ipfs, masterKey })

  return app
}
