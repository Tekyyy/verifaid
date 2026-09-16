import type { FastifyRequest, onRequestHookHandler } from 'fastify'
import type { NotifierConfig } from './config.js'
import { adminTokenMatches } from './crypto.js'
import { unauthorized, unavailable } from './errors.js'

export const bearerToken = (header: string | undefined): string | null => {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '')
  return match?.[1] ?? null
}

/**
 * Guards the integrator admin API. Runs on `onRequest`, before the body is parsed or validated, so an
 * unauthenticated caller learns nothing about the schema. Without `NOTIFIER_ADMIN_TOKEN` the API is off (503)
 * rather than open.
 */
export const requireAdmin =
  (config: Pick<NotifierConfig, 'adminToken'>): onRequestHookHandler =>
  async (request: FastifyRequest) => {
    if (!config.adminToken) {
      throw unavailable('The admin API is disabled: set NOTIFIER_ADMIN_TOKEN to enable it', 'ADMIN_DISABLED')
    }
    const token = bearerToken(request.headers.authorization)
    if (!token || !adminTokenMatches(config.adminToken, token)) {
      throw unauthorized('A valid admin bearer token is required')
    }
  }
