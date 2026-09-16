import { type NextRequest, NextResponse } from 'next/server'
import { indexerUrl } from '@/lib/config'

/**
 * Read-only same-origin proxy for the indexer, so client components can query it without the indexer having
 * to serve CORS headers. Only the documented read endpoints are forwarded: this must not become an open proxy.
 */

export const dynamic = 'force-dynamic'

const ALLOWED = [
  /^needs$/,
  /^needs\/[^/]+$/,
  /^needs\/[^/]+\/timeline$/,
  /^donors\/0x[a-fA-F0-9]{40}\/trace$/,
  /^impact\/summary$/,
  /^programs\/[^/]+\/members$/,
  /^deliveries$/,
]

export async function GET(request: NextRequest, { params }: { params: { path: string[] } }) {
  const path = params.path.join('/')
  if (!ALLOWED.some((pattern) => pattern.test(path))) {
    return NextResponse.json({ error: 'not a proxied endpoint' }, { status: 404 })
  }

  const search = request.nextUrl.search
  try {
    const response = await fetch(`${indexerUrl}/${path}${search}`, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(6_000),
    })
    const body = await response.text()
    return new NextResponse(body, {
      status: response.status,
      headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' },
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'indexer unreachable' },
      { status: 502 },
    )
  }
}
