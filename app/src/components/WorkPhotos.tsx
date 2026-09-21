import type { WorkPhotoView } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { ExplorerLink } from '@/components/ExplorerLink'
import { imageSrc, timestamp } from '@/lib/format'

/**
 * Photos of the finished work, published by the NGO that ran the need and signed as an attestation, so a donor
 * can see what the money bought and check who published it. Images are hosted wherever the NGO put them; only
 * the links are on chain. They are of goods, sites and deliveries — beneficiaries never appear in this system.
 */
export function WorkPhotos({ photos }: { photos: WorkPhotoView[] }) {
  const t = useTranslations('photos')

  if (photos.length === 0) return null

  return (
    <section className="card" aria-labelledby="work-photos">
      <h2 id="work-photos" className="section-title">
        {t('title')}
      </h2>
      <p className="mt-1 text-sm text-slate-700">{t('note')}</p>

      <div className="mt-3 space-y-4">
        {photos.map((published) => (
          <figure key={published.uid}>
            <div className="grid gap-2 sm:grid-cols-3">
              {published.photos.map((url) => (
                // biome-ignore lint/performance/noImgElement: images live on the NGO's own host, not ours to optimize
                <img
                  key={url}
                  src={imageSrc(url)}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  className="h-32 w-full rounded-md border border-slate-200 object-cover"
                />
              ))}
            </div>
            <figcaption className="mt-2 flex flex-wrap items-center gap-x-2 text-xs text-slate-600">
              {published.note ? <span className="text-slate-800">{published.note}</span> : null}
              <span>{timestamp(published.timestamp)}</span>
              <ExplorerLink kind="attestation" value={published.uid} />
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  )
}
