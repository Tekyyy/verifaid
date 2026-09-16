import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod'
import { z } from 'zod'

/** Typed error with an HTTP status and a stable machine-readable code, so clients can branch without parsing text. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export const badRequest = (message: string, code = 'BAD_REQUEST'): HttpError =>
  new HttpError(400, code, message)
export const unauthorized = (message: string, code = 'UNAUTHORIZED'): HttpError =>
  new HttpError(401, code, message)
export const notFound = (message: string, code = 'NOT_FOUND'): HttpError => new HttpError(404, code, message)
export const badGateway = (message: string, code = 'BAD_GATEWAY'): HttpError =>
  new HttpError(502, code, message)
export const unavailable = (message: string, code = 'SERVICE_UNAVAILABLE'): HttpError =>
  new HttpError(503, code, message)

/** Response schema of every error; `fields` names the fields that failed validation, never their values. */
export const ErrorBody = z.object({
  error: z.string(),
  message: z.string(),
  fields: z.array(z.string()).optional(),
})

/**
 * Single error shape for every route. Validation problems report which field failed but never echo the value:
 * a subscription request carries an email address.
 */
export const registerErrorHandler = (app: FastifyInstance): void => {
  app.setErrorHandler((error: FastifyError | HttpError, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof HttpError) {
      reply.status(error.statusCode).send({ error: error.code, message: error.message })
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
