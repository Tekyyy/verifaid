import { type NextRequest, NextResponse } from 'next/server'
import { bankConnectorUrl } from '@/lib/config'
import { PAYMENT_METHODS, type PaymentMethod } from '@/lib/fees'
import { badRequest, forward, isNeedId, readJson } from '@/lib/server/proxy'

/**
 * Starts a sandbox checkout with the bank connector (the payment provider). The browser never reaches the
 * connector directly: this handler validates the request, forwards only the documented fields and returns the
 * session, whose `trackingRef` is the payment reference the donor follows on `/track`.
 *
 * No card data exists anywhere in this flow; the connector simulates the payment.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Decimal euros with at most two decimals. */
const AMOUNT = /^\d{1,7}(\.\d{1,2})?$/
const MIN_CENTS = 100
const MAX_CENTS = 100_000_000

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/

const cents = (amount: string): number => Math.round(Number(amount) * 100)

export async function POST(request: NextRequest) {
  const body = await readJson(request)
  if (!body) return badRequest('Body must be a JSON object.')

  const { needId, amount, method, donorReference } = body
  if (!isNeedId(needId)) return badRequest('needId must be a positive integer string.')
  if (typeof amount !== 'string' || !AMOUNT.test(amount)) {
    return badRequest('amount must be a decimal string with at most two decimals, e.g. "25.00".')
  }
  if (cents(amount) < MIN_CENTS || cents(amount) > MAX_CENTS) {
    return badRequest('amount must be between 1.00 and 1000000.00 EUR.')
  }
  if (typeof method !== 'string' || !PAYMENT_METHODS.includes(method as PaymentMethod)) {
    return badRequest('method must be "card" or "bank".')
  }
  if (donorReference !== undefined && (typeof donorReference !== 'string' || donorReference.length > 140)) {
    return badRequest('donorReference must be a string of at most 140 characters.')
  }

  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' }
  const idempotencyKey = request.headers.get('idempotency-key')
  if (idempotencyKey) {
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) return badRequest('Idempotency-Key is malformed.')
    headers['idempotency-key'] = idempotencyKey
  }

  const upstream = await forward(`${bankConnectorUrl}/checkout/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ needId, amount, method, ...(donorReference ? { donorReference } : {}) }),
  })
  if (!upstream.ok) return upstream.response

  const session = (upstream.body ?? {}) as { trackingRef?: unknown }
  if (typeof session.trackingRef !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(session.trackingRef)) {
    return NextResponse.json(
      { error: 'upstream_malformed', message: 'The payment provider returned no tracking reference.' },
      { status: 502 },
    )
  }
  return NextResponse.json(session, { status: 201 })
}
