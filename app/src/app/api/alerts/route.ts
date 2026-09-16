import { trackingRefKind } from '@poa/shared'
import { type NextRequest, NextResponse } from 'next/server'
import { notifierUrl } from '@/lib/config'
import { badRequest, forward, isNeedId, readJson } from '@/lib/server/proxy'

/**
 * Creates an alert subscription with the notifier. Only the documented fields are forwarded, after validation;
 * the email address or webhook URL is never logged here and never stored by this app.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/

const webhookProblem = (value: string): string | null => {
  if (value.length > 2048) return 'webhookUrl is too long.'
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return 'webhookUrl must be an absolute URL.'
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'webhookUrl must use http or https.'
  if (url.username || url.password) return 'webhookUrl must not contain credentials.'
  return null
}

export async function POST(request: NextRequest) {
  const body = await readJson(request)
  if (!body) return badRequest('Body must be a JSON object.')

  const { trackingRef, needId, channel, email, webhookUrl } = body
  if (trackingRef !== undefined && (typeof trackingRef !== 'string' || !trackingRefKind(trackingRef))) {
    return badRequest('trackingRef must be a receipt id or a 0x-prefixed 32-byte payment reference.')
  }
  if (needId !== undefined && !isNeedId(needId))
    return badRequest('needId must be a positive integer string.')
  if (trackingRef === undefined && needId === undefined) return badRequest('Give a trackingRef or a needId.')

  const payload: Record<string, string> = {}
  if (typeof trackingRef === 'string') payload.trackingRef = trackingRef
  if (typeof needId === 'string') payload.needId = needId

  if (channel === 'email') {
    if (typeof email !== 'string' || email.length > 254 || !EMAIL.test(email)) {
      return badRequest('email is not a valid address.')
    }
    payload.channel = channel
    payload.email = email
  } else if (channel === 'webhook') {
    if (typeof webhookUrl !== 'string') return badRequest('webhookUrl is required for the webhook channel.')
    const problem = webhookProblem(webhookUrl)
    if (problem) return badRequest(problem)
    payload.channel = channel
    payload.webhookUrl = webhookUrl
  } else {
    return badRequest('channel must be "email" or "webhook".')
  }

  const upstream = await forward(`${notifierUrl}/subscriptions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!upstream.ok) return upstream.response

  const created = (upstream.body ?? {}) as Record<string, unknown>
  if (typeof created.id !== 'string' || typeof created.unsubscribeToken !== 'string') {
    return NextResponse.json(
      { error: 'upstream_malformed', message: 'The notifier returned no subscription.' },
      { status: 502 },
    )
  }
  return NextResponse.json(
    {
      id: created.id,
      unsubscribeToken: created.unsubscribeToken,
      needId: created.needId ?? null,
      trackingRef: created.trackingRef ?? null,
      channel: created.channel,
      // Webhook subscriptions only: the HMAC key deliveries are signed with (`x-poa-signature`).
      ...(typeof created.webhookSecret === 'string' ? { webhookSecret: created.webhookSecret } : {}),
    },
    // The token and the webhook secret are shown once; no cache in between may keep a copy.
    { status: 201, headers: { 'cache-control': 'no-store' } },
  )
}
