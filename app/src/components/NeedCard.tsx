import type { NeedSummary } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { CustodyBadge } from '@/components/CustodyBadge'
import { Deadline } from '@/components/Deadline'
import { NeedBadgeRow } from '@/components/NeedBadgeRow'
import { ProgressBar } from '@/components/ProgressBar'
import { NeedStatusBadge } from '@/components/StatusBadge'
import { Link } from '@/i18n/navigation'
import { amount, flagEmoji, imageSrc, percent } from '@/lib/format'

/**
 * One need, as a donor first meets it: the picture and the sentence its NGO chose, what it is raising and how
 * far it got, then the facts nobody chose — its status, its custody model, and what the chain says about the
 * organisation behind it. The presentation sits on top of those facts and never replaces them.
 */
export function NeedCard({ need }: { need: NeedSummary }) {
  const t = useTranslations('needs')
  const tCommon = useTranslations('common')
  const tTerms = useTranslations('terms')
  const progress = percent(need.totalDonated, need.targetAmount)
  const cover = need.presentation?.coverImage
  const tags = need.presentation?.tags ?? []

  return (
    <article className="flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition-shadow hover:shadow-md">
      <Link href={`/needs/${need.id}`} className="block no-underline" tabIndex={-1}>
        {cover ? (
          // biome-ignore lint/performance/noImgElement: the NGO hosts its own images; there is no loader for them
          <img
            src={imageSrc(cover)}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            className="h-40 w-full bg-slate-100 object-cover"
          />
        ) : (
          <div className="flex h-20 w-full items-end bg-gradient-to-br from-slate-100 to-slate-200 px-4 py-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              {need.categoryLabel}
            </span>
          </div>
        )}
      </Link>

      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-base font-semibold leading-tight">
              <Link className="text-slate-900 no-underline hover:underline" href={`/needs/${need.id}`}>
                #{need.id} · {need.categoryLabel}
              </Link>
            </h2>
            <p className="mt-0.5 text-xs text-slate-600">
              <span aria-hidden="true">{flagEmoji(need.country)} </span>
              {need.regionLabel}
              {need.ngoName ? ` · ${need.ngoName}` : ''}
            </p>
          </div>
          <NeedStatusBadge status={need.status} />
        </div>

        {need.presentation?.summary ? (
          <p className="line-clamp-2 text-sm text-slate-700">{need.presentation.summary}</p>
        ) : null}

        <div>
          <ProgressBar value={progress} label={t('progress', { percent: progress.toFixed(0) })} />
          <p className="mt-1.5 flex flex-wrap items-baseline gap-x-2 text-xs text-slate-600">
            <span className="font-semibold tabular-nums text-slate-900">
              {amount(need.totalDonated)} {tCommon('amountUnit')}
            </span>
            <span>{t('ofTarget', { target: amount(need.targetAmount), percent: progress.toFixed(0) })}</span>
          </p>
        </div>

        <NeedBadgeRow badges={need.badges} />

        {tags.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <li key={tag} className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
                {tag}
              </li>
            ))}
          </ul>
        ) : null}

        <div className="mt-auto space-y-1 border-t border-slate-100 pt-3 text-xs text-slate-600">
          <CustodyBadge mode={need.custodyMode} />
          {need.status === 'Funding' || need.status === 'Pending' ? (
            <p>
              <span>{tTerms('fundingDeadline')}: </span>
              <Deadline seconds={need.fundingDeadline} none={tTerms('openEnded')} />
            </p>
          ) : null}
        </div>
      </div>
    </article>
  )
}
