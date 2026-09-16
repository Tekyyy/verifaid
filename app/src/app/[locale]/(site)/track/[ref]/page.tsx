import { trackingRefKind } from '@poa/shared'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { DonationTrackView } from '@/components/DonationTrackView'
import { IndexerNotice, Notice } from '@/components/Notice'
import { TrackForm } from '@/components/TrackForm'
import { getDonationTrack } from '@/lib/indexer'

export const dynamic = 'force-dynamic'

export async function generateMetadata({
  params,
}: {
  params: { locale: string; ref: string }
}): Promise<Metadata> {
  const t = await getTranslations({ locale: params.locale, namespace: 'track' })
  // A tracking link is shared on purpose, but it should not turn up in search results.
  return { title: t('title'), robots: { index: false, follow: false } }
}

export default async function TrackPage({ params }: { params: { ref: string } }) {
  const t = await getTranslations('track')
  const ref = params.ref

  if (!trackingRefKind(ref)) {
    return (
      <div className="max-w-2xl space-y-6">
        <Notice tone="error" title={t('invalidRefTitle')}>
          {t('invalidRef')}
        </Notice>
        <TrackForm />
      </div>
    )
  }

  const track = await getDonationTrack(ref)

  if (!track.ok) {
    return track.error.kind === 'http' && track.error.status === 404 ? (
      <div className="max-w-2xl space-y-6">
        <Notice tone="warning" title={t('notFoundTitle')}>
          {t('notFoundBody')}
        </Notice>
        <TrackForm />
      </div>
    ) : (
      <IndexerNotice error={track.error} />
    )
  }

  return <DonationTrackView track={track.data} />
}
