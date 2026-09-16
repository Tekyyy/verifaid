import { getTranslations } from 'next-intl/server'
import { IndexerNotice } from '@/components/Notice'
import { Link } from '@/i18n/navigation'
import { amount } from '@/lib/format'
import { getImpactSummary } from '@/lib/indexer'

// Live totals: never prerendered, so the page always shows the current state of the chain.
export const dynamic = 'force-dynamic'

export default async function HomePage() {
  const t = await getTranslations('home')
  const tCommon = await getTranslations('common')
  const summary = await getImpactSummary()

  const stats = summary.ok
    ? [
        { label: t('donated'), value: `${amount(summary.data.totals.donated)} ${tCommon('amountUnit')}` },
        { label: t('released'), value: `${amount(summary.data.totals.released)} ${tCommon('amountUnit')}` },
        { label: t('needs'), value: String(summary.data.totals.needs) },
        { label: t('completed'), value: String(summary.data.totals.needsCompleted) },
        { label: t('deliveries'), value: String(summary.data.totals.deliveriesFinalized) },
        { label: t('confirmations'), value: String(summary.data.totals.confirmations) },
        { label: t('beneficiaries'), value: String(summary.data.totals.beneficiariesServed) },
      ]
    : []

  const flow = [1, 2, 3, 4, 5] as const

  return (
    <div className="space-y-12">
      <section>
        <p className="text-sm font-semibold uppercase tracking-wide text-indigo-700">{tCommon('tagline')}</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">{t('title')}</h1>
        <p className="mt-3 max-w-3xl text-base text-slate-700">{t('lead')}</p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link className="btn-primary" href="/needs">
            {t('browseNeeds')}
          </Link>
          <Link className="btn-secondary" href="/impact">
            {t('seeImpact')}
          </Link>
        </div>
      </section>

      <section aria-labelledby="totals">
        <h2 id="totals" className="section-title">
          {t('totalsTitle')}
        </h2>
        <p className="mt-1 text-sm text-slate-600">{t('totalsNote')}</p>

        {summary.ok ? (
          <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {stats.map((stat) => (
              <div key={stat.label} className="card">
                <dt className="text-xs text-slate-600">{stat.label}</dt>
                <dd className="mt-1 text-xl font-bold tabular-nums text-slate-900">{stat.value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <div className="mt-4">
            <IndexerNotice error={summary.error} />
          </div>
        )}
      </section>

      <section aria-labelledby="flow">
        <h2 id="flow" className="section-title">
          {t('flowTitle')}
        </h2>
        <ol className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {flow.map((step) => (
            <li key={step} className="card">
              <p className="text-xs font-bold text-indigo-700">{step}</p>
              <h3 className="mt-1 font-semibold">{t(`flow${step}Title`)}</h3>
              <p className="mt-1 text-sm text-slate-700">{t(`flow${step}Body`)}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="privacy" className="card border-indigo-200 bg-indigo-50">
        <h2 id="privacy" className="section-title">
          {t('privacyTitle')}
        </h2>
        <p className="mt-1 max-w-3xl text-sm text-slate-800">{t('privacyBody')}</p>
      </section>
    </div>
  )
}
