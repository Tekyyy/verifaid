import type { DonationTrack, NeedDetail, TimelinePage } from '@poa/shared'

/**
 * Typed client for the Ponder indexer's read API. Every call has a timeout, because the worker awaits it inside
 * a poll cycle and a hung socket would otherwise stall every alert and webhook behind it.
 */

export class IndexerError extends Error {
  constructor(
    readonly path: string,
    /** HTTP status, or null when the indexer could not be reached at all. */
    readonly status: number | null,
    message: string,
  ) {
    super(message)
    this.name = 'IndexerError'
  }
}

export interface IndexerClient {
  /** Events strictly after `after` ("<blockNumber>:<logIndex>"), oldest first; from the start when null. */
  timeline(after: string | null, limit?: number): Promise<TimelinePage>
  /** A donation by receipt id or payment reference hash; null when the indexer does not know it. */
  donation(ref: string): Promise<DonationTrack | null>
  need(id: string): Promise<NeedDetail | null>
}

export const TIMELINE_PAGE_LIMIT = 200

export const createIndexerClient = (
  baseUrl: string,
  options: { timeoutMs?: number; fetch?: typeof fetch } = {},
): IndexerClient => {
  const timeoutMs = options.timeoutMs ?? 5000
  const doFetch = options.fetch ?? fetch

  const get = async <T>(path: string, allowNotFound: boolean): Promise<T | null> => {
    let response: Response
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new IndexerError(path, null, `indexer unreachable: ${reason}`)
    }
    if (response.status === 404 && allowNotFound) {
      await response.body?.cancel()
      return null
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new IndexerError(path, response.status, `indexer responded HTTP ${response.status}`)
    }
    try {
      return (await response.json()) as T
    } catch {
      throw new IndexerError(path, response.status, 'indexer returned invalid JSON')
    }
  }

  return {
    timeline: async (after, limit = TIMELINE_PAGE_LIMIT) => {
      const query = new URLSearchParams({ limit: String(limit) })
      if (after) query.set('after', after)
      const page = await get<TimelinePage>(`/timeline?${query}`, false)
      if (!page || !Array.isArray(page.events)) {
        throw new IndexerError('/timeline', 200, 'indexer returned a malformed timeline page')
      }
      return { events: page.events, cursor: page.cursor ?? null }
    },
    donation: (ref) => get<DonationTrack>(`/donations/${encodeURIComponent(ref)}`, true),
    need: (id) => get<NeedDetail>(`/needs/${encodeURIComponent(id)}`, true),
  }
}

export interface Cursor {
  blockNumber: bigint
  logIndex: number
}

/** "<blockNumber>:<logIndex>" → parts; null when malformed. */
export const parseCursor = (cursor: string): Cursor | null => {
  const match = /^(\d{1,20}):(\d{1,9})$/.exec(cursor)
  if (!match?.[1] || !match[2]) return null
  return { blockNumber: BigInt(match[1]), logIndex: Number(match[2]) }
}

export const formatCursor = (cursor: Cursor): string => `${cursor.blockNumber}:${cursor.logIndex}`
