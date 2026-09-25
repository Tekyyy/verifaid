import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { ExplorerLink } from '@/components/ExplorerLink'
import { IndexerNotice, Notice } from '@/components/Notice'
import { Link } from '@/i18n/navigation'
import { amount, shorten, timestamp } from '@/lib/format'
import { getSupplier } from '@/lib/indexer'

export const dynamic = 'force-dynamic'

export async function generateMetadata(props: {
  params: Promise<{ locale: string; address: string }>
}): Promise<Metadata> {
  const params = await props.params

  const { locale, address } = params

  const t = await getTranslations({ locale, namespace: 'suppliers' })
  return { title: `${t('one')} ${shorten(address, 8, 6)}` }
}

/**
 * One registered supplier: its credential, the needs whose payment plan names it, and every payment a vault
 * made to it. Each row is a vault event with its transaction, so a donor can check the money themselves.
 */
export default async function SupplierPage(props: { params: Promise<{ address: string }> }) {
  const params = await props.params
  const t = await getTranslations('suppliers')
  const tCommon = await getTranslations('common')
  const tErrors = await getTranslations('errors')
  const supplier = await getSupplier(params.address)
  const unit = tCommon('amountUnit')

  if (!supplier.ok) {
    return supplier.error.status === 404 ? (
      <Notice tone="error" title={tErrors('notFoundTitle')}>
        {t('notFound')}
      </Notice>
    ) : (
      <IndexerNotice error={supplier.error} />
    )
  }

  const data = supplier.data

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs uppercase tracking-wide text-slate-600">{t('one')}</p>
        <h1 className="mono text-xl font-bold tracking-tight">{data.address}</h1>
        <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <span
            className={`badge ${data.active ? 'bg-emerald-100 text-emerald-900' : 'bg-slate-100 text-slate-700'}`}
          >
            {data.active ? t('active') : t('removed')}
          </span>
          <ExplorerLink kind="address" value={data.address} />
        </p>
      </header>

      <section className="card" aria-labelledby="supplier-facts">
        <h2 id="supplier-facts" className="section-title">
          {t('factsTitle')}
        </h2>
        <dl className="mt-3 space-y-2 text-sm">
          <div className="grid gap-1 sm:grid-cols-3">
            <dt className="text-slate-600">{t('paid')}</dt>
            <dd className="tabular-nums text-slate-900 sm:col-span-2">
              {amount(data.totalPaid)} {unit}
            </dd>
          </div>
          <div className="grid gap-1 sm:grid-cols-3">
            <dt className="text-slate-600">{t('registered')}</dt>
            <dd className="text-slate-900 sm:col-span-2">{timestamp(data.registeredAt)}</dd>
          </div>
          <div className="grid gap-1 sm:grid-cols-3">
            <dt className="text-slate-600">{t('credential')}</dt>
            <dd className="mono break-all text-xs text-slate-800 sm:col-span-2">{data.credentialHash}</dd>
          </div>
          <div className="grid gap-1 sm:grid-cols-3">
            <dt className="text-slate-600">{t('profile')}</dt>
            <dd className="break-all text-slate-800 sm:col-span-2">{data.metadataURI || '—'}</dd>
          </div>
          <div className="grid gap-1 sm:grid-cols-3">
            <dt className="text-slate-600">{t('needs')}</dt>
            <dd className="sm:col-span-2">
              {data.needIds.length > 0 ? (
                <ul className="flex flex-wrap gap-2">
                  {data.needIds.map((id) => (
                    <li key={id}>
                      <Link className="link" href={`/needs/${id}`}>
                        #{id}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="text-slate-600">{tErrors('empty')}</span>
              )}
            </dd>
          </div>
        </dl>
      </section>

      <section className="card" aria-labelledby="supplier-payments">
        <h2 id="supplier-payments" className="section-title">
          {t('paymentsTitle')}
        </h2>
        <p className="mt-1 text-sm text-slate-700">{t('paymentsNote')}</p>
        {data.payments.length === 0 ? (
          <p className="mt-3 text-sm text-slate-600">{tErrors('empty')}</p>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            {data.payments.map((payment) => (
              <li
                key={`${payment.txHash}-${payment.needId}-${payment.trancheIndex}`}
                className="flex flex-wrap items-center gap-x-2 gap-y-1"
              >
                <span className="font-semibold tabular-nums">
                  {amount(payment.amount)} {unit}
                </span>
                <span className="text-slate-700">
                  {t('paymentLine', { need: payment.needId, index: payment.trancheIndex + 1 })}
                </span>
                {payment.held ? <span className="badge bg-amber-100 text-amber-900">{t('held')}</span> : null}
                <span className="text-xs text-slate-500">{timestamp(payment.timestamp)}</span>
                <ExplorerLink kind="tx" value={payment.txHash} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
