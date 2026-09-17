import type { DepositAddressView, NeedSummary } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { CopyLinkButton } from '@/components/CopyLinkButton'
import { DepositActivity } from '@/components/DepositActivity'
import { DepositSweeps } from '@/components/DepositSweeps'
import { ExplorerLink } from '@/components/ExplorerLink'
import { Notice } from '@/components/Notice'
import { NeedStatusBadge } from '@/components/StatusBadge'
import { Link } from '@/i18n/navigation'
import { shorten } from '@/lib/format'

/**
 * The tracking page of a deposit address before anything has been swept from it: nothing counts toward the need
 * yet, so there are no stages to show. It shows what the address commits to, what it holds right now, a way to
 * sweep money that has arrived, and the refund section.
 */
export function DepositWaitingView({
  deposit,
  need,
}: {
  deposit: DepositAddressView
  need: NeedSummary | null
}) {
  const t = useTranslations('track')
  const tNeed = useTranslations('need')

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">
            {t('titleDeposit', { address: shorten(deposit.address, 10, 6) })}
          </h1>
          <p className="mt-1 text-sm text-slate-700">
            <Link className="link" href={`/needs/${deposit.needId}`}>
              {tNeed('title', { id: deposit.needId })}
            </Link>
            {need ? ` · ${need.categoryLabel} · ${need.regionLabel}` : ''}
          </p>
        </div>
        {need ? <NeedStatusBadge status={need.status} /> : null}
      </header>

      <Notice tone="info" title={t('depositWaitingTitle')}>
        {t('depositWaitingBody')}
      </Notice>

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="card min-w-0 space-y-4 lg:col-span-2" aria-labelledby="deposit">
          <div>
            <h2 id="deposit" className="section-title">
              {t('depositTitle')}
            </h2>
            <p className="mt-1 text-sm text-slate-700">{t('depositBody')}</p>
          </div>
          <DepositIntent deposit={deposit} />
          <DepositSweeps deposit={deposit} />
          <DepositActivity
            address={deposit.address}
            needStatus={need?.status ?? null}
            receiptTo={deposit.receiptTo}
            refundTo={deposit.refundTo}
            refundSigner={deposit.refundSigner}
            swept={deposit.sweeps.length > 0}
          />
        </section>

        <aside className="min-w-0">
          <section className="card space-y-3" aria-labelledby="follow">
            <h2 id="follow" className="section-title">
              {t('followTitle')}
            </h2>
            <p className="text-sm text-slate-700">{t('followBody')}</p>
            <CopyLinkButton />
          </section>
        </aside>
      </div>
    </div>
  )
}

/** What the address committed to when it was created. None of it can change. */
export function DepositIntent({ deposit }: { deposit: DepositAddressView }) {
  const t = useTranslations('deposit')

  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
      <div className="sm:col-span-2">
        <dt className="text-slate-600">{t('address')}</dt>
        <dd className="break-all font-mono">{deposit.address}</dd>
      </div>
      <div>
        <dt className="text-slate-600">{t('receipt')}</dt>
        <dd>
          {deposit.receiptTo ? (
            <ExplorerLink kind="address" value={deposit.receiptTo} />
          ) : (
            t('receiptToAddress')
          )}
        </dd>
      </div>
      <div>
        <dt className="text-slate-600">{t('refundRoute')}</dt>
        <dd>
          {deposit.refundTo ? <ExplorerLink kind="address" value={deposit.refundTo} /> : t('refundKeyOnly')}
        </dd>
      </div>
    </dl>
  )
}
