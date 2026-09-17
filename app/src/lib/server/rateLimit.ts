/**
 * Sliding-window request counters for the route handlers that spend relayer gas or call a paid API.
 *
 * Per process only: a multi-instance deployment needs a shared store. They are a brake on abuse, not the security
 * boundary — the contracts decide what is allowed, and every relayed call is simulated before it is sent.
 */

const MAX_KEYS = 10_000

export const createRateLimiter = ({ windowMs, max }: { windowMs: number; max: number }) => {
  const hits = new Map<string, number[]>()

  /** Records one attempt for `key` and returns true when it is over the limit. */
  return (key: string): boolean => {
    const now = Date.now()
    if (hits.size > MAX_KEYS) {
      for (const [stale, times] of hits) {
        if (times.every((at) => now - at >= windowMs)) hits.delete(stale)
      }
    }
    const recent = (hits.get(key) ?? []).filter((at) => now - at < windowMs)
    recent.push(now)
    hits.set(key, recent)
    return recent.length > max
  }
}

/** Best-effort client address behind a proxy. Spoofable, which is why limits are also kept per resource. */
export const clientIp = (request: Request): string =>
  request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
  request.headers.get('x-real-ip')?.trim() ||
  'unknown'
