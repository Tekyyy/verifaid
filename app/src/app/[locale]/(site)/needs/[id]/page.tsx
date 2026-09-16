import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { DeliveryCard } from '@/components/DeliveryCard'
import { DonatePanel } from '@/components/DonatePanel'
import { ExplorerLink } from '@/components/ExplorerLink'
import { IndexerNotice, Notice } from '@/components/Notice'
import { ProgressBar } from '@/components/ProgressBar'
import { NeedStatusBadge } from '@/components/StatusBadge'
import { Timeline } from '@/components/Timeline'
import { TrancheBar } from '@/components/TrancheBar'
import { amount, percent, timestamp } from '@/lib/format'
import { getNeed, getTimeline } from '@/lib/indexer'

export const dynamic = 'force-dynamic'

export async function generateMetadata({
  params,
}: {
  params: { locale: string; id: string }
}): Promise<Metadata> {
  const t = await getTranslations({ locale: params.locale, namespace: 'need' })
  return { title: t('title', { id: params.id }) }
}

export default async function NeedPage({ params }: { params: { id: string } }) {
  const t = await getTranslations('need')
  const tCommon = await getTranslations('common')
  const tTimeline = await getTranslations('timeline')
  const tErrors = await getTranslations('errors')

  const [need, timeline] = await Promise.all([getNeed(params.id), getTimeline(params.id)])

  if (!need.ok) {
    return need.error.kind === 'http' && need.error.status === 404 ? (
      <Notice tone="error" title={tErrors('notFoundTitle')}>
        {tErrors('needNotFound', { id: params.id })}
      </Notice>
    ) : (
      <IndexerNotice error={need.error} />
    )
  }

  const data = need.data
  const progress = percent(data.totalDonated, data.targetAmount)

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('title', { id: data.id })}</h1>
          <p className="mt-1 text-sm text-slate-700">
            {data.categoryLabel} · {data.regionLabel}
            {data.ngoName ? ` · ${data.ngoName}` : ''}
          </p>
        </div>
        <NeedStatusBadge status={data.status} />
      </header>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <section className="card" aria-labelledby="funding">
            <h2 id="funding" className="section-title">
              {t('fundingTitle')}
            </h2>
            <p className="mt-2 text-sm text-slate-800">
              {t('raisedOfTarget', {
                raised: amount(data.totalDonated),
                target: amount(data.targetAmount),
                unit: tCommon('amountUnit'),
              })}
            </p>
            <div className="mt-2">
              <ProgressBar value={progress} label={`${progress.toFixed(0)}%`} />
            </div>

            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
              <div>
                <dt className="text-slate-600">{t('ngo')}</dt>
                <dd>
                  <ExplorerLink kind="address" value={data.ngo} />
                </dd>
              </div>
              <div>
                <dt className="text-slate-600">{t('vault')}</dt>
                <dd>
                  <ExplorerLink kind="address" value={data.vault} />
                </dd>
              </div>
              <div>
                <dt className="text-slate-600">{t('program')}</dt>
                <dd className="text-slate-800">#{data.programId}</dd>
              </div>
              <div>
                <dt className="text-slate-600">{t('verifications')}</dt>
                <dd className="text-slate-800">
                  {t('verificationsValue', {
                    count: data.verificationCount,
                    required: data.verificationsRequired,
                  })}
                </dd>
              </div>
              <div>
                <dt className="text-slate-600">{t('created')}</dt>
                <dd className="text-slate-800">{timestamp(data.createdAt)}</dd>
              </div>
              <div>
                <dt className="text-slate-600">{t('released')}</dt>
                <dd className="text-slate-800 tabular-nums">{amount(data.totalReleased)}</dd>
              </div>
            </dl>
          </section>

          <section className="card" aria-labelledby="tranches">
            <h2 id="tranches" className="section-title">
              {t('trancheTitle')}
            </h2>
            <p className="mt-1 text-sm text-slate-700">{t('trancheNote')}</p>
            <div className="mt-3">
              {data.tranches.length > 0 ? (
                <TrancheBar tranches={data.tranches} />
              ) : (
                <p className="text-sm text-slate-600">{tErrors('empty')}</p>
              )}
            </div>
          </section>

          <section className="card" aria-labelledby="deliveries">
            <h2 id="deliveries" className="section-title">
              {t('deliveriesTitle')}
            </h2>
            <p className="mt-1 text-sm text-slate-700">{t('deliveriesNote')}</p>
            <div className="mt-3 space-y-3">
              {data.deliveries.length > 0 ? (
                data.deliveries.map((delivery) => <DeliveryCard key={delivery.id} delivery={delivery} />)
              ) : (
                <p className="text-sm text-slate-600">{t('noDeliveries')}</p>
              )}
            </div>
          </section>

          <section className="card" aria-labelledby="timeline">
            <h2 id="timeline" className="section-title">
              {tTimeline('title')}
            </h2>
            <p className="mt-1 text-sm text-slate-700">{tTimeline('description')}</p>
            <div className="mt-4">
              {timeline.ok ? (
                timeline.data.length > 0 ? (
                  <Timeline events={timeline.data} />
                ) : (
                  <p className="text-sm text-slate-600">{tErrors('empty')}</p>
                )
              ) : (
                <IndexerNotice error={timeline.error} />
              )}
            </div>
          </section>
        </div>

        <aside className="space-y-6">
          <DonatePanel
            vault={data.vault}
            status={data.status}
            targetAmount={data.targetAmount}
            totalDonated={data.totalDonated}
          />

          <section className="card" aria-labelledby="donations">
            <h2 id="donations" className="section-title">
              {t('donationsTitle')}
            </h2>
            {data.donations.length === 0 ? (
              <p className="mt-2 text-sm text-slate-600">{t('noDonations')}</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {data.donations.map((donation) => (
                  <li key={donation.id} className="rounded-md border border-slate-200 px-3 py-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold tabular-nums">
                        {amount(donation.amount)} {tCommon('amountUnit')}
                      </span>
                      <span className="text-slate-600">
                        {donation.kind === 'DIRECT' ? t('donationDirect') : t('donationFiat')}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <ExplorerLink kind="tx" value={donation.txHash} />
                      {donation.attestationUID ? (
                        <ExplorerLink kind="attestation" value={donation.attestationUID} />
                      ) : null}
                      <span className="text-slate-500">{timestamp(donation.timestamp)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {data.impactReport ? (
            <section className="card border-emerald-200 bg-emerald-50" aria-labelledby="impact">
              <h2 id="impact" className="section-title">
                {t('impactTitle')}
              </h2>
              <dl className="mt-2 space-y-1 text-xs">
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-700">{t('beneficiariesServed')}</dt>
                  <dd className="font-semibold tabular-nums">{data.impactReport.beneficiariesServed}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-700">{tCommon('attestation')}</dt>
                  <dd>
                    <ExplorerLink kind="attestation" value={data.impactReport.uid} />
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-700">{t('reportCid')}</dt>
                  <dd className="mono">{data.impactReport.reportCID}</dd>
                </div>
              </dl>
              {data.impactReport.revoked ? (
                <p className="mt-2 text-xs font-semibold text-red-800">{t('revoked')}</p>
              ) : null}
            </section>
          ) : null}
        </aside>
      </div>
    </div>
  )
}
