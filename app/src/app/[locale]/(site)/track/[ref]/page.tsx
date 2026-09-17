import { trackingRefKind } from '@poa/shared'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { DepositWaitingView } from '@/components/DepositWaitingView'
import { DonationTrackView } from '@/components/DonationTrackView'
import { IndexerNotice, Notice } from '@/components/Notice'
import { TrackForm } from '@/components/TrackForm'
import { getDonationTrack, getNeed } from '@/lib/indexer'
import { loadDepositView } from '@/lib/server/depositView'

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

  const kind = trackingRefKind(ref)
  if (!kind) {
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

  const notFound = !track.ok && track.error.kind === 'http' && track.error.status === 404

  // A deposit address has no donation to track until something is swept from it, but it is already a place to
  // watch: what it holds, a sweep button and the refund section.
  if (kind === 'deposit' && notFound) {
    const deposit = await loadDepositView(ref)
    if (deposit) {
      const need = await getNeed(deposit.needId)
      return <DepositWaitingView deposit={deposit} need={need.ok ? need.data : null} />
    }
  }

  if (!track.ok) {
    return notFound ? (
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
