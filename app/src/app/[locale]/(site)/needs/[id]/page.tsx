import type { NeedStatus } from '@poa/shared'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { CardOnrampPanel } from '@/components/CardOnrampPanel'
import { CustodyBadge } from '@/components/CustodyBadge'
import { DeliveryCard } from '@/components/DeliveryCard'
import { DepositAddressPanel } from '@/components/DepositAddressPanel'
import { DonatePanel } from '@/components/DonatePanel'
import { DonationList } from '@/components/DonationList'
import { ExpireButton } from '@/components/ExpireButton'
import { ExplorerLink } from '@/components/ExplorerLink'
import { GiveFiatPanel } from '@/components/GiveFiatPanel'
import { NeedBadgeRow } from '@/components/NeedBadgeRow'
import { NeedPresentation } from '@/components/NeedPresentation'
import { IndexerNotice, Notice } from '@/components/Notice'
import { PaymentPlanPanel } from '@/components/PaymentPlanPanel'
import { ProgressBar } from '@/components/ProgressBar'
import { RefundPanel } from '@/components/RefundPanel'
import { SettlementList } from '@/components/SettlementList'
import { NeedStatusBadge } from '@/components/StatusBadge'
import { TermsPanel } from '@/components/TermsPanel'
import { Timeline } from '@/components/Timeline'
import { TrancheBar } from '@/components/TrancheBar'
import { WithdrawDonationPanel } from '@/components/WithdrawDonationPanel'
import { WorkPhotos } from '@/components/WorkPhotos'
import { conversionsEnabled } from '@/lib/config'
import { amount, percent, timestamp } from '@/lib/format'
import { getNeed, getTimeline, needFeedPath } from '@/lib/indexer'

export const dynamic = 'force-dynamic'

export async function generateMetadata({
  params,
}: {
  params: { locale: string; id: string }
}): Promise<Metadata> {
  const t = await getTranslations({ locale: params.locale, namespace: 'need' })
  return { title: t('title', { id: params.id }) }
}

const EXPIRABLE_BEFORE_FUNDING: NeedStatus[] = ['Pending', 'Funding']
const EXPIRABLE_AFTER_FUNDING: NeedStatus[] = ['Funded', 'InDelivery']

export default async function NeedPage({ params }: { params: { id: string } }) {
  const t = await getTranslations('need')
  const tCommon = await getTranslations('common')
  const tTimeline = await getTranslations('timeline')
  const tErrors = await getTranslations('errors')
  const tSettlements = await getTranslations('settlements')

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

  // Rendered per request, so "now" is the moment the page was served; the contract re-checks on submit.
  const now = Math.floor(Date.now() / 1000)
  const passed = (deadline: number | null) => Boolean(deadline) && (deadline as number) <= now
  const deadlineReached =
    (EXPIRABLE_BEFORE_FUNDING.includes(data.status) &&
      (passed(data.fundingDeadline) || passed(data.executionDeadline))) ||
    (EXPIRABLE_AFTER_FUNDING.includes(data.status) && passed(data.executionDeadline))
  const fundingOpen =
    data.status === 'Funding' && !passed(data.fundingDeadline) && !passed(data.executionDeadline)
  const refundable =
    data.custodyMode === 'OnChain' && (data.status === 'Cancelled' || data.status === 'Expired')

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('title', { id: data.id })}</h1>
          <p className="mt-1 text-sm text-slate-700">
            {data.categoryLabel} · {data.regionLabel}
            {data.ngoName ? ` · ${data.ngoName}` : ''}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <a
              className="btn-secondary text-xs"
              href={`/api/reports/${encodeURIComponent(data.id)}`}
              download
            >
              {t('downloadReport')}
            </a>
            <a className="btn-secondary text-xs" href={needFeedPath(data.id)} type="application/rss+xml">
              {t('rss')}
            </a>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CustodyBadge mode={data.custodyMode} />
          <NeedStatusBadge status={data.status} />
          <NeedBadgeRow badges={data.badges} className="w-full" />
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
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
                <dt className="text-slate-600">
                  {data.custodyMode === 'OffChain' ? t('ledger') : t('vault')}
                </dt>
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
              <div>
                <dt className="text-slate-600">{t('fundingGap')}</dt>
                <dd className="text-slate-800 tabular-nums">{amount(data.fundingGap)}</dd>
              </div>
              <div>
                <dt className="text-slate-600">{t('refunded')}</dt>
                <dd className="text-slate-800 tabular-nums">{amount(data.totalRefunded)}</dd>
              </div>
            </dl>
          </section>

          <NeedPresentation presentation={data.presentation} />

          <TermsPanel need={data} />

          <PaymentPlanPanel need={data} />

          <WorkPhotos photos={data.photos} />

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

          <section className="card" aria-labelledby="settlements">
            <h2 id="settlements" className="section-title">
              {tSettlements('title')}
            </h2>
            <p className="mt-1 text-sm text-slate-700">{tSettlements('note')}</p>
            <div className="mt-3">
              <SettlementList settlements={data.settlements} />
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

        <aside className="min-w-0 space-y-6">
          {deadlineReached ? <ExpireButton needId={data.id} /> : null}
          {refundable ? <RefundPanel vault={data.vault} /> : null}
          <WithdrawDonationPanel need={data} />

          {data.custodyMode === 'OnChain' ? (
            <DonatePanel
              needId={data.id}
              vault={data.vault}
              fundingOpen={fundingOpen}
              targetAmount={data.targetAmount}
              totalDonated={data.totalDonated}
              thirdPartyCostBps={data.thirdPartyCostBps}
            />
          ) : null}

          {/* v3 deployments: card via an on-ramp into the donor's own wallet, and deposit addresses for exchanges. */}
          {data.custodyMode === 'OnChain' && conversionsEnabled ? (
            <>
              <CardOnrampPanel
                needId={data.id}
                open={fundingOpen}
                remaining={data.fundingGap}
                thirdPartyCostBps={data.thirdPartyCostBps}
              />
              <DepositAddressPanel
                needId={data.id}
                open={fundingOpen}
                thirdPartyCostBps={data.thirdPartyCostBps}
              />
            </>
          ) : null}

          <GiveFiatPanel
            needId={data.id}
            custodyMode={data.custodyMode}
            open={fundingOpen}
            thirdPartyCostBps={data.thirdPartyCostBps}
          />

          <section className="card" aria-labelledby="donations">
            <h2 id="donations" className="section-title">
              {t('donationsTitle')}
            </h2>
            <DonationList donations={data.donations} />
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
