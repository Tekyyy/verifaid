import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod'

/** Typed error with an HTTP status and a stable machine-readable code, so clients can branch without parsing text. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    /** Extra machine-readable fields merged into the response body (never personal data). */
    readonly details?: Record<string, string | number | boolean>,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export const badRequest = (message: string, code = 'BAD_REQUEST'): HttpError =>
  new HttpError(400, code, message)
export const unauthorized = (message: string, code = 'UNAUTHORIZED'): HttpError =>
  new HttpError(401, code, message)
export const forbidden = (message: string, code = 'FORBIDDEN'): HttpError => new HttpError(403, code, message)
export const notFound = (message: string, code = 'NOT_FOUND'): HttpError => new HttpError(404, code, message)
export const conflict = (
  message: string,
  code = 'CONFLICT',
  details?: Record<string, string | number | boolean>,
): HttpError => new HttpError(409, code, message, details)
export const gone = (message: string, code = 'GONE'): HttpError => new HttpError(410, code, message)
export const tooManyRequests = (message: string, retryAfterSeconds: number): HttpError =>
  new HttpError(429, 'RATE_LIMITED', message, { retryAfterSeconds })
export const unavailable = (message: string, code = 'UNAVAILABLE'): HttpError =>
  new HttpError(503, code, message)

/** Short, safe description of any thrown value, for a database column or a per-row import result. */
export const errorSummary = (error: unknown): string => {
  if (error instanceof HttpError) return `${error.code}: ${error.message}`
  if (error instanceof Error) {
    const short = (error as Error & { shortMessage?: string }).shortMessage
    return (short ?? error.message).split('\n')[0]?.slice(0, 300) ?? 'unknown error'
  }
  return 'unknown error'
}

/**
 * Single error shape for every route. Validation problems report which field failed but never echo the value:
 * the body of a request to these services can contain personal data (spec §8.2).
 */
export const registerErrorHandler = (app: FastifyInstance): void => {
  app.setErrorHandler((error: FastifyError | HttpError, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof HttpError) {
      if (error.statusCode === 429 && typeof error.details?.retryAfterSeconds === 'number') {
        reply.header('retry-after', String(error.details.retryAfterSeconds))
      }
      if (error.statusCode >= 500) {
        request.log.error({ code: error.code, route: request.routeOptions.url }, 'request failed')
      }
      reply.status(error.statusCode).send({ error: error.code, message: error.message, ...error.details })
      return
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      reply.status(400).send({
        error: 'VALIDATION_ERROR',
        message: 'Request failed schema validation',
        fields: error.validation.map((issue) => issue.instancePath.replace(/^\//, '')).filter(Boolean),
      })
      return
    }
    const status = typeof error.statusCode === 'number' ? error.statusCode : 500
    if (status >= 500) {
      request.log.error({ err: error.message, route: request.routeOptions.url }, 'request failed')
      reply.status(status).send({ error: 'INTERNAL_ERROR', message: 'Internal server error' })
      return
    }
    reply.status(status).send({ error: error.code ?? 'REQUEST_ERROR', message: error.message })
  })
}
