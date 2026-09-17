import { randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import { buildCdpJwt } from './cdpJwt'

/**
 * Coinbase Onramp (Coinbase-hosted), server side. Checked against docs.cdp.coinbase.com in September 2026:
 *
 * - Session token: `POST /onramp/v1/token` with `addresses` (+ optional `assets`, `clientIp`) → `{ token }`.
 *   Single use, valid five minutes, and mandatory for every Onramp URL.
 * - URL: `https://pay.coinbase.com/buy/select-asset?sessionToken=…` with `defaultNetwork`, `defaultAsset`,
 *   `presetFiatAmount` (EUR supported), `fiatCurrency`, `partnerUserRef` (< 50 characters) and `redirectUrl`
 *   (ignored unless its domain is on the project's allowlist in the CDP portal).
 * - Status: `GET /onramp/v1/buy/user/{partnerUserRef}/transactions` → `transactions[]` whose `status` is
 *   `ONRAMP_TRANSACTION_STATUS_{CREATED,IN_PROGRESS,SUCCESS,FAILED}`; amounts are `{ value, currency }` objects.
 *
 * The USDC always goes to the donor's own wallet: Coinbase's terms require the buyer to own the destination, which
 * is why the donation itself is a separate transaction the donor signs afterwards.
 */

const HOST = 'api.developer.coinbase.com'
const TIMEOUT_MS = 10_000

export interface CdpCredentials {
  keyId: string
  keySecret: string
}

/** Server-only credentials; null when either variable is unset (routes answer 503 and never echo them). */
export const cdpCredentials = (): CdpCredentials | null => {
  const keyId = process.env.CDP_API_KEY_ID?.trim()
  const keySecret = process.env.CDP_API_KEY_SECRET?.trim()
  return keyId && keySecret ? { keyId, keySecret } : null
}

/** A fresh reference for one purchase, well under Coinbase's 50-character limit and meaningless on its own. */
export const newPartnerUserRef = (): string => `poa-${randomBytes(16).toString('hex')}`

export const PARTNER_USER_REF = /^poa-[0-9a-f]{32}$/

export class OnrampApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

const cdpFetch = async (
  credentials: CdpCredentials,
  method: 'GET' | 'POST',
  path: string,
  query: string,
  body?: unknown,
): Promise<unknown> => {
  let jwt: string
  try {
    jwt = buildCdpJwt({ ...credentials, method, host: HOST, path })
  } catch {
    // The parser's message never contains the secret, but an operator only needs to know it is unusable.
    throw new OnrampApiError(503, 'CDP API key secret is malformed')
  }
  let response: Response
  try {
    response = await fetch(`https://${HOST}${path}${query}`, {
      method,
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new OnrampApiError(502, 'Coinbase Onramp is unreachable')
  }
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!response.ok) {
    const detail = typeof payload?.message === 'string' ? payload.message.slice(0, 200) : response.statusText
    throw new OnrampApiError(response.status >= 500 ? 502 : response.status, `Coinbase Onramp: ${detail}`)
  }
  return payload
}

/** A public IP only: private and loopback addresses would tell Coinbase nothing about the buyer. */
const usableClientIp = (ip: string | null): string | null => {
  if (!ip || !isIP(ip)) return null
  return /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80:)/i.test(ip) ? null : ip
}

export const createSessionToken = async (
  credentials: CdpCredentials,
  input: { address: string; clientIp: string | null },
): Promise<string> => {
  const clientIp = usableClientIp(input.clientIp)
  const payload = (await cdpFetch(credentials, 'POST', '/onramp/v1/token', '', {
    addresses: [{ address: input.address, blockchains: ['base'] }],
    assets: ['USDC'],
    ...(clientIp ? { clientIp } : {}),
  })) as { token?: unknown } | null
  if (typeof payload?.token !== 'string' || payload.token.length === 0) {
    throw new OnrampApiError(502, 'Coinbase Onramp returned no session token')
  }
  return payload.token
}

export const onrampUrl = (input: {
  sessionToken: string
  amountEur: string
  partnerUserRef: string
  redirectUrl: string
}): string => {
  const params = new URLSearchParams({
    sessionToken: input.sessionToken,
    defaultNetwork: 'base',
    defaultAsset: 'USDC',
    presetFiatAmount: input.amountEur,
    fiatCurrency: 'EUR',
    partnerUserRef: input.partnerUserRef,
    redirectUrl: input.redirectUrl,
  })
  return `https://pay.coinbase.com/buy/select-asset?${params.toString()}`
}

export type OnrampStatus = 'none' | 'pending' | 'success' | 'failed'

export interface OnrampTransaction {
  status: OnrampStatus
  /** Decimal string in `purchaseCurrency` (USDC), as Coinbase reports it. */
  purchaseAmount: string | null
  purchaseCurrency: string | null
  txHash: string | null
  walletAddress: string | null
  createdAt: string | null
}

const STATUS: Record<string, OnrampStatus> = {
  ONRAMP_TRANSACTION_STATUS_CREATED: 'pending',
  ONRAMP_TRANSACTION_STATUS_IN_PROGRESS: 'pending',
  ONRAMP_TRANSACTION_STATUS_SUCCESS: 'success',
  ONRAMP_TRANSACTION_STATUS_FAILED: 'failed',
}

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

/** Every purchase made under one partner reference, newest status first as Coinbase returns them. */
export const buyTransactions = async (
  credentials: CdpCredentials,
  partnerUserRef: string,
): Promise<OnrampTransaction[]> => {
  const payload = (await cdpFetch(
    credentials,
    'GET',
    `/onramp/v1/buy/user/${encodeURIComponent(partnerUserRef)}/transactions`,
    // The guide says `page_size` and defaults it to 1; the OpenAPI spec says `pageSize`. The gateway takes either.
    '?pageSize=20',
  )) as { transactions?: unknown } | null
  const rows = Array.isArray(payload?.transactions) ? (payload.transactions as Record<string, unknown>[]) : []
  return rows.map((row) => {
    const purchase = (row.purchase_amount ?? {}) as { value?: unknown; currency?: unknown }
    return {
      status: STATUS[String(row.status)] ?? 'pending',
      purchaseAmount: text(purchase.value),
      purchaseCurrency: text(purchase.currency),
      txHash: text(row.tx_hash),
      walletAddress: text(row.wallet_address),
      createdAt: text(row.created_at),
    }
  })
}

/** One status for the panel: any success wins, then anything still moving, then a failure. */
export const summarize = (transactions: OnrampTransaction[]): OnrampStatus => {
  if (transactions.some((row) => row.status === 'success')) return 'success'
  if (transactions.some((row) => row.status === 'pending')) return 'pending'
  return transactions.length > 0 ? 'failed' : 'none'
}
