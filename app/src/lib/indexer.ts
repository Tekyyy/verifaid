import type {
  CustodyMode,
  DeliveryView,
  DepositAddressView,
  DonationTrack,
  DonorTrace,
  ImpactSummary,
  NeedDetail,
  NeedSort,
  NeedSummary,
  ProgramMembersResponse,
  ProgramView,
  ProviderView,
  SupplierApplicationView,
  SupplierDetail,
  SupplierView,
  TimelineEvent,
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
 * From the browser the calls go through `/api/indexer/*` on this origin, so the dashboard does not depend on
 * the indexer sending CORS headers; on the server they go straight to it.
 */
const baseUrl = (): string => (typeof window === 'undefined' ? indexerUrl : '/api/indexer')

const get = async <T>(path: string): Promise<Result<T>> => {
  const url = `${baseUrl()}${path}`
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

export interface NeedFilters {
  status?: string
  category?: string
  region?: string
  /** ISO 3166-1 alpha-2, e.g. "ES". */
  country?: string
  custody?: CustodyMode
  /** Only needs that accept money right now. */
  open?: boolean
  sort?: NeedSort
}

const query = (filters: NeedFilters): string => {
  const params = new URLSearchParams()
  if (filters.status) params.set('status', filters.status)
  if (filters.category) params.set('category', filters.category)
  if (filters.region) params.set('region', filters.region)
  if (filters.country) params.set('country', filters.country)
  if (filters.custody) params.set('custody', filters.custody)
  if (filters.open) params.set('open', 'true')
  if (filters.sort) params.set('sort', filters.sort)
  const serialized = params.toString()
  return serialized ? `?${serialized}` : ''
}

export const getNeeds = async (filters: NeedFilters = {}): Promise<Result<NeedSummary[]>> =>
  useFixtures
    ? { ok: true, data: fixtures.filterNeeds(filters) }
    : get<NeedSummary[]>(`/needs${query(filters)}`)

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

export const getProgramMembers = async (programId: string): Promise<Result<ProgramMembersResponse>> =>
  useFixtures
    ? fixtures.programMembers(programId)
    : get<ProgramMembersResponse>(`/programs/${encodeURIComponent(programId)}/members`)

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

export const getProviders = async (): Promise<Result<ProviderView[]>> =>
  useFixtures ? { ok: true, data: fixtures.providers } : get<ProviderView[]>('/providers')

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

/** Same-origin RSS feeds (proxied), so a reader subscribes to this site rather than to the indexer's port. */
export const needFeedPath = (id: string): string => `/api/indexer/needs/${encodeURIComponent(id)}/feed.rss`
export const donationFeedPath = (ref: string): string =>
  `/api/indexer/donations/${encodeURIComponent(ref)}/feed.rss`
