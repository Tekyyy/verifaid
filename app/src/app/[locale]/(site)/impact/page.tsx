import type { ImpactReportView } from '@poa/shared'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { ExplorerLink } from '@/components/ExplorerLink'
import { ImpactChart } from '@/components/ImpactChart'
import { EmptyState, IndexerNotice } from '@/components/Notice'
import { Link } from '@/i18n/navigation'
import { amount, timestamp } from '@/lib/format'
import { getImpactSummary, getNeed, getNeeds } from '@/lib/indexer'

export const dynamic = 'force-dynamic'

/** Drill-down is capped: enough to show the evidence chain without turning the page into an N+1 fan-out. */
const MAX_REPORT_LOOKUPS = 12

export async function generateMetadata(props: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const params = await props.params

  const { locale } = params

  const t = await getTranslations({ locale, namespace: 'impact' })
  return { title: t('title') }
}

export default async function ImpactPage() {
  const t = await getTranslations('impact')
  const tHome = await getTranslations('home')
  const tCommon = await getTranslations('common')

  const summary = await getImpactSummary()
  const completed = await getNeeds({ status: 'Completed' })
  const details = completed.ok
    ? await Promise.all(completed.data.slice(0, MAX_REPORT_LOOKUPS).map((need) => getNeed(need.id)))
    : []
  const reports = details
    .map((detail) => (detail.ok ? detail.data.impactReport : null))
    .filter((report): report is ImpactReportView => report !== null)

  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-700">{t('subtitle')}</p>
      </header>

      {!summary.ok ? (
        <IndexerNotice error={summary.error} />
      ) : (
        <>
          <section aria-labelledby="totals">
            <h2 id="totals" className="section-title">
              {tHome('totalsTitle')}
            </h2>
            <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                {
                  label: t('donated'),
                  value: `${amount(summary.data.totals.donated)} ${tCommon('amountUnit')}`,
                },
                {
                  label: t('released'),
                  value: `${amount(summary.data.totals.released)} ${tCommon('amountUnit')}`,
                },
                { label: t('finalized'), value: String(summary.data.totals.deliveriesApproved) },
                { label: t('beneficiaries'), value: String(summary.data.totals.beneficiariesServed) },
              ].map((stat) => (
                <div key={stat.label} className="card">
                  <dt className="text-xs text-slate-600">{stat.label}</dt>
                  <dd className="mt-1 text-xl font-bold tabular-nums">{stat.value}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section aria-labelledby="by-category">
            <h2 id="by-category" className="section-title">
              {t('byCategory')}
            </h2>
            <div className="mt-3">
              <ImpactChart buckets={summary.data.byCategory} filterKey="category" />
            </div>
          </section>

          <section aria-labelledby="by-region">
            <h2 id="by-region" className="section-title">
              {t('byRegion')}
            </h2>
            <div className="mt-3">
              <ImpactChart buckets={summary.data.byRegion} filterKey="region" />
            </div>
          </section>
        </>
      )}

      <section aria-labelledby="reports">
        <h2 id="reports" className="section-title">
          {t('reportsTitle')}
        </h2>
        <p className="mt-1 text-sm text-slate-700">{t('reportsBody')}</p>
        <div className="mt-3">
          {reports.length === 0 ? (
            <EmptyState title={t('noReports')} />
          ) : (
            <ul className="space-y-2">
              {reports.map((report) => (
                <li
                  key={report.uid}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border
                    border-slate-200 bg-white px-3 py-2 text-xs"
                >
                  <Link className="link" href={`/needs/${report.needId}`}>
                    #{report.needId}
                  </Link>
                  <span className="tabular-nums">
                    {t('beneficiaries')}: {report.beneficiariesServed}
                  </span>
                  <span className="text-slate-600">{timestamp(report.timestamp)}</span>
                  <ExplorerLink kind="attestation" value={report.uid} label={t('openAttestation')} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  )
}
