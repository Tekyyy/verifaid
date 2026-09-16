import type { NeedSummary } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { ProgressBar } from '@/components/ProgressBar'
import { NeedStatusBadge } from '@/components/StatusBadge'
import { Link } from '@/i18n/navigation'
import { amount, percent } from '@/lib/format'

export function NeedCard({ need }: { need: NeedSummary }) {
  const t = useTranslations('needs')
  const tCommon = useTranslations('common')
  const progress = percent(need.totalDonated, need.targetAmount)

  return (
    <article className="card flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">
            <Link className="link no-underline hover:underline" href={`/needs/${need.id}`}>
              #{need.id} · {need.categoryLabel}
            </Link>
          </h2>
          <p className="text-xs text-slate-600">
            {need.regionLabel}
            {need.ngoName ? ` · ${need.ngoName}` : ''}
          </p>
        </div>
        <NeedStatusBadge status={need.status} />
      </div>

      <div>
        <ProgressBar value={progress} label={t('progress', { percent: progress.toFixed(0) })} />
        <p className="mt-1 text-xs text-slate-600">{t('progress', { percent: progress.toFixed(0) })}</p>
      </div>

      <dl className="grid grid-cols-3 gap-2 text-xs">
        <div>
          <dt className="text-slate-600">{t('target')}</dt>
          <dd className="font-semibold tabular-nums">{amount(need.targetAmount)}</dd>
        </div>
        <div>
          <dt className="text-slate-600">{t('raised')}</dt>
          <dd className="font-semibold tabular-nums">{amount(need.totalDonated)}</dd>
        </div>
        <div>
          <dt className="text-slate-600">{t('released')}</dt>
          <dd className="font-semibold tabular-nums">{amount(need.totalReleased)}</dd>
        </div>
      </dl>

      <p className="text-xs text-slate-500">{tCommon('amountUnit')}</p>

      <Link className="btn-secondary self-start text-xs" href={`/needs/${need.id}`}>
        {t('view')}
      </Link>
    </article>
  )
}
