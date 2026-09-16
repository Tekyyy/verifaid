import { createHmac } from 'node:crypto'
import { signWebhookBody, verifyWebhookSignature } from '@poa/shared'
import { describe, expect, it } from 'vitest'
import { contextFromTrack, milestoneDelivery, subscribedDelivery, webhookDelivery } from '../src/alerts.js'
import {
  adminTokenMatches,
  alertWebhookSecret,
  hashToken,
  newUnsubscribeToken,
  newWebhookSecret,
  openEmail,
  openWebhookSecret,
  sealEmail,
  sealWebhookSecret,
  subscriptionTokenMatches,
  unsubscribeLinkToken,
} from '../src/crypto.js'
import { createEmailDriver } from '../src/email.js'
import { endpointMatches } from '../src/events.js'
import { redactedText, UNSUBSCRIBE_URL_PLACEHOLDER } from '../src/messages.js'
import { newMilestones, trackProgress } from '../src/stages.js'
import { checkWebhookUrl, isPrivateAddress } from '../src/urls.js'
import { testConfig } from './helpers/env.js'
import { eventFixture, needFixture, trackFixture } from './helpers/fakes.js'

const kek = Buffer.alloc(32, 7)

describe('webhook signatures', () => {
  const body = JSON.stringify({ id: 'evt-1-0', type: 'Donated', needId: '5' })

  it('uses the documented format: sha256=<64 hex chars> of the raw body', () => {
    const secret = newWebhookSecret()
    const signature = signWebhookBody(secret, body)
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/)
    // Exactly what the README tells integrators to compute.
    expect(signature).toBe(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`)
  })

  it('verifies only the exact body under the exact secret', () => {
    const secret = newWebhookSecret()
    const signature = signWebhookBody(secret, body)
    expect(verifyWebhookSignature(secret, body, signature)).toBe(true)
    expect(verifyWebhookSignature(secret, `${body} `, signature)).toBe(false)
    expect(verifyWebhookSignature(newWebhookSecret(), body, signature)).toBe(false)
    expect(verifyWebhookSignature(secret, body, undefined)).toBe(false)
  })

  it('derives a distinct, stable alert-webhook secret per subscription', () => {
    expect(alertWebhookSecret(kek, 'sub-a')).toBe(alertWebhookSecret(kek, 'sub-a'))
    expect(alertWebhookSecret(kek, 'sub-a')).not.toBe(alertWebhookSecret(kek, 'sub-b'))
    expect(alertWebhookSecret(Buffer.alloc(32, 8), 'sub-a')).not.toBe(alertWebhookSecret(kek, 'sub-a'))
  })
})

describe('SSRF guard', () => {
  const dev = { production: false }
  const prod = { production: true }

  it('allows plain http only for localhost in development', () => {
    expect(checkWebhookUrl('http://localhost:9000/hook', dev).ok).toBe(true)
    expect(checkWebhookUrl('http://127.0.0.1:9000/hook', dev).ok).toBe(true)
    expect(checkWebhookUrl('http://example.org/hook', dev).ok).toBe(false)
    expect(checkWebhookUrl('http://localhost:9000/hook', prod).ok).toBe(false)
    expect(checkWebhookUrl('ftp://example.org/hook', dev).ok).toBe(false)
    expect(checkWebhookUrl('not a url', dev).ok).toBe(false)
  })

  it('accepts public https URLs and normalises them', () => {
    expect(checkWebhookUrl('https://Hooks.Example.org/poa?x=1', prod)).toEqual({
      ok: true,
      url: 'https://hooks.example.org/poa?x=1',
    })
    expect(checkWebhookUrl('https://93.184.216.34/hook', prod).ok).toBe(true)
  })

  it.each([
    'https://10.0.0.8/hook',
    'https://172.20.1.1/hook',
    'https://192.168.1.10/hook',
    'https://127.0.0.1/hook',
    'https://169.254.169.254/latest/meta-data',
    'https://100.64.0.1/hook',
    'https://0.0.0.0/hook',
    'https://[::1]/hook',
    'https://[fe80::1]/hook',
    'https://[fd00::1]/hook',
    'https://[::ffff:127.0.0.1]/hook',
    'https://[::ffff:a9fe:a9fe]/hook',
    'https://2130706433/hook',
    'https://0x7f.1/hook',
    'https://localhost/hook',
    'https://api.localhost/hook',
  ])('refuses %s in production', (url) => {
    expect(checkWebhookUrl(url, prod).ok).toBe(false)
  })

  it('refuses credentials in the URL', () => {
    expect(checkWebhookUrl('https://user:pass@example.org/hook', prod).ok).toBe(false)
  })

  it('classifies IP literals', () => {
    expect(isPrivateAddress('10.1.2.3')).toBe(true)
    expect(isPrivateAddress('[::1]')).toBe(true)
    expect(isPrivateAddress('8.8.8.8')).toBe(false)
    expect(isPrivateAddress('2606:4700::1111')).toBe(false)
    expect(isPrivateAddress('example.org')).toBe(false)
  })
})

describe('stored secrets', () => {
  it('envelope-encrypts an email bound to its subscription id', () => {
    const sealed = sealEmail(kek, 'sub-1', 'donor@example.org')
    expect(Buffer.from(sealed.emailCiphertext).includes('donor@example.org')).toBe(false)
    expect(openEmail(kek, { id: 'sub-1', ...sealed })).toBe('donor@example.org')
    // Moved onto another row, the ciphertext no longer opens.
    expect(() => openEmail(kek, { id: 'sub-2', ...sealed })).toThrow()
    // Crypto-shredded: without the wrapped key there is nothing to open.
    expect(
      openEmail(kek, { id: 'sub-1', emailCiphertext: sealed.emailCiphertext, wrappedDek: null }),
    ).toBeNull()
  })

  it('seals integrator secrets bound to the endpoint id', () => {
    const secret = newWebhookSecret()
    const sealed = sealWebhookSecret(kek, 'ep-1', secret)
    expect(openWebhookSecret(kek, 'ep-1', sealed)).toBe(secret)
    expect(() => openWebhookSecret(kek, 'ep-2', sealed)).toThrow()
  })

  it('stores only a hash of the unsubscribe token and accepts the derived link token', () => {
    const token = newUnsubscribeToken()
    expect(Buffer.from(token, 'base64url')).toHaveLength(32)
    const subscription = { id: 'sub-1', tokenHash: hashToken(token) }
    expect(subscription.tokenHash).not.toContain(token)
    expect(subscriptionTokenMatches(kek, subscription, token)).toBe(true)
    expect(subscriptionTokenMatches(kek, subscription, unsubscribeLinkToken(kek, 'sub-1'))).toBe(true)
    expect(subscriptionTokenMatches(kek, subscription, unsubscribeLinkToken(kek, 'sub-2'))).toBe(false)
    expect(subscriptionTokenMatches(kek, subscription, newUnsubscribeToken())).toBe(false)
  })

  it('compares admin tokens without length leaks', () => {
    expect(adminTokenMatches('a-long-admin-token-123', 'a-long-admin-token-123')).toBe(true)
    expect(adminTokenMatches('a-long-admin-token-123', 'a-long-admin-token-12')).toBe(false)
  })
})

describe('rendered payloads', () => {
  const config = testConfig()
  const need = needFixture('5')
  const target = { id: 'sub-1', trackingRef: '12', needId: '5', channel: 'EMAIL' }

  it('puts the tracking link and an unsubscribe placeholder in emails, never a token', () => {
    const context = contextFromTrack(trackFixture('12', need, ['Verified']))
    const row = subscribedDelivery(config, target, context)
    const payload = row.payload as { subject: string; text: string }
    expect(row.dedupeKey).toBe('ALERT_EMAIL:sub-1:Subscribed')
    expect(payload.subject).toContain('donation #12')
    expect(payload.text).toContain('https://app.example/en/track/12')
    expect(payload.text).toContain(UNSUBSCRIBE_URL_PLACEHOLDER)
    expect(payload.text).toContain('Current stage: Verified')
    expect(redactedText(config, 'sub-1', payload.text)).toContain(
      'https://notifier.example/unsubscribe?id=sub-1&token=[redacted]',
    )
  })

  it('keys alert rows by kind, subscription and milestone', () => {
    const track = trackFixture('12', need, ['Verified', 'Funded'])
    const [milestone] = newMilestones(['Verified'], trackProgress(track))
    if (!milestone) throw new Error('expected a milestone')
    const now = new Date('2026-01-01T00:00:00Z')
    const email = milestoneDelivery(config, target, contextFromTrack(track), milestone, now)
    expect(email.dedupeKey).toBe('ALERT_EMAIL:sub-1:Funded')
    const hook = milestoneDelivery(
      config,
      { ...target, channel: 'WEBHOOK' },
      contextFromTrack(track),
      milestone,
      now,
    )
    expect(hook.dedupeKey).toBe('ALERT_WEBHOOK:sub-1:Funded')
    expect(hook.payload).toMatchObject({
      type: 'alert.stage',
      stage: 'Funded',
      currentStage: 'Funded',
      trackingRef: '12',
      trackUrl: 'https://app.example/en/track/12',
      donation: { amount: '25000000' },
    })
    expect(JSON.stringify(hook.payload)).not.toContain('0x00000000000000000000000000000000000000c3')
  })

  it('links need-level subscriptions to the need page', () => {
    const context = contextFromTrack(trackFixture('12', need, ['Verified']))
    const row = subscribedDelivery(config, { id: 'sub-2', trackingRef: null, needId: '5' }, context)
    expect((row.payload as { text: string }).text).toContain('https://app.example/en/needs/5')
  })

  it('forwards timeline events to integrators unchanged', () => {
    const event = eventFixture('5', 10, 1, 'FundingClosed')
    expect(webhookDelivery('ep-1', event)).toEqual({
      dedupeKey: 'WEBHOOK:ep-1:evt-10-1',
      kind: 'WEBHOOK',
      endpointId: 'ep-1',
      payload: event,
    })
  })
})

describe('endpoint filters', () => {
  const event = { needId: '5', type: 'Donated' as const }
  it('matches on need (or all needs) and event type (or all types)', () => {
    expect(endpointMatches({ needId: null, eventTypes: [] }, event)).toBe(true)
    expect(endpointMatches({ needId: '5', eventTypes: ['Donated'] }, event)).toBe(true)
    expect(endpointMatches({ needId: '6', eventTypes: [] }, event)).toBe(false)
    expect(endpointMatches({ needId: null, eventTypes: ['Refunded'] }, event)).toBe(false)
  })
})

describe('email driver selection', () => {
  it('uses the outbox unless both the API URL and key are set', () => {
    expect(createEmailDriver(testConfig()).name).toBe('outbox')
    expect(createEmailDriver(testConfig({ EMAIL_API_URL: 'https://api.resend.com/emails' })).name).toBe(
      'outbox',
    )
    expect(
      createEmailDriver(testConfig({ EMAIL_API_URL: 'https://api.resend.com/emails', EMAIL_API_KEY: 're_x' }))
        .name,
    ).toBe('api')
  })
})
