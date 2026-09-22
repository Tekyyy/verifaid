import { trackingRefKind } from '@poa/shared'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { AutoRefresh } from '@/components/AutoRefresh'
import { TrackWidget } from '@/components/TrackWidget'
import { getDonationTrack } from '@/lib/indexer'

export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: { params: { locale: string } }): Promise<Metadata> {
  const t = await getTranslations({ locale: params.locale, namespace: 'track' })
  return { title: t('widgetTitle') }
}

function WidgetMessage({
  title,
  body,
  href,
  link,
}: {
  title: string
  body: string
  href: string
  link: string
}) {
  return (
    <div className="flex min-h-screen flex-col gap-2 bg-white p-3 text-sm text-slate-900 dark:bg-slate-900 dark:text-slate-100">
      <p className="font-semibold">{title}</p>
      <p className="text-xs text-slate-600 dark:text-slate-400">{body}</p>
      <a
        className="mt-auto text-xs font-semibold text-teal-700 underline dark:text-teal-300"
        href={href}
        target="_blank"
        rel="noreferrer noopener"
      >
        {link}
      </a>
    </div>
  )
}

export default async function EmbedTrackPage({ params }: { params: { locale: string; ref: string } }) {
  const t = await getTranslations('track')
  const tErrors = await getTranslations('errors')
  const ref = params.ref
  const fullPageHref = `/${params.locale}/track/${encodeURIComponent(ref)}`

  const kind = trackingRefKind(ref)
  if (!kind) {
    return (
      <WidgetMessage
        title={t('invalidRefTitle')}
        body={t('invalidRef')}
        href={fullPageHref}
        link={t('poweredBy')}
      />
    )
  }

  const track = await getDonationTrack(ref)

  return (
    <>
      <AutoRefresh seconds={60} />
      {track.ok ? (
        <TrackWidget track={track.data} fullPageHref={fullPageHref} />
      ) : track.error.kind === 'http' && track.error.status === 404 ? (
        <WidgetMessage
          title={kind === 'deposit' ? t('depositWaitingTitle') : t('notFoundTitle')}
          body={kind === 'deposit' ? t('depositWaitingWidget') : t('notFoundBody')}
          href={fullPageHref}
          link={t('poweredBy')}
        />
      ) : (
        <WidgetMessage
          title={tErrors('indexerTitle')}
          body={t('widgetOffline')}
          href={fullPageHref}
          link={t('poweredBy')}
        />
      )}
    </>
  )
}
