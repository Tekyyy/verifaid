/**
 * Request counters for the route handlers that spend relayer gas or call a paid API.
 *
 * With a Redis REST endpoint configured (Upstash, or Vercel's Upstash integration), every server instance counts in
 * the same place, which is what a serverless host needs: each of its instances would otherwise keep a limit of its
 * own. Without one, or when Redis cannot be reached, each process counts in memory. Either way they are a brake on
 * abuse, not the security boundary: the contracts decide what is allowed, and every relayed call is simulated
 * before it is sent.
 */

const MAX_KEYS = 10_000
const REDIS_TIMEOUT_MS = 1_500

type Env = Record<string, string | undefined>

export interface RateLimitDeps {
  env?: Env
  fetchImpl?: typeof fetch
  now?: () => number
}

/** The shared store, if one is configured. Vercel's Upstash integration names it KV_REST_API_*. */
export const redisConfig = (env: Env = process.env): { url: string; token: string } | null => {
  const url = (env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL)?.trim().replace(/\/$/, '')
  const token = (env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN)?.trim()
  return url && token ? { url, token } : null
}

/** Sliding window in memory: exact, but per process. */
const memoryLimiter = (windowMs: number, max: number, now: () => number) => {
  const hits = new Map<string, number[]>()
  return (key: string): boolean => {
    const at = now()
    if (hits.size > MAX_KEYS) {
      for (const [stale, times] of hits) {
        if (times.every((time) => at - time >= windowMs)) hits.delete(stale)
      }
    }
    const recent = (hits.get(key) ?? []).filter((time) => at - time < windowMs)
    recent.push(at)
    hits.set(key, recent)
    return recent.length > max
  }
}

/**
 * One attempt counted in Redis, and the count over the last window estimated from two fixed windows: all of the
 * current one plus the share of the previous one that still overlaps it. One round trip (INCR, PEXPIRE, GET).
 */
const redisCount = async (
  config: { url: string; token: string },
  key: string,
  windowMs: number,
  at: number,
  fetchImpl: typeof fetch,
): Promise<number> => {
  const bucket = Math.floor(at / windowMs)
  const current = `${key}:${bucket}`
  const previous = `${key}:${bucket - 1}`
  const response = await fetchImpl(`${config.url}/pipeline`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
    body: JSON.stringify([
      ['INCR', current],
      ['PEXPIRE', current, String(windowMs * 2)],
      ['GET', previous],
    ]),
    signal: AbortSignal.timeout(REDIS_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`redis ${response.status}`)
  const [incr, , prev] = (await response.json()) as { result?: unknown; error?: string }[]
  if (!incr || incr.error || typeof incr.result !== 'number') throw new Error('redis: unexpected reply')
  const overlap = 1 - (at - bucket * windowMs) / windowMs
  return incr.result + Math.round(Number(prev?.result ?? 0) * overlap)
}

/**
 * `name` keeps one route's counters apart from another's in the shared store. Returns a function that records one
 * attempt for `key` and resolves to true when it is over the limit.
 */
export const createRateLimiter = (
  { name, windowMs, max }: { name: string; windowMs: number; max: number },
  deps: RateLimitDeps = {},
) => {
  const now = deps.now ?? Date.now
  const local = memoryLimiter(windowMs, max, now)
  return async (key: string): Promise<boolean> => {
    const config = redisConfig(deps.env ?? process.env)
    if (!config) return local(key)
    try {
      const count = await redisCount(config, `rl:${name}:${key}`, windowMs, now(), deps.fetchImpl ?? fetch)
      return count > max
    } catch {
      // A limit that cannot be checked falls back to this process's own, rather than to none at all.
      return local(key)
    }
  }
}

/** Best-effort client address behind a proxy. Spoofable, which is why limits are also kept per resource. */
export const clientIp = (request: Request): string =>
  request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
  request.headers.get('x-real-ip')?.trim() ||
  'unknown'
