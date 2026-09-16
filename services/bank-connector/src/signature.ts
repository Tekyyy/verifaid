import { verifyWebhookSignature } from '@poa/shared'
import type { FastifyRequest } from 'fastify'
import type { BankConfig } from './config.js'
import { unauthorized } from './errors.js'

export const SIGNATURE_HEADER = 'x-poa-signature'

/** The exact bytes the caller sent, captured by the body parsers in app.ts. */
export type RequestWithRawBody = FastifyRequest & { rawBody?: string }

/**
 * `preValidation` hook for every bank-to-provider endpoint (SEPA webhook, CSV import, settlements): an HMAC over
 * the raw bytes, not over a re-serialised object, which would not round-trip. Runs before validation so an
 * unsigned request never reaches the schema, let alone the chain.
 */
export const verifySignature = async (config: BankConfig, request: FastifyRequest): Promise<void> => {
  if (!config.webhookSecret) {
    request.log.warn(
      { event: 'webhook.unauthenticated', route: request.routeOptions.url },
      'BANK_WEBHOOK_SECRET is unset: accepting an unsigned bank request — development only',
    )
    return
  }
  const header = request.headers[SIGNATURE_HEADER]
  const signature = Array.isArray(header) ? header[0] : header
  const rawBody = (request as RequestWithRawBody).rawBody ?? ''
  if (!verifyWebhookSignature(config.webhookSecret, rawBody, signature)) {
    request.log.warn(
      { event: 'webhook.rejected', route: request.routeOptions.url },
      'signature did not verify',
    )
    throw unauthorized(`Missing or invalid ${SIGNATURE_HEADER}`, 'BAD_SIGNATURE')
  }
}
