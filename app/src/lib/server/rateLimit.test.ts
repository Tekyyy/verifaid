import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createRateLimiter, redisConfig } from './rateLimit.ts'

const REDIS = { UPSTASH_REDIS_REST_URL: 'https://redis.example', UPSTASH_REDIS_REST_TOKEN: 'secret' }

/** Just enough of Upstash's REST pipeline (INCR, PEXPIRE, GET) to count like the real thing. */
const fakeRedis = () => {
  const store = new Map<string, number>()
  let calls = 0
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls++
    assert.equal(String(url), 'https://redis.example/pipeline')
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer secret')
    const commands = JSON.parse(String(init?.body)) as string[][]
    const replies = commands.map(([command, key]) => {
      if (command === 'INCR') {
        const next = (store.get(key as string) ?? 0) + 1
        store.set(key as string, next)
        return { result: next }
      }
      if (command === 'PEXPIRE') return { result: 1 }
      if (command === 'GET') {
        const value = store.get(key as string)
        return { result: value === undefined ? null : String(value) }
      }
      return { error: `unknown ${command}` }
    })
    return new Response(JSON.stringify(replies))
  }) as typeof fetch
  return { fetchImpl, calls: () => calls }
}

describe('rate limits', () => {
  it('count in memory when no shared store is configured', async () => {
    const limit = createRateLimiter({ name: 't', windowMs: 60_000, max: 2 }, { env: {} })
    assert.equal(await limit('a'), false)
    assert.equal(await limit('a'), false)
    assert.equal(await limit('a'), true, 'the third within the window is over')
    assert.equal(await limit('b'), false, 'another key has its own count')
  })

  it('share one count across server instances through Redis', async () => {
    const redis = fakeRedis()
    const at = () => 1_000_000
    const deps = { env: REDIS, fetchImpl: redis.fetchImpl, now: at }
    // Two instances of the same route, as a serverless host runs them.
    const one = createRateLimiter({ name: 'vote', windowMs: 60_000, max: 2 }, deps)
    const two = createRateLimiter({ name: 'vote', windowMs: 60_000, max: 2 }, deps)
    assert.equal(await one('voter'), false)
    assert.equal(await two('voter'), false)
    assert.equal(await one('voter'), true, 'the second instance saw the first one count')
    assert.equal(redis.calls(), 3, 'one round trip per attempt')
  })

  it('keeps routes apart by name', async () => {
    const redis = fakeRedis()
    const deps = { env: REDIS, fetchImpl: redis.fetchImpl, now: () => 5_000 }
    const votes = createRateLimiter({ name: 'vote', windowMs: 60_000, max: 1 }, deps)
    const uploads = createRateLimiter({ name: 'upload', windowMs: 60_000, max: 1 }, deps)
    assert.equal(await votes('ip'), false)
    assert.equal(await uploads('ip'), false, 'the same key in another route counts separately')
  })

  it('carries the part of the last window that still overlaps into the count', async () => {
    const redis = fakeRedis()
    let clock = 59_000 // near the end of the first window
    const limit = createRateLimiter(
      { name: 'slide', windowMs: 60_000, max: 3 },
      { env: REDIS, fetchImpl: redis.fetchImpl, now: () => clock },
    )
    for (let i = 0; i < 3; i++) assert.equal(await limit('k'), false)
    clock = 61_000 // just into the next window: almost all of the last one still counts
    assert.equal(await limit('k'), true)
    clock = 179_000 // two windows later: nothing left over
    assert.equal(await limit('k'), false)
  })

  it('falls back to its own count when Redis cannot be reached, rather than to no limit', async () => {
    const down = (async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch
    const limit = createRateLimiter(
      { name: 'down', windowMs: 60_000, max: 1 },
      { env: REDIS, fetchImpl: down },
    )
    assert.equal(await limit('k'), false)
    assert.equal(await limit('k'), true)
  })

  it("reads Vercel's Upstash integration names too", () => {
    assert.deepEqual(redisConfig({ KV_REST_API_URL: 'https://kv.example/', KV_REST_API_TOKEN: 't' }), {
      url: 'https://kv.example',
      token: 't',
    })
    assert.equal(
      redisConfig({ UPSTASH_REDIS_REST_URL: 'https://x' }),
      null,
      'a URL without a token is not a store',
    )
  })
})
