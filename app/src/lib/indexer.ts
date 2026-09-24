import {
  type BasketDetail,
  type BasketView,
  basketId,
  CATEGORIES,
  type CreditGiftView,
  type DeliveryView,
  type DepositAddressView,
  type DonationTrack,
  type DonorTrace,
  type ImpactSummary,
  MAX_BASKET_NEEDS,
  type NeedDetail,
  type NeedSort,
  type NeedSummary,
  type OpenBountyView,
  type ProgramView,
  type SupplierApplicationView,
  type SupplierDetail,
  type SupplierView,
  type TimelineEvent,
} from '@poa/shared'
import { indexerUrl, useFixtures } from './config'
import * as fixtures from './fixtures'

/**
 * Thin typed client for the Ponder API (services/shared/src/api.ts is the contract).
 * Every call returns a discriminated result instead of throwing: the indexer is a separate process that may
 * legitimately be down, and a dashboard that crashes because of that is worse than one that says so.
 */

export type Result<T> = { ok: true; data: T } | { ok: false; error: IndexerError }

export interface IndexerError {
  kind: 'unreachable' | 'http' | 'malformed'
  status?: number
  detail: string
}

const TIMEOUT_MS = 6_000

/**
 * Server reads are shared for a few seconds: chain data moves in blocks, not in milliseconds, and a page that
 * refetched everything on every navigation felt slow for no gain. The browser always reads fresh, because a
 * donor who just signed a transaction should see it.
 *
 * Never served past that, though. Next's own `revalidate` hands out the expired copy first and refreshes behind
 * it, so a page nobody had opened for an hour showed hour-old data once — a need still "pending" long after its
 * verification, a donation still there after it was withdrawn. Here an expired read is fetched again and waited
 * for, and the cache lives in memory, so a restart (or a redeploy) starts it empty.
 */
const SERVER_TTL_MS = 5_000
const SERVER_CACHE_LIMIT = 500
const serverCache = new Map<string, { at: number; result: Promise<Result<unknown>> }>()

/**
 * From the browser the calls go through `/api/indexer/*` on this origin, so the dashboard does not depend on
 * the indexer sending CORS headers; on the server they go straight to it.
 */
const baseUrl = (): string => (typeof window === 'undefined' ? indexerUrl : '/api/indexer')

const fetchJson = async <T>(url: string): Promise<Result<T>> => {
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) {
      return { ok: false, error: { kind: 'http', status: response.status, detail: response.statusText } }
    }
    return { ok: true, data: (await response.json()) as T }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const kind = detail.includes('JSON') ? 'malformed' : 'unreachable'
    return { ok: false, error: { kind, detail } }
  }
}

const get = async <T>(path: string): Promise<Result<T>> => {
  const url = `${baseUrl()}${path}`
  if (typeof window !== 'undefined') return fetchJson<T>(url)

  const now = Date.now()
  const hit = serverCache.get(url)
  if (hit && now - hit.at < SERVER_TTL_MS) return hit.result as Promise<Result<T>>

  if (serverCache.size >= SERVER_CACHE_LIMIT) {
    for (const [key, entry] of serverCache) if (now - entry.at >= SERVER_TTL_MS) serverCache.delete(key)
  }
  const result = fetchJson<T>(url)
  serverCache.set(url, { at: now, result })
  // A failure is not worth remembering: the next render should ask again.
  void result.then((answer) => {
    if (!answer.ok) serverCache.delete(url)
  })
  return result
}

export interface NeedFilters {
  status?: string
  category?: string
  region?: string
  /** ISO 3166-1 alpha-2, e.g. "ES". */
  country?: string
  /** Only needs that accept money right now. */
  open?: boolean
  sort?: NeedSort
  /** v10: only the needs this beneficiary posted. */
  beneficiary?: string
}

const query = (filters: NeedFilters): string => {
  const params = new URLSearchParams()
  if (filters.status) params.set('status', filters.status)
  if (filters.category) params.set('category', filters.category)
  if (filters.region) params.set('region', filters.region)
  if (filters.country) params.set('country', filters.country)
  if (filters.open) params.set('open', 'true')
  if (filters.sort) params.set('sort', filters.sort)
  if (filters.beneficiary) params.set('beneficiary', filters.beneficiary)
  const serialized = params.toString()
  return serialized ? `?${serialized}` : ''
}

export const getNeeds = async (filters: NeedFilters = {}): Promise<Result<NeedSummary[]>> =>
  useFixtures
    ? { ok: true, data: fixtures.filterNeeds(filters) }
    : get<NeedSummary[]>(`/needs${query(filters)}`)

/** Open reward pots for community proof, with the needs they pay for. The sample data has none. */
export const getOpenBounties = async (): Promise<Result<OpenBountyView[]>> =>
  useFixtures ? { ok: true, data: [] } : get<OpenBountyView[]>('/bounties')

export const getNeed = async (id: string): Promise<Result<NeedDetail>> =>
  useFixtures ? fixtures.needDetail(id) : get<NeedDetail>(`/needs/${encodeURIComponent(id)}`)

export const getTimeline = async (id: string): Promise<Result<TimelineEvent[]>> =>
  useFixtures
    ? { ok: true, data: fixtures.timeline(id) }
    : get<TimelineEvent[]>(`/needs/${encodeURIComponent(id)}/timeline`)

export const getDonorTrace = async (address: string): Promise<Result<DonorTrace>> =>
  useFixtures
    ? { ok: true, data: fixtures.donorTrace(address) }
    : get<DonorTrace>(`/donors/${encodeURIComponent(address)}/trace`)

export const getImpactSummary = async (): Promise<Result<ImpactSummary>> =>
  useFixtures ? { ok: true, data: fixtures.impactSummary } : get<ImpactSummary>('/impact/summary')

export const getDeliveries = async (status?: string): Promise<Result<DeliveryView[]>> =>
  useFixtures
    ? { ok: true, data: fixtures.filterDeliveries(status) }
    : get<DeliveryView[]>(`/deliveries${status ? `?status=${encodeURIComponent(status)}` : ''}`)

/**
 * `ref` is a receipt id ("12"), a payment reference hash ("0x…" 32 bytes) or a deposit address ("0x…" 20 bytes, 404
 * until something was swept from it); the caller validates its shape first.
 */
export const getDonationTrack = async (ref: string): Promise<Result<DonationTrack>> =>
  useFixtures ? fixtures.donationTrack(ref) : get<DonationTrack>(`/donations/${encodeURIComponent(ref)}`)

/** A deposit address with its intent, sweeps and refunds; 404 until it has been deployed. */
export const getDepositAddress = async (address: string): Promise<Result<DepositAddressView>> =>
  useFixtures
    ? fixtures.depositAddress(address)
    : get<DepositAddressView>(`/deposits/${encodeURIComponent(address)}`)

/** Suppliers that asked to be registered: a public queue an admin acts on, not a role. */
export const getSupplierApplications = async (): Promise<Result<SupplierApplicationView[]>> =>
  useFixtures
    ? { ok: true, data: fixtures.supplierApplications }
    : get<SupplierApplicationView[]>('/supplier-applications')

/** The programmes one NGO owns, for the console's "which programme" picker. */
export const getPrograms = async (ngo: string): Promise<Result<ProgramView[]>> =>
  useFixtures
    ? { ok: true, data: fixtures.programs(ngo) }
    : get<ProgramView[]>(`/programs?ngo=${encodeURIComponent(ngo)}`)

/** Registered suppliers (SUPPLIER_ROLE): the vetted providers a vault may pay directly. */
export const getSuppliers = async (): Promise<Result<SupplierView[]>> =>
  useFixtures ? { ok: true, data: fixtures.suppliers } : get<SupplierView[]>('/suppliers')

export const getSupplier = async (address: string): Promise<Result<SupplierDetail>> =>
  useFixtures ? fixtures.supplier(address) : get<SupplierDetail>(`/suppliers/${encodeURIComponent(address)}`)

/**
 * The sample data has no basket gifts, but its needs still make baskets: each category's needs raising money, as the
 * indexer would list them.
 */
const fixtureBasket = (category: string): BasketDetail => {
  const all = fixtures.filterNeeds({ category })
  const open = all
    .filter((need) => need.status === 'Funding' && BigInt(need.fundingGap) > 0n)
    .sort((a, b) => Number(a.id) - Number(b.id))
    .slice(0, MAX_BASKET_NEEDS)
  const sum = (values: string[]) => values.reduce((total, value) => total + BigInt(value), 0n).toString()
  return {
    category,
    id: basketId(category),
    openNeedIds: open.map((need) => need.id),
    stillNeeded: sum(open.map((need) => need.fundingGap)),
    givenThroughBasket: '0',
    gifts: 0,
    needsTotal: all.length,
    needsCompleted: all.filter((need) => need.status === 'Completed').length,
    released: sum(all.map((need) => need.totalReleased)),
    needs: open,
    recentGifts: [],
  }
}

/** One giving basket per category: the needs a gift to it would be split between, and what it has done. */
export const getBaskets = async (): Promise<Result<BasketView[]>> =>
  useFixtures
    ? { ok: true, data: CATEGORIES.map((category) => fixtureBasket(category)) }
    : get<BasketView[]>('/baskets')

/** `category` is the label ("water" or "WATER"); 404 for one that is not a basket. */
export const getBasket = async (category: string): Promise<Result<BasketDetail>> => {
  const label = category.toUpperCase()
  if (useFixtures) {
    return (CATEGORIES as readonly string[]).includes(label)
      ? { ok: true, data: fixtureBasket(label) }
      : { ok: false, error: { kind: 'http', status: 404, detail: 'unknown basket' } }
  }
  return get<BasketDetail>(`/baskets/${encodeURIComponent(label.toLowerCase())}`)
}

/** Where a wallet's reward credit went; the balance itself is read from the contract. */
export const getCredits = async (address: string): Promise<Result<CreditGiftView[]>> =>
  useFixtures ? { ok: true, data: [] } : get<CreditGiftView[]>(`/credits/${encodeURIComponent(address)}`)

/** Same-origin RSS feeds (proxied), so a reader subscribes to this site rather than to the indexer's port. */
export const needFeedPath = (id: string): string => `/api/indexer/needs/${encodeURIComponent(id)}/feed.rss`
export const donationFeedPath = (ref: string): string =>
  `/api/indexer/donations/${encodeURIComponent(ref)}/feed.rss`
