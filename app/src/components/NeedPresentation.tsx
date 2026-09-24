import type { NeedPresentationView } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { ExplorerLink } from '@/components/ExplorerLink'
import { imageSrc } from '@/lib/format'

/**
 * The NGO's own presentation of a need: a cover, a sentence, a few images. It is signed and dated, so a donor
 * can see who wrote it — and it sits above the terms panel, never inside it, because the terms are what was
 * verified and this is what was claimed.
 */
export function NeedPresentation({
  presentation,
  withCover = true,
}: {
  presentation: NeedPresentationView | null
  /** Off where the page already shows the cover at the top. */
  withCover?: boolean
}) {
  const t = useTranslations('need')

  if (!presentation || (!presentation.coverImage && !presentation.summary)) return null

  return (
    <section className="card overflow-hidden p-0" aria-labelledby="presentation">
      {withCover && presentation.coverImage ? (
        // biome-ignore lint/performance/noImgElement: the NGO hosts its own images; there is no loader for them
        <img
          src={imageSrc(presentation.coverImage)}
          alt=""
          className="h-56 w-full bg-slate-100 object-cover sm:h-72"
          referrerPolicy="no-referrer"
        />
      ) : null}

      <div className="space-y-3 p-4">
        <h2 id="presentation" className="section-title">
          {t('presentationTitle')}
        </h2>
        {presentation.summary ? (
          <p className="text-sm leading-relaxed text-slate-800">{presentation.summary}</p>
        ) : null}

        {presentation.tags.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5">
            {presentation.tags.map((tag) => (
              <li key={tag} className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
                {tag}
              </li>
            ))}
          </ul>
        ) : null}

        {presentation.gallery.length > 0 ? (
          <div className="grid gap-2 sm:grid-cols-3">
            {presentation.gallery.map((url) => (
              // biome-ignore lint/performance/noImgElement: same as the cover
              <img
                key={url}
                src={imageSrc(url)}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
                className="h-28 w-full rounded-md border border-slate-200 object-cover"
              />
            ))}
          </div>
        ) : null}

        <p className="flex flex-wrap items-center gap-x-2 text-xs text-slate-600">
          <span>{t('presentationBy')}</span>
          <ExplorerLink kind="attestation" value={presentation.uid} />
        </p>
      </div>
    </section>
  )
}
