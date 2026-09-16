import { NextResponse } from 'next/server'
import { getNeed, getTimeline } from '@/lib/indexer'
import { renderNeedReport } from '@/lib/server/report'

/**
 * `GET /api/reports/:needId` — the need's donor / funder / audit report as an A4 PDF. The data comes from the
 * indexer server-side (the same base URL the `/api/indexer` proxy uses); the PDF is rendered on every request
 * so it is never staler than the indexer.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request: Request, { params }: { params: { needId: string } }) {
  const { needId } = params
  if (!/^[1-9]\d{0,18}$/.test(needId)) {
    return NextResponse.json({ error: 'not_found', message: `No need with id ${needId}.` }, { status: 404 })
  }

  const [need, timeline] = await Promise.all([getNeed(needId), getTimeline(needId)])
  if (!need.ok) {
    return need.error.kind === 'http' && need.error.status === 404
      ? NextResponse.json({ error: 'not_found', message: `No need with id ${needId}.` }, { status: 404 })
      : NextResponse.json({ error: 'indexer_unavailable', message: need.error.detail }, { status: 502 })
  }
  // A report with a silently missing timeline would read as "nothing happened", so it is not produced at all.
  if (!timeline.ok) {
    return NextResponse.json(
      { error: 'indexer_unavailable', message: timeline.error.detail },
      { status: 502 },
    )
  }

  const bytes = await renderNeedReport(need.data, timeline.data)
  return new NextResponse(Buffer.from(bytes), {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="proof-of-aid-need-${needId}.pdf"`,
      'cache-control': 'no-store',
    },
  })
}
