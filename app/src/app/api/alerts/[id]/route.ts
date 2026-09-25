import { type NextRequest, NextResponse } from 'next/server'
import { notifierUrl } from '@/lib/config'
import { badRequest, forward } from '@/lib/server/proxy'

/** Removes an alert subscription. The notifier checks the unsubscribe token; this handler only its shape. */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ID = /^[A-Za-z0-9_-]{1,128}$/
const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]{8,512})$/

export async function DELETE(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  if (!ID.test(params.id)) return badRequest('Malformed subscription id.')
  const token = BEARER.exec(request.headers.get('authorization') ?? '')?.[1]
  if (!token) {
    return NextResponse.json(
      { error: 'unauthorized', message: 'Missing unsubscribe token.' },
      { status: 401 },
    )
  }

  const upstream = await forward(`${notifierUrl}/subscriptions/${encodeURIComponent(params.id)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  })
  if (!upstream.ok) return upstream.response
  return new NextResponse(null, { status: 204, headers: { 'cache-control': 'no-store' } })
}
