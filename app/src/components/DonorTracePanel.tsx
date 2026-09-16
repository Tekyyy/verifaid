'use client'

import { useQuery } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useAccount } from 'wagmi'
import { DeliveryCard } from '@/components/DeliveryCard'
import { EmptyState, IndexerNotice, Notice } from '@/components/Notice'
import { TrancheBar } from '@/components/TrancheBar'
import { Link } from '@/i18n/navigation'
import { amount } from '@/lib/format'
import { useMounted } from '@/lib/hooks'
import { getDonorTrace } from '@/lib/indexer'

/** "Follow my money": the receipts this wallet holds and what each one paid for. */
export function DonorTracePanel() {
  const t = useTranslations('donor')
  const tCommon = useTranslations('common')
  const tErrors = useTranslations('errors')
  const mounted = useMounted()
  const { address, isConnected } = useAccount()

  const query = useQuery({
    queryKey: ['donor-trace', address],
    queryFn: () => getDonorTrace(address as string),
    enabled: Boolean(address),
  })

  if (!mounted) return <p className="text-sm text-slate-600">{tCommon('loading')}</p>
  if (!isConnected || !address) {
    return <Notice tone="info" title={tErrors('connectFirst')} />
  }
  if (query.isLoading) return <p className="text-sm text-slate-600">{tCommon('loading')}</p>
  if (!query.data) return null
  if (!query.data.ok) return <IndexerNotice error={query.data.error} />

  const trace = query.data.data

  if (trace.receipts.length === 0) {
    return <EmptyState title={t('emptyTitle')} body={t('emptyBody')} />
  }

  return (
    <div className="space-y-6">
      <div className="card">
        <p className="text-xs text-slate-600">{t('totalDonated')}</p>
        <p className="mt-1 text-2xl font-bold tabular-nums">
          {amount(trace.totalDonated)} {tCommon('amountUnit')}
        </p>
      </div>

      {trace.receipts.map((receipt) => (
        <section key={receipt.receiptId} className="card space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="section-title">{t('receipt', { id: receipt.receiptId })}</h2>
            <Link className="link text-sm" href={`/needs/${receipt.needId}`}>
              {t('need', { id: receipt.needId })}
            </Link>
          </div>

          <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
            <div>
              <dt className="text-slate-600">{t('amount')}</dt>
              <dd className="font-semibold tabular-nums">{amount(receipt.amount)}</dd>
            </div>
            <div>
              <dt className="text-slate-600">{t('share')}</dt>
              <dd className="font-semibold tabular-nums">{(receipt.shareBps / 100).toFixed(2)}%</dd>
            </div>
            <div>
              <dt className="text-slate-600">{t('releasedToNgo')}</dt>
              <dd className="font-semibold tabular-nums">{amount(receipt.releasedToNgo)}</dd>
            </div>
            <div>
              <dt className="text-slate-600">{t('refunded')}</dt>
              <dd className="font-semibold tabular-nums">{amount(receipt.refunded)}</dd>
            </div>
          </dl>

          {receipt.tranches.length > 0 ? (
            <div>
              <h3 className="text-sm font-semibold text-slate-800">{t('tranches')}</h3>
              <div className="mt-2">
                <TrancheBar tranches={receipt.tranches} />
              </div>
            </div>
          ) : null}

          {receipt.deliveries.length > 0 ? (
            <div>
              <h3 className="text-sm font-semibold text-slate-800">{t('deliveries')}</h3>
              <div className="mt-2 space-y-3">
                {receipt.deliveries.map((delivery) => (
                  <DeliveryCard key={delivery.id} delivery={delivery} />
                ))}
              </div>
            </div>
          ) : null}
        </section>
      ))}
    </div>
  )
}
