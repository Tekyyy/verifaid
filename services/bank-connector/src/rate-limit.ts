import type { FastifyReply, FastifyRequest } from 'fastify'
import { tooManyRequests } from './errors.js'

/**
 * A small fixed-window limiter for the unauthenticated checkout sandbox. Every accepted request can send up to
 * four transactions from the provider's hot wallet, so an open endpoint needs a brake even in a demo. It is per
 * process and per client IP; behind a load balancer set Fastify's `trustProxy` or put a real limiter in front.
 *
 * Clients get `x-ratelimit-limit` / `x-ratelimit-remaining` on every response and `retry-after` on a 429, so a
 * well-behaved client can pace itself instead of guessing.
 */

const WINDOW_MS = 60_000
const MAX_TRACKED_CLIENTS = 10_000

interface Window {
  startedAt: number
  count: number
}

export const createRateLimiter = (limitPerMinute: number, now: () => number = Date.now) => {
  const windows = new Map<string, Window>()

  const prune = (at: number): void => {
    for (const [key, window] of windows) {
      if (at - window.startedAt >= WINDOW_MS) windows.delete(key)
    }
  }

  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (limitPerMinute <= 0) return
    const at = now()
    if (windows.size >= MAX_TRACKED_CLIENTS) prune(at)

    const key = request.ip
    let window = windows.get(key)
    if (!window || at - window.startedAt >= WINDOW_MS) {
      window = { startedAt: at, count: 0 }
      windows.set(key, window)
    }
    window.count += 1

    reply.header('x-ratelimit-limit', String(limitPerMinute))
    reply.header('x-ratelimit-remaining', String(Math.max(0, limitPerMinute - window.count)))
    if (window.count > limitPerMinute) {
      const retryAfterSeconds = Math.max(1, Math.ceil((window.startedAt + WINDOW_MS - at) / 1000))
      throw tooManyRequests('Too many checkout requests; retry later', retryAfterSeconds)
    }
  }
}
