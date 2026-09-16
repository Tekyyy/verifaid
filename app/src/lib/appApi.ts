import type { CustodyMode } from '@poa/shared'
import type { PaymentMethod } from './fees'

/**
 * Browser-side calls to this app's own route handlers, which validate the input and forward it to the bank
 * connector or the notifier. The browser never talks to either service directly.
 */

export type AppResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string }

const TIMEOUT_MS = 20_000

const call = async <T>(path: string, init: RequestInit): Promise<AppResult<T>> => {
  try {
    const response = await fetch(path, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (response.status === 204) return { ok: true, data: undefined as T }
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
    if (!response.ok) {
      const detail = body.message ?? body.error ?? response.statusText
      return { ok: false, status: response.status, error: String(detail || response.status) }
    }
    return { ok: true, data: body as T }
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

export interface CheckoutSession {
  checkoutId: string
  /** Payment reference hash: the donor's tracking reference. */
  trackingRef: string
  needId: string
  method: PaymentMethod
  currency: 'EUR'
  gross: string
  fee: string
  net: string
  status: string
  custodyMode: CustodyMode
}

export const startCheckout = (
  input: { needId: string; amount: string; method: PaymentMethod },
  idempotencyKey: string,
): Promise<AppResult<CheckoutSession>> =>
  call<CheckoutSession>('/api/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify(input),
  })

export type AlertChannel = 'email' | 'webhook'

export interface AlertSubscription {
  id: string
  unsubscribeToken: string
  needId: string | null
  trackingRef: string | null
  channel: AlertChannel
  /** Webhook channel only, shown once: deliveries carry `x-poa-signature: sha256=<hmac(secret, rawBody)>`. */
  webhookSecret?: string
}

export const subscribeAlerts = (input: {
  trackingRef?: string
  needId?: string
  channel: AlertChannel
  email?: string
  webhookUrl?: string
}): Promise<AppResult<AlertSubscription>> =>
  call<AlertSubscription>('/api/alerts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })

export const unsubscribeAlerts = (id: string, token: string): Promise<AppResult<undefined>> =>
  call<undefined>(`/api/alerts/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  })
