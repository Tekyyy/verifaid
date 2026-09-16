import type {
  DeliveryView,
  DonorTrace,
  ImpactSummary,
  NeedDetail,
  NeedSummary,
  ProgramMembersResponse,
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
}

const query = (filters: NeedFilters): string => {
  const params = new URLSearchParams()
  if (filters.status) params.set('status', filters.status)
  if (filters.category) params.set('category', filters.category)
  if (filters.region) params.set('region', filters.region)
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
