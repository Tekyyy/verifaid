import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { createDeps } from '../src/deps.js'
import { adminHeaders, testConfig } from './helpers/env.js'
import { type FakeIndexer, needFixture, startFakeIndexer, trackFixture } from './helpers/fakes.js'

/**
 * Everything here is rejected before the database is touched (auth, validation, SSRF guard, unknown references),
 * so this suite runs without Postgres.
 */

describe('request guards (no database needed)', () => {
  let indexer: FakeIndexer
  let dev: FastifyInstance
  let production: FastifyInstance
  let noAdmin: FastifyInstance

  beforeAll(async () => {
    indexer = await startFakeIndexer()
    const need = needFixture('7')
    indexer.needs.set('7', need)
    indexer.tracks.set('12', trackFixture('12', need, ['Verified']))
    dev = await buildApp(createDeps(testConfig({ INDEXER_URL: indexer.url })))
    production = await buildApp(createDeps(testConfig({ INDEXER_URL: indexer.url, NODE_ENV: 'production' })))
    noAdmin = await buildApp(createDeps(testConfig({ INDEXER_URL: indexer.url, NOTIFIER_ADMIN_TOKEN: '' })))
  })

  afterAll(async () => {
    await Promise.all([dev?.close(), production?.close(), noAdmin?.close()])
    await indexer?.close()
  })

  const subscribe = (app: FastifyInstance, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/subscriptions', payload })

  it('reports its wiring on /health', async () => {
    const response = await dev.inject({ method: 'GET', url: '/health' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      status: 'ok',
      service: 'notifier',
      emailDriver: 'outbox',
      adminApi: true,
      worker: false,
      production: false,
    })
  })

  it('serves OpenAPI docs', async () => {
    const response = await dev.inject({ method: 'GET', url: '/docs/json' })
    expect(response.statusCode).toBe(200)
    expect(Object.keys(response.json<{ paths: object }>().paths)).toEqual(
      expect.arrayContaining([
        '/subscriptions',
        '/subscriptions/{id}',
        '/unsubscribe',
        '/webhooks',
        '/outbox',
      ]),
    )
  })

  describe('admin API', () => {
    it.each([
      ['POST', '/webhooks'],
      ['GET', '/webhooks'],
      ['DELETE', '/webhooks/abc'],
      ['GET', '/outbox'],
    ] as const)('%s %s answers 503 when NOTIFIER_ADMIN_TOKEN is unset', async (method, url) => {
      const response = await noAdmin.inject({ method, url, headers: adminHeaders() })
      expect(response.statusCode).toBe(503)
      expect(response.json()).toMatchObject({ error: 'ADMIN_DISABLED' })
    })

    it.each([
      ['POST', '/webhooks'],
      ['GET', '/webhooks'],
      ['DELETE', '/webhooks/abc'],
      ['GET', '/outbox'],
    ] as const)('%s %s answers 401 without the right bearer token', async (method, url) => {
      const missing = await dev.inject({ method, url })
      expect(missing.statusCode).toBe(401)
      const wrong = await dev.inject({ method, url, headers: adminHeaders('not-the-admin-token-xyz') })
      expect(wrong.statusCode).toBe(401)
    })

    it('rejects a webhook URL that points at the internal network in production', async () => {
      for (const url of [
        'https://169.254.169.254/latest',
        'https://10.0.0.5/hook',
        'http://localhost:9000/hook',
      ]) {
        const response = await production.inject({
          method: 'POST',
          url: '/webhooks',
          headers: adminHeaders(),
          payload: { url },
        })
        expect(response.statusCode, url).toBe(400)
        expect(response.json()).toMatchObject({ error: 'INVALID_WEBHOOK_URL' })
      }
    })

    it('rejects unknown event types', async () => {
      const response = await dev.inject({
        method: 'POST',
        url: '/webhooks',
        headers: adminHeaders(),
        payload: { url: 'https://hooks.example.org/poa', eventTypes: ['NotAnEvent'] },
      })
      expect(response.statusCode).toBe(400)
    })
  })

  describe('POST /subscriptions', () => {
    it('requires exactly one of trackingRef and needId', async () => {
      const both = await subscribe(dev, {
        trackingRef: '12',
        needId: '7',
        channel: 'email',
        email: 'donor@example.org',
      })
      expect(both.statusCode).toBe(400)
      expect(both.json()).toMatchObject({ error: 'VALIDATION_ERROR', fields: ['trackingRef'] })
      const neither = await subscribe(dev, { channel: 'email', email: 'donor@example.org' })
      expect(neither.statusCode).toBe(400)
    })

    it('validates the email address without echoing it', async () => {
      const response = await subscribe(dev, { trackingRef: '12', channel: 'email', email: 'not-an-address' })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ fields: ['email'] })
      expect(response.body).not.toContain('not-an-address')
    })

    it('rejects a malformed tracking reference', async () => {
      const response = await subscribe(dev, {
        trackingRef: '0x1234',
        channel: 'email',
        email: 'a@example.org',
      })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ error: 'INVALID_TRACKING_REF' })
    })

    it('answers 404 for a reference or need the indexer does not know', async () => {
      const ref = await subscribe(dev, { trackingRef: '999', channel: 'email', email: 'a@example.org' })
      expect(ref.statusCode).toBe(404)
      expect(ref.json()).toMatchObject({ error: 'UNKNOWN_TRACKING_REF' })
      const need = await subscribe(dev, { needId: '404', channel: 'email', email: 'a@example.org' })
      expect(need.statusCode).toBe(404)
      expect(need.json()).toMatchObject({ error: 'UNKNOWN_NEED' })
    })

    it('answers 502 when the indexer is down', async () => {
      indexer.failWith = 500
      try {
        const response = await subscribe(dev, { trackingRef: '12', channel: 'email', email: 'a@example.org' })
        expect(response.statusCode).toBe(502)
        expect(response.json()).toMatchObject({ error: 'INDEXER_UNAVAILABLE' })
      } finally {
        indexer.failWith = null
      }
    })

    it('requires https webhooks, except localhost in development', async () => {
      const plain = await subscribe(dev, {
        trackingRef: '12',
        channel: 'webhook',
        webhookUrl: 'http://hooks.example.org/x',
      })
      expect(plain.statusCode).toBe(400)
      expect(plain.json()).toMatchObject({ error: 'INVALID_WEBHOOK_URL' })

      const missing = await subscribe(dev, { trackingRef: '12', channel: 'webhook' })
      expect(missing.statusCode).toBe(400)
      expect(missing.json()).toMatchObject({ fields: ['webhookUrl'] })
    })

    it('refuses private and link-local webhook targets in production (SSRF guard)', async () => {
      for (const webhookUrl of [
        'https://169.254.169.254/latest/meta-data',
        'https://192.168.0.10/hook',
        'https://[::1]/hook',
        'http://127.0.0.1:8080/hook',
      ]) {
        const response = await subscribe(production, { trackingRef: '12', channel: 'webhook', webhookUrl })
        expect(response.statusCode, webhookUrl).toBe(400)
        expect(response.json()).toMatchObject({ error: 'INVALID_WEBHOOK_URL' })
      }
    })
  })

  it('DELETE /subscriptions/:id requires a bearer token', async () => {
    const response = await dev.inject({ method: 'DELETE', url: '/subscriptions/abc' })
    expect(response.statusCode).toBe(401)
  })

  it('GET /unsubscribe without id or token shows an HTML error page', async () => {
    const response = await dev.inject({ method: 'GET', url: '/unsubscribe' })
    expect(response.statusCode).toBe(404)
    expect(response.headers['content-type']).toContain('text/html')
    expect(response.body).toContain('Link not valid')
  })
})
