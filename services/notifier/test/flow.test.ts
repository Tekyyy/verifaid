import { verifyWebhookSignature } from '@poa/shared'
import { prisma } from '@poa/shared/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { hashToken } from '../src/crypto.js'
import { createDeps, type NotifierDeps } from '../src/deps.js'
import { apiDriver } from '../src/email.js'
import { BACKOFF_MS, dispatchDue, MAX_ATTEMPTS } from '../src/worker/dispatcher.js'
import { pollOnce, readCursor } from '../src/worker/poller.js'
import {
  adminHeaders,
  POSTGRES_SKIP,
  postgresAvailable,
  resetNotifierTables,
  testConfig,
} from './helpers/env.js'
import {
  eventFixture,
  type FakeIndexer,
  type FakeReceiver,
  needFixture,
  startFakeIndexer,
  startReceiver,
  trackFixture,
} from './helpers/fakes.js'

/**
 * The whole alert and webhook path against a real Postgres, a fake indexer and fake receivers:
 * subscribe → poll → dispatch → unsubscribe (crypto-shred), plus idempotency and retry/backoff.
 * The tests run in order and share state, like the lifecycle they describe.
 */

const hasPostgres = await postgresAvailable()
if (!hasPostgres) process.stderr.write(`\n[notifier] SKIPPING database tests: ${POSTGRES_SKIP}\n\n`)

const EMAIL = 'donor@example.org'

interface Created {
  id: string
  unsubscribeToken: string
  needId: string
  trackingRef: string | null
  channel: string
  webhookSecret?: string
}

describe.skipIf(!hasPostgres)('notifier lifecycle (Postgres)', () => {
  let indexer: FakeIndexer
  let receiver: FakeReceiver
  let failing: FakeReceiver
  let mailApi: FakeReceiver
  let deps: NotifierDeps
  let app: FastifyInstance

  let emailSub: Created
  let needSub: Created
  let endpointForNeed: { id: string; secret: string }
  let endpointForType: { id: string; secret: string }
  let enqueued = 0

  const poll = (pageLimit = 200) => pollOnce({ config: deps.config, indexer: deps.indexer, pageLimit })
  const deliveries = () => prisma().notificationDelivery.findMany({ orderBy: { createdAt: 'asc' } })
  // Row defaults come from the database clock, which may run slightly ahead of this process (Docker VM).
  const soon = () => new Date(Date.now() + 60_000)

  beforeAll(async () => {
    await resetNotifierTables()
    ;[indexer, receiver, failing, mailApi] = await Promise.all([
      startFakeIndexer(),
      startReceiver(200),
      startReceiver(500),
      startReceiver(200),
    ])
    const need = needFixture('7', { status: 'Funding' })
    indexer.needs.set('7', need)
    indexer.tracks.set('12', trackFixture('12', need, ['Verified']))

    const config = testConfig({ INDEXER_URL: indexer.url })
    deps = createDeps(config, {
      email: apiDriver({
        url: `${mailApi.url}/emails`,
        apiKey: 're_test',
        from: 'alerts@poa.test',
        timeoutMs: 3000,
      }),
      onEnqueued: () => {
        enqueued += 1
      },
    })
    app = await buildApp(deps)
  })

  afterAll(async () => {
    await app?.close()
    await Promise.all([indexer?.close(), receiver?.close(), failing?.close(), mailApi?.close()])
  })

  it('subscribes an email to a tracking reference, encrypted, with the current stage recorded', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/subscriptions',
      payload: { trackingRef: '12', channel: 'email', email: EMAIL },
    })
    expect(response.statusCode, response.body).toBe(201)
    emailSub = response.json<Created>()
    expect(emailSub).toMatchObject({ needId: '7', trackingRef: '12', channel: 'email' })
    expect(emailSub.webhookSecret).toBeUndefined()
    expect(Buffer.from(emailSub.unsubscribeToken, 'base64url')).toHaveLength(32)
    expect(enqueued).toBe(1)

    const row = await prisma().alertSubscription.findUniqueOrThrow({ where: { id: emailSub.id } })
    expect(row.channel).toBe('EMAIL')
    expect(row.notifiedStages).toEqual(['Verified'])
    expect(row.tokenHash).toBe(hashToken(emailSub.unsubscribeToken))
    expect(row.wrappedDek).not.toBeNull()
    expect(Buffer.from(row.emailCiphertext ?? []).includes(EMAIL)).toBe(false)

    const confirmation = await prisma().notificationDelivery.findUniqueOrThrow({
      where: { dedupeKey: `ALERT_EMAIL:${emailSub.id}:Subscribed` },
    })
    expect(confirmation.status).toBe('PENDING')
    expect(JSON.stringify(confirmation.payload)).not.toContain(EMAIL)
  })

  it('subscribes a webhook to a whole need and returns its signing secret once', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/subscriptions',
      payload: { needId: '7', channel: 'webhook', webhookUrl: `${receiver.url}/alerts` },
    })
    expect(response.statusCode, response.body).toBe(201)
    needSub = response.json<Created>()
    expect(needSub).toMatchObject({ needId: '7', trackingRef: null, channel: 'webhook' })
    expect(needSub.webhookSecret).toMatch(/^whsec_/)
    const row = await prisma().alertSubscription.findUniqueOrThrow({ where: { id: needSub.id } })
    expect(row.notifiedStages).toEqual(['Verified'])
    expect(row.emailCiphertext).toBeNull()
  })

  it('registers integrator webhooks (admin)', async () => {
    const create = async (payload: object) => {
      const response = await app.inject({
        method: 'POST',
        url: '/webhooks',
        headers: adminHeaders(),
        payload,
      })
      expect(response.statusCode, response.body).toBe(201)
      return response.json<{ id: string; secret: string; needId: string | null; eventTypes: string[] }>()
    }
    endpointForNeed = await create({ url: `${receiver.url}/integrator`, needId: '7' })
    endpointForType = await create({ url: `${receiver.url}/finalized`, eventTypes: ['DeliveryApproved'] })
    expect(endpointForNeed.secret).toMatch(/^whsec_/)

    const stored = await prisma().webhookEndpoint.findUniqueOrThrow({ where: { id: endpointForNeed.id } })
    expect(Buffer.from(stored.sealedSecret).includes(endpointForNeed.secret)).toBe(false)
  })

  it('turns timeline events into webhook and alert deliveries, fetching each donation once per poll', async () => {
    const need = needFixture('7', {
      status: 'InDelivery',
      settlements: [
        {
          uid: `0x${'11'.repeat(32)}`,
          needId: '7',
          trancheIndex: 0,
          attester: '0x00000000000000000000000000000000000000d4',
          gross: '100',
          fee: '1',
          net: '99',
          supplierRefHash: `0x${'22'.repeat(32)}`,
          fxRef: `0x${'33'.repeat(32)}`,
          txHash: `0x${'44'.repeat(32)}`,
          timestamp: 1_700_000_500,
        },
      ],
    })
    indexer.needs.set('7', need)
    indexer.tracks.set('12', trackFixture('12', need, ['Verified', 'Funded', 'Settled']))
    indexer.events.push(
      eventFixture('7', 10, 0, 'FundingClosed'),
      eventFixture('7', 10, 1, 'SettlementRecorded'),
    )
    const trackHitsBefore = indexer.hits.get('/donations/12') ?? 0

    // Page size 1 forces two pages, so the per-poll cache is exercised across pages.
    const result = await poll(1)
    expect(result).toMatchObject({ pages: 2, events: 2, cursor: '10:1' })
    expect(indexer.hits.get('/donations/12')).toBe(trackHitsBefore + 1)
    expect(await readCursor()).toBe('10:1')

    const rows = await deliveries()
    const keys = rows.map((row) => row.dedupeKey).sort()
    expect(keys).toEqual(
      [
        `ALERT_EMAIL:${emailSub.id}:Subscribed`,
        `ALERT_EMAIL:${emailSub.id}:Funded`,
        `ALERT_EMAIL:${emailSub.id}:Settled`,
        `ALERT_WEBHOOK:${needSub.id}:Funded`,
        `ALERT_WEBHOOK:${needSub.id}:Settled`,
        `WEBHOOK:${endpointForNeed.id}:evt-10-0`,
        `WEBHOOK:${endpointForNeed.id}:evt-10-1`,
      ].sort(),
    )
    const sub = await prisma().alertSubscription.findUniqueOrThrow({ where: { id: emailSub.id } })
    expect(sub.notifiedStages).toEqual(['Verified', 'Funded', 'Settled'])
  })

  it('creates no duplicates when the poller runs again, even from a lost cursor', async () => {
    const before = (await deliveries()).length
    expect((await poll()).deliveriesCreated).toBe(0)

    // Simulate a crash that lost the cursor and the notified stages: only the dedupe keys stand in the way.
    await prisma().notifierCursor.deleteMany({})
    await prisma().alertSubscription.updateMany({ data: { notifiedStages: ['Verified'] } })
    const rerun = await poll()
    expect(rerun.events).toBe(2)
    expect(rerun.deliveriesCreated).toBe(0)
    expect(await deliveries()).toHaveLength(before)
    expect(await readCursor()).toBe('10:1')
  })

  it('dispatches signed webhooks and emails, and keeps addresses out of the outbox', async () => {
    const result = await dispatchDue(deps, { now: soon() })
    expect(result).toEqual({ sent: 7, retrying: 0, failed: 0 })
    expect((await deliveries()).every((row) => row.status === 'SENT' && row.attempts === 1)).toBe(true)

    // Integrator webhooks: the raw event, signed with the endpoint secret.
    const integrator = receiver.requests.filter((request) => request.path === '/integrator')
    expect(integrator).toHaveLength(2)
    for (const request of integrator) {
      expect(request.headers['content-type']).toBe('application/json')
      expect(request.headers['user-agent']).toBe('ProofOfAid-Notifier/1')
      expect(request.headers['x-poa-delivery']).toMatch(/^[0-9a-f-]{36}$/)
      expect(Number(request.headers['x-poa-timestamp'])).toBeGreaterThan(1_700_000_000)
      const signature = request.headers['x-poa-signature'] as string
      expect(verifyWebhookSignature(endpointForNeed.secret, request.body, signature)).toBe(true)
      expect(verifyWebhookSignature(endpointForType.secret, request.body, signature)).toBe(false)
      const event = JSON.parse(request.body) as { type: string; needId: string }
      expect(request.headers['x-poa-event']).toBe(event.type)
      expect(event.needId).toBe('7')
    }

    // Alert webhooks: signed with the per-subscription secret returned at subscription time.
    const alerts = receiver.requests.filter((request) => request.path === '/alerts')
    expect(alerts).toHaveLength(2)
    for (const request of alerts) {
      expect(
        verifyWebhookSignature(
          needSub.webhookSecret ?? '',
          request.body,
          request.headers['x-poa-signature'] as string,
        ),
      ).toBe(true)
      expect(request.headers['x-poa-event']).toBe('alert.stage')
      expect(JSON.parse(request.body)).toMatchObject({
        subscriptionId: needSub.id,
        needId: '7',
        trackingRef: null,
      })
    }
    expect(receiver.requests.some((request) => request.path === '/finalized')).toBe(false)

    // Emails: decrypted only for the provider call, with a working unsubscribe link filled in.
    expect(mailApi.requests).toHaveLength(3)
    for (const request of mailApi.requests) {
      expect(request.headers.authorization).toBe('Bearer re_test')
      const mail = JSON.parse(request.body) as { from: string; to: string; subject: string; text: string }
      expect(mail).toMatchObject({ from: 'alerts@poa.test', to: EMAIL })
      expect(mail.text).toContain('https://app.example/en/track/12')
      expect(mail.text).not.toContain('{{unsubscribe_url}}')
      expect(mail.text).toContain(`https://notifier.example/unsubscribe?id=${emailSub.id}&token=`)
    }
    const subjects = mailApi.requests.map(
      (request) => (JSON.parse(request.body) as { subject: string }).subject,
    )
    expect(subjects).toEqual(
      expect.arrayContaining([expect.stringContaining('Funded'), expect.stringContaining('Settled')]),
    )

    const outbox = await app.inject({ method: 'GET', url: '/outbox?limit=10', headers: adminHeaders() })
    expect(outbox.statusCode).toBe(200)
    const body = outbox.json<{
      driver: string
      deliveries: { status: string; payload: { text: string } }[]
    }>()
    expect(body.driver).toBe('api')
    expect(body.deliveries).toHaveLength(3)
    expect(outbox.body).not.toContain(EMAIL)
    expect(body.deliveries[0]?.payload.text).toContain('token=[redacted]')
  })

  it('unsubscribes with the bearer token and crypto-shreds the address', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/subscriptions',
      payload: { trackingRef: '12', channel: 'email', email: 'second@example.org' },
    })
    expect(created.statusCode).toBe(201)
    const second = created.json<Created>()

    const wrong = await app.inject({
      method: 'DELETE',
      url: `/subscriptions/${second.id}`,
      headers: { authorization: `Bearer ${emailSub.unsubscribeToken}` },
    })
    expect(wrong.statusCode).toBe(401)

    const unknown = await app.inject({
      method: 'DELETE',
      url: '/subscriptions/00000000-0000-4000-8000-000000000000',
      headers: { authorization: `Bearer ${second.unsubscribeToken}` },
    })
    expect(unknown.statusCode).toBe(404)

    for (let i = 0; i < 2; i++) {
      const response = await app.inject({
        method: 'DELETE',
        url: `/subscriptions/${second.id}`,
        headers: { authorization: `Bearer ${second.unsubscribeToken}` },
      })
      expect(response.statusCode).toBe(204)
    }

    const row = await prisma().alertSubscription.findUniqueOrThrow({ where: { id: second.id } })
    expect(row.unsubscribedAt).not.toBeNull()
    expect(row.wrappedDek).toBeNull()
    expect(row.emailCiphertext).toBeNull()

    // Its confirmation email was still queued: it is cancelled, never sent.
    const confirmation = await prisma().notificationDelivery.findUniqueOrThrow({
      where: { dedupeKey: `ALERT_EMAIL:${second.id}:Subscribed` },
    })
    expect(confirmation).toMatchObject({ status: 'FAILED', lastError: 'subscription cancelled' })
    const mailsBefore = mailApi.requests.length
    await dispatchDue(deps, { now: soon() })
    expect(mailApi.requests).toHaveLength(mailsBefore)
  })

  it('unsubscribes from the email link, and a shredded subscription gets no further alerts', async () => {
    const mail = JSON.parse(mailApi.requests[0]?.body ?? '{}') as { text: string }
    const link = /https:\/\/notifier\.example(\/unsubscribe\?\S+)/.exec(mail.text)?.[1]
    expect(link).toBeDefined()

    const tampered = await app.inject({ method: 'GET', url: `${link}x` })
    expect(tampered.statusCode).toBe(404)
    expect(tampered.body).toContain('Link not valid')

    const response = await app.inject({ method: 'GET', url: link ?? '' })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/html')
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body).toContain('You are unsubscribed')

    const row = await prisma().alertSubscription.findUniqueOrThrow({ where: { id: emailSub.id } })
    expect(row.wrappedDek).toBeNull()
    expect(row.emailCiphertext).toBeNull()

    const need = needFixture('7', { status: 'InDelivery' })
    indexer.tracks.set('12', trackFixture('12', need, ['Verified', 'Funded', 'Settled', 'Delivered']))
    indexer.events.push(eventFixture('7', 11, 0, 'DeliveryApproved'))
    await poll()
    const keys = (await deliveries()).map((delivery) => delivery.dedupeKey)
    expect(keys).not.toContain(`ALERT_EMAIL:${emailSub.id}:Delivered`)
    // The type-filtered integrator endpoint does get this one.
    expect(keys).toContain(`WEBHOOK:${endpointForType.id}:evt-11-0`)
    await dispatchDue(deps, { now: soon() })
    expect(receiver.requests.filter((request) => request.path === '/finalized')).toHaveLength(1)
  })

  it('retries a failing receiver with exponential backoff, then gives up', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/webhooks',
      headers: adminHeaders(),
      payload: { url: `${failing.url}/hook`, needId: '9' },
    })
    expect(created.statusCode).toBe(201)
    const endpointId = created.json<{ id: string }>().id
    indexer.events.push(eventFixture('9', 12, 0, 'NeedCreated'))
    await poll()
    const dedupeKey = `WEBHOOK:${endpointId}:evt-12-0`

    let now = soon()
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const result = await dispatchDue(deps, { now })
      const row = await prisma().notificationDelivery.findUniqueOrThrow({ where: { dedupeKey } })
      expect(row.attempts).toBe(attempt)
      expect(row.lastError).toBe('HTTP 500')
      expect(failing.requests).toHaveLength(attempt)

      if (attempt === MAX_ATTEMPTS) {
        expect(result).toEqual({ sent: 0, retrying: 0, failed: 1 })
        expect(row.status).toBe('FAILED')
        break
      }
      const delay = BACKOFF_MS[attempt - 1] ?? 0
      expect(result).toEqual({ sent: 0, retrying: 1, failed: 0 })
      expect(row.status).toBe('PENDING')
      expect(row.nextAttemptAt.getTime()).toBe(now.getTime() + delay)

      // Not due yet a second before the backoff elapses.
      await dispatchDue(deps, { now: new Date(now.getTime() + delay - 1000) })
      expect(failing.requests).toHaveLength(attempt)
      now = new Date(now.getTime() + delay)
    }

    // A later poll or dispatch never resurrects it.
    await dispatchDue(deps, { now: new Date(now.getTime() + 7 * 24 * 3600_000) })
    expect(failing.requests).toHaveLength(MAX_ATTEMPTS)
  })

  it('lists and deletes integrator webhooks (admin)', async () => {
    const list = await app.inject({ method: 'GET', url: '/webhooks', headers: adminHeaders() })
    expect(list.statusCode).toBe(200)
    const { webhooks } = list.json<{
      webhooks: { id: string; deliveries: { pending: number; sent: number; failed: number } }[]
    }>()
    expect(webhooks).toHaveLength(3)
    // Two events from the first poll plus the DeliveryApproved one.
    expect(webhooks.find((hook) => hook.id === endpointForNeed.id)?.deliveries).toEqual({
      pending: 0,
      sent: 3,
      failed: 0,
    })
    expect(JSON.stringify(webhooks)).not.toContain(endpointForNeed.secret)

    const removed = await app.inject({
      method: 'DELETE',
      url: `/webhooks/${endpointForNeed.id}`,
      headers: adminHeaders(),
    })
    expect(removed.statusCode).toBe(204)
    const again = await app.inject({
      method: 'DELETE',
      url: `/webhooks/${endpointForNeed.id}`,
      headers: adminHeaders(),
    })
    expect(again.statusCode).toBe(404)
    expect(await prisma().notificationDelivery.count({ where: { endpointId: endpointForNeed.id } })).toBe(0)
  })
})
