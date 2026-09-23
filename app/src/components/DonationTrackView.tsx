import type { DonationTrack } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { AlertsForm } from '@/components/AlertsForm'
import { ConversionNote } from '@/components/ConversionNote'
import { CopyLinkButton } from '@/components/CopyLinkButton'
import { DeliveryCard } from '@/components/DeliveryCard'
import { DepositActivity } from '@/components/DepositActivity'
import { DepositSweeps } from '@/components/DepositSweeps'
import { DepositIntent } from '@/components/DepositWaitingView'
import { KIND_KEY } from '@/components/DonationList'
import { EmbedSnippet } from '@/components/EmbedSnippet'
import { ExplorerLink } from '@/components/ExplorerLink'
import { OutcomeBanner } from '@/components/OutcomeBanner'
import { SettlementList } from '@/components/SettlementList'
import { StageStepper } from '@/components/StageStepper'
import { NeedStatusBadge } from '@/components/StatusBadge'
import { TaxReceiptPanel } from '@/components/TaxReceiptPanel'
import { TrancheBar } from '@/components/TrancheBar'
import { Link } from '@/i18n/navigation'
import { amount, bpsPercent, shorten, timestamp } from '@/lib/format'
import { donationFeedPath } from '@/lib/indexer'

/** The public page for one donation: where it is in the five stages, and exactly what it paid for so far. */
export function DonationTrackView({ track }: { track: DonationTrack }) {
  const t = useTranslations('track')
  const tNeed = useTranslations('need')
  const tPlan = useTranslations('plan')
  const tCommon = useTranslations('common')
  const { donation, need } = track
  const unit = tCommon('amountUnit')

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">
            {track.refKind === 'receipt'
              ? t('titleReceipt', { id: track.ref })
              : track.refKind === 'deposit'
                ? t('titleDeposit', { address: shorten(track.ref, 10, 6) })
                : t('titlePayment', { ref: shorten(track.ref, 10, 6) })}
          </h1>
          <p className="mt-1 text-sm text-slate-700">
            <Link className="link" href={`/needs/${need.id}`}>
              {tNeed('title', { id: need.id })}
            </Link>{' '}
            · {need.categoryLabel} · {need.regionLabel}
            {need.ngoName ? ` · ${need.ngoName}` : ''}
          </p>
          <p className="mt-1 text-xs text-slate-600">{t('updatedAt', { at: timestamp(track.updatedAt) })}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <NeedStatusBadge status={need.status} />
        </div>
      </header>

      <OutcomeBanner outcome={track.outcome} refKind={track.refKind} />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <section className="card" aria-labelledby="summary">
            <h2 id="summary" className="section-title">
              {t('summaryTitle')}
            </h2>
            <dl className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
              <div>
                <dt className="text-slate-600">{t('yourDonation')}</dt>
                <dd className="text-base font-semibold tabular-nums">
                  {amount(donation.amount)} {unit}
                </dd>
                <dd className="text-slate-600">{tNeed(KIND_KEY[donation.kind])}</dd>
              </div>
              <div>
                <dt className="text-slate-600">{t('share')}</dt>
                <dd className="text-base font-semibold tabular-nums">{bpsPercent(track.shareBps)}%</dd>
              </div>
              <div>
                <dt className="text-slate-600">{t('releasedToNgo')}</dt>
                <dd className="text-base font-semibold tabular-nums">
                  {amount(track.releasedToNgo)} {unit}
                </dd>
              </div>
              <div>
                <dt className="text-slate-600">{t('refunded')}</dt>
                <dd className="text-base font-semibold tabular-nums">
                  {amount(track.refunded)} {unit}
                </dd>
              </div>
            </dl>
            {donation.conversion ? (
              <ConversionNote
                conversion={donation.conversion}
                className="mt-3 text-xs text-slate-700 tabular-nums"
              />
            ) : null}
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              <span className="flex items-center gap-1">
                <span className="text-slate-600">{tCommon('transaction')}</span>
                <ExplorerLink kind="tx" value={donation.txHash} />
              </span>
              <span className="text-slate-500">{timestamp(donation.timestamp)}</span>
            </div>
          </section>

          {track.deposit ? (
            <section className="card space-y-4" aria-labelledby="deposit">
              <div>
                <h2 id="deposit" className="section-title">
                  {t('depositTitle')}
                </h2>
                <p className="mt-1 text-sm text-slate-700">{t('depositBody')}</p>
              </div>
              <DepositIntent deposit={track.deposit} />
              <DepositSweeps deposit={track.deposit} />
              <DepositActivity
                address={track.deposit.address}
                needStatus={need.status}
                receiptTo={track.deposit.receiptTo}
                refundTo={track.deposit.refundTo}
                refundSigner={track.deposit.refundSigner}
                swept={track.deposit.sweeps.length > 0}
              />
            </section>
          ) : null}

          <section className="card" aria-labelledby="stages">
            <h2 id="stages" className="section-title">
              {t('stagesTitle')}
            </h2>
            <div className="mt-4">
              <StageStepper stages={track.stages} currentStage={track.currentStage} />
            </div>
          </section>

          {track.tranches.length > 0 ? (
            <section className="card" aria-labelledby="tranches">
              <h2 id="tranches" className="section-title">
                {tNeed('trancheTitle')}
              </h2>
              <p className="mt-1 text-sm text-slate-700">{t('tranchesNote')}</p>
              <div className="mt-3">
                <TrancheBar tranches={track.tranches} />
              </div>
            </section>
          ) : null}

          {track.payees.length > 0 ? (
            <section className="card" aria-labelledby="track-payees">
              <h2 id="track-payees" className="section-title">
                {tPlan('title')}
              </h2>
              <p className="mt-1 text-sm text-slate-700">{t('payeesNote')}</p>
              <ul className="mt-3 space-y-2 text-sm">
                {track.payees.map((payee) => (
                  <li key={payee.index} className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="min-w-0">
                      <span className="block font-medium text-slate-900">
                        {payee.label || tPlan('unnamed')}
                      </span>
                      {payee.account ? (
                        <Link className="link mono text-xs" href={`/suppliers/${payee.account}`}>
                          {shorten(payee.account)}
                        </Link>
                      ) : (
                        <span className="text-xs text-slate-600">{tPlan('ngoShare')}</span>
                      )}
                    </span>
                    <span className="tabular-nums text-slate-800">
                      {t('payeeShare', {
                        share: bpsPercent(payee.needShareBps),
                        amount: amount((BigInt(payee.paid) * BigInt(track.shareBps)) / 10_000n),
                        unit,
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <TaxReceiptPanel track={track} unit={unit} />

          <section className="card" aria-labelledby="settlements">
            <h2 id="settlements" className="section-title">
              {t('settlementsTitle')}
            </h2>
            <div className="mt-3">
              <SettlementList settlements={track.settlements} />
            </div>
          </section>

          <section className="card" aria-labelledby="deliveries">
            <h2 id="deliveries" className="section-title">
              {tNeed('deliveriesTitle')}
            </h2>
            <div className="mt-3 space-y-3">
              {track.deliveries.length > 0 ? (
                track.deliveries.map((delivery) => <DeliveryCard key={delivery.id} delivery={delivery} />)
              ) : (
                <p className="text-sm text-slate-600">{tNeed('noDeliveries')}</p>
              )}
            </div>
          </section>

          {track.impactReport ? (
            <section className="card border-emerald-200 bg-emerald-50" aria-labelledby="impact">
              <h2 id="impact" className="section-title">
                {tNeed('impactTitle')}
              </h2>
              <dl className="mt-2 space-y-1 text-xs">
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-700">{tNeed('beneficiariesServed')}</dt>
                  <dd className="font-semibold tabular-nums">{track.impactReport.beneficiariesServed}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-700">{tCommon('attestation')}</dt>
                  <dd>
                    <ExplorerLink kind="attestation" value={track.impactReport.uid} />
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-700">{tNeed('reportCid')}</dt>
                  <dd className="mono">{track.impactReport.reportCID}</dd>
                </div>
              </dl>
              {track.impactReport.revoked ? (
                <p className="mt-2 text-xs font-semibold text-red-800">{tNeed('revoked')}</p>
              ) : null}
            </section>
          ) : null}
        </div>

        <aside className="min-w-0 space-y-6">
          <section className="card space-y-3" aria-labelledby="follow">
            <h2 id="follow" className="section-title">
              {t('followTitle')}
            </h2>
            <p className="text-sm text-slate-700">{t('followBody')}</p>
            <div className="flex flex-wrap gap-2">
              <CopyLinkButton />
              <a
                className="btn-secondary text-xs"
                href={donationFeedPath(track.ref)}
                type="application/rss+xml"
              >
                {t('rss')}
              </a>
            </div>
          </section>

          <section id="alerts" className="card scroll-mt-4 space-y-3" aria-labelledby="alerts-title">
            <h2 id="alerts-title" className="section-title">
              {t('alertsTitle')}
            </h2>
            <p className="text-sm text-slate-700">{t('alertsBody')}</p>
            <AlertsForm trackingRef={track.ref} />
          </section>

          <section className="card space-y-3" aria-labelledby="embed">
            <h2 id="embed" className="section-title">
              {t('embedTitle')}
            </h2>
            <p className="text-sm text-slate-700">{t('embedBody')}</p>
            <EmbedSnippet trackingRef={track.ref} />
          </section>
        </aside>
      </div>
    </div>
  )
}
