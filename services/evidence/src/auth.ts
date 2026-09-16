import {
  buildSiweMessage,
  createNonce,
  createSessionToken,
  verifySessionToken,
  verifySiwe,
} from '@poa/shared'
import { prisma } from '@poa/shared/db'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { type Address, getAddress, isAddress } from 'viem'
import { parseSiweMessage } from 'viem/siwe'
import { z } from 'zod'
import type { Chain } from './chain.js'
import type { EvidenceConfig } from './config.js'
import { badRequest, unauthorized } from './errors.js'

/**
 * Wallet sign-in (SIWE). The service learns which address the caller controls and nothing else; every role
 * decision is a separate on-chain read. Nonces are single-use rows so a captured signature cannot be replayed.
 */

declare module 'fastify' {
  interface FastifyRequest {
    session?: { address: Address }
  }
}

const NONCE_TTL_MS = 10 * 60 * 1000
const STATEMENT = 'Sign in to the Proof of Aid evidence service.'

const AddressSchema = z.string().refine(isAddress, 'must be a checksummed or lowercase 0x address')

export const requireSession = (config: EvidenceConfig): preHandlerHookHandler => {
  return async (request: FastifyRequest) => {
    const header = request.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      throw unauthorized('Missing bearer token. POST /auth/nonce then /auth/verify first.', 'NO_SESSION')
    }
    const payload = verifySessionToken(config.sessionSecret, header.slice(7).trim())
    if (!payload) throw unauthorized('Session token is invalid or expired', 'INVALID_SESSION')
    request.session = { address: getAddress(payload.address) }
  }
}

export const sessionAddress = (request: FastifyRequest): Address => {
  if (!request.session) throw unauthorized('Session missing', 'NO_SESSION')
  return request.session.address
}

export const registerAuthRoutes = (app: FastifyInstance, config: EvidenceConfig, chain: Chain): void => {
  const typed = app.withTypeProvider<ZodTypeProvider>()
  const uri = `http://${config.siweDomain}`

  typed.post(
    '/auth/nonce',
    {
      schema: {
        tags: ['auth'],
        summary: 'Start a SIWE challenge',
        description: 'Returns a single-use nonce and the exact message the wallet must sign.',
        body: z.object({ address: AddressSchema }),
        response: {
          200: z.object({
            nonce: z.string(),
            message: z.string(),
            domain: z.string(),
            chainId: z.number(),
            expiresAt: z.string(),
          }),
        },
      },
    },
    async (request) => {
      const address = getAddress(request.body.address)
      const nonce = createNonce()
      const expiresAt = new Date(Date.now() + NONCE_TTL_MS)
      await prisma().authNonce.create({ data: { value: nonce, address, expiresAt } })

      const message = buildSiweMessage({
        domain: config.siweDomain,
        uri,
        address,
        chainId: config.chainId,
        nonce,
        statement: STATEMENT,
      })
      return {
        nonce,
        message,
        domain: config.siweDomain,
        chainId: config.chainId,
        expiresAt: expiresAt.toISOString(),
      }
    },
  )

  typed.post(
    '/auth/verify',
    {
      schema: {
        tags: ['auth'],
        summary: 'Exchange a signed SIWE message for a session token',
        body: z.object({ message: z.string().min(1), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }),
        response: {
          200: z.object({ token: z.string(), address: z.string(), expiresAt: z.string() }),
        },
      },
    },
    async (request) => {
      const fields = parseSiweMessage(request.body.message)
      if (!fields.nonce || !fields.address) throw badRequest('SIWE message is missing a nonce or address')

      const record = await prisma().authNonce.findUnique({ where: { value: fields.nonce } })
      if (!record || record.usedAt || record.expiresAt.getTime() < Date.now()) {
        throw unauthorized('Nonce is unknown, already used or expired', 'BAD_NONCE')
      }

      const address = await verifySiwe({
        client: chain.client,
        message: request.body.message,
        signature: request.body.signature as `0x${string}`,
        domain: config.siweDomain,
        nonce: fields.nonce,
      }).catch(() => {
        throw unauthorized('SIWE signature did not verify', 'BAD_SIGNATURE')
      })

      // Single use: mark the nonce spent before issuing anything.
      await prisma().authNonce.update({ where: { value: fields.nonce }, data: { usedAt: new Date() } })

      const token = createSessionToken(config.sessionSecret, getAddress(address), config.sessionTtlSeconds)
      request.log.info({ event: 'auth.session_issued', address }, 'session issued')
      return {
        token,
        address: getAddress(address),
        expiresAt: new Date(Date.now() + config.sessionTtlSeconds * 1000).toISOString(),
      }
    },
  )
}
