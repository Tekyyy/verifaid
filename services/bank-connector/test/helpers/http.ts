import { hmac } from '@poa/shared'
import type { FastifyInstance } from 'fastify'
import { WEBHOOK_SECRET } from './env.js'

/** `sha256=<hex>` over the exact bytes sent, as the bank computes it. */
export const sign = (body: string, secret = WEBHOOK_SECRET): string =>
  `sha256=${hmac(secret, body).toString('hex')}`

/** POSTs a JSON body signed with the test secret (or with `signature`, or unsigned when it is null). */
export const postSigned = (app: FastifyInstance, url: string, body: unknown, signature?: string | null) => {
  const raw = JSON.stringify(body)
  const header = signature === null ? undefined : (signature ?? sign(raw))
  return app.inject({
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/json',
      ...(header === undefined ? {} : { 'x-poa-signature': header }),
    },
    payload: raw,
  })
}

export const postCsv = (app: FastifyInstance, csv: string, signature?: string | null) => {
  const header = signature === null ? undefined : (signature ?? sign(csv))
  return app.inject({
    method: 'POST',
    url: '/imports/funding',
    headers: { 'content-type': 'text/csv', ...(header === undefined ? {} : { 'x-poa-signature': header }) },
    payload: csv,
  })
}

export const postCheckout = (app: FastifyInstance, body: unknown, idempotencyKey?: string) =>
  app.inject({
    method: 'POST',
    url: '/checkout/sessions',
    headers: {
      'content-type': 'application/json',
      ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
    },
    payload: JSON.stringify(body),
  })

/** A reference no earlier run of any suite can have used. */
export const uniqueRef = (prefix: string): string =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
