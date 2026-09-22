import type { ImpactBucket } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { amount } from '@/lib/format'

/**
 * Horizontal bars sized by the amount donated, with released overlaid. The numbers are always present as
 * text, so the chart is readable by a screen reader and at any zoom level; the bars are decoration.
 */
export function ImpactChart({
  buckets,
  filterKey,
}: {
  buckets: ImpactBucket[]
  /** Which `/needs` query parameter a bucket drills down into. */
  filterKey: 'category' | 'region'
}) {
  const t = useTranslations('impact')
  const tCommon = useTranslations('common')

  const max = buckets.reduce((highest, bucket) => {
    const value = BigInt(bucket.donated)
    return value > highest ? value : highest
  }, 1n)

  const width = (value: string): number => Number((BigInt(value) * 100n) / max)

  return (
    <ul className="space-y-4">
      {buckets.map((bucket) => (
        <li key={bucket.key} className="rounded-md border border-slate-200 bg-white p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-semibold">{bucket.label}</h3>
            <Link className="link text-xs" href={`/needs?${filterKey}=${encodeURIComponent(bucket.label)}`}>
              {t('drillDown')}
            </Link>
          </div>

          <div className="mt-2 space-y-1" aria-hidden="true">
            <div className="h-3 w-full rounded-sm bg-slate-100">
              <div className="h-full rounded-sm bg-teal-600" style={{ width: `${width(bucket.donated)}%` }} />
            </div>
            <div className="h-3 w-full rounded-sm bg-slate-100">
              <div
                className="h-full rounded-sm bg-emerald-600"
                style={{ width: `${width(bucket.released)}%` }}
              />
            </div>
          </div>

          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-5">
            <div>
              <dt className="text-slate-600">{t('donated')}</dt>
              <dd className="font-semibold tabular-nums">
                {amount(bucket.donated)} {tCommon('amountUnit')}
              </dd>
            </div>
            <div>
              <dt className="text-slate-600">{t('released')}</dt>
              <dd className="font-semibold tabular-nums">
                {amount(bucket.released)} {tCommon('amountUnit')}
              </dd>
            </div>
            <div>
              <dt className="text-slate-600">{t('needs')}</dt>
              <dd className="font-semibold tabular-nums">{bucket.needs}</dd>
            </div>
            <div>
              <dt className="text-slate-600">{t('finalized')}</dt>
              <dd className="font-semibold tabular-nums">{bucket.deliveriesFinalized}</dd>
            </div>
            <div>
              <dt className="text-slate-600">{t('beneficiaries')}</dt>
              <dd className="font-semibold tabular-nums">{bucket.beneficiariesServed}</dd>
            </div>
          </dl>
        </li>
      ))}
    </ul>
  )
}
