/**
 * Browser-side calls to this app's own route handlers, which validate the input and forward it to the notifier,
 * or act through the relayer and Coinbase. The browser never talks to any of them directly.
 */

export type AppResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string }

/** Long enough for a relayed write to be mined (deposit deploys, sweeps, refunds). */
const TIMEOUT_MS = 120_000

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

// ─── v3: card on-ramp and deposit addresses ────────────────────────────────────

const postJson = <T>(path: string, body: unknown): Promise<AppResult<T>> =>
  call<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

export interface OnrampSession {
  /** Coinbase-hosted checkout, single use. */
  url: string
  /** Random reference the status route looks the purchase up by. */
  partnerUserRef: string
}

export const startOnrampSession = (input: {
  address: string
  amountEur: string
  needId: string
  locale: string
}): Promise<AppResult<OnrampSession>> => postJson<OnrampSession>('/api/onramp/session', input)

export type OnrampStatus = 'none' | 'pending' | 'success' | 'failed'

export const onrampStatus = (partnerUserRef: string): Promise<AppResult<{ status: OnrampStatus }>> =>
  call<{ status: OnrampStatus }>(`/api/onramp/status?ref=${encodeURIComponent(partnerUserRef)}`, {
    method: 'GET',
  })

export interface MockOnrampResult {
  txHash: string
  amountEur: string
  eurUsd: string
  rateSource: 'chainlink' | 'fallback'
  feeBps: number
  /** USDC base units. */
  grossUsdc: string
  feeUsdc: string
  usdc: string
}

export const mockOnramp = (input: {
  address: string
  amountEur: string
}): Promise<AppResult<MockOnrampResult>> => postJson<MockOnrampResult>('/api/onramp/mock', input)

/** `ForwarderIntent` as JSON: bigint and bytes as strings. */
export interface IntentJson {
  needId: string
  receiptTo: string
  refundTo: string
  refundSigner: string
  salt: string
}

export const createDepositAddress = (
  intent: IntentJson,
): Promise<AppResult<{ address: string; txHash: string | null }>> =>
  postJson<{ address: string; txHash: string | null }>('/api/deposits', { intent })

export interface SweepResult {
  symbol: string
  token: string
  balance: string
  outcome: 'swept' | 'nothingToSweep' | 'notAccepting' | 'overCostCap' | 'notKeeper' | 'failed'
  txHash: string | null
  deposited: string | null
  error: string | null
}

export const sweepDeposit = (address: string): Promise<AppResult<{ results: SweepResult[] }>> =>
  postJson<{ results: SweepResult[] }>(`/api/deposits/${encodeURIComponent(address)}/sweep`, {})

export const relayDepositRefund = (
  address: string,
  input: { kind: 'leftover' | 'vault'; token?: string; to: string; deadline: string; signature: string },
): Promise<AppResult<{ txHash: string; amount: string; to: string }>> =>
  postJson<{ txHash: string; amount: string; to: string }>(
    `/api/deposits/${encodeURIComponent(address)}/refund`,
    input,
  )
