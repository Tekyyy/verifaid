import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { ExplorerLink } from '@/components/ExplorerLink'
import { EmptyState, IndexerNotice } from '@/components/Notice'
import { Link } from '@/i18n/navigation'
import { amount, shorten, timestamp } from '@/lib/format'
import { getSupplierApplications, getSuppliers } from '@/lib/indexer'

export const dynamic = 'force-dynamic'

export async function generateMetadata({
  params: { locale },
}: {
  params: { locale: string }
}): Promise<Metadata> {
  const t = await getTranslations({ locale, namespace: 'suppliers' })
  return { title: t('title') }
}

/**
 * The public directory of registered suppliers: the vetted providers a need's payment plan may name, and what
 * vaults have paid each of them. Registration is an admin decision on chain (SUPPLIER_ROLE), so this page is a
 * view of who the system currently considers payable, not a marketplace.
 */
export default async function SuppliersPage() {
  const t = await getTranslations('suppliers')
  const tCommon = await getTranslations('common')
  const suppliers = await getSuppliers()
  const applications = await getSupplierApplications()
  const pending = applications.ok ? applications.data.filter((row) => !row.registered) : []
  const unit = tCommon('amountUnit')

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-700">{t('subtitle')}</p>
        <p className="mt-2 text-sm">
          <Link className="link" href="/suppliers/apply">
            {t('applyCta')}
          </Link>
        </p>
      </header>

      {!suppliers.ok ? <IndexerNotice error={suppliers.error} /> : null}
      {suppliers.ok && suppliers.data.length === 0 ? (
        <EmptyState title={t('empty')} body={t('emptyBody')} />
      ) : null}

      {pending.length > 0 ? (
        <section aria-labelledby="applications" className="space-y-3">
          <h2 id="applications" className="section-title">
            {t('applicationsTitle')}
          </h2>
          <p className="text-sm text-slate-700">{t('applicationsNote')}</p>
          <ul className="grid gap-3 sm:grid-cols-2">
            {pending.map((application) => (
              <li key={application.uid} className="card">
                <p className="font-semibold text-slate-900">{application.name}</p>
                <p className="mono text-xs text-slate-600">{application.supplier}</p>
                <p className="mt-2 text-sm text-slate-800">{application.services}</p>
                <p className="mt-2 flex flex-wrap items-center gap-x-2 text-xs text-slate-600">
                  <span className="badge bg-amber-100 text-amber-900">{t('applicationPending')}</span>
                  <span>{timestamp(application.timestamp)}</span>
                  <ExplorerLink kind="attestation" value={application.uid} />
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {suppliers.ok && suppliers.data.length > 0 ? (
        <ul className="grid gap-3 sm:grid-cols-2">
          {suppliers.data.map((supplier) => (
            <li key={supplier.address} className="card">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Link className="link mono text-sm" href={`/suppliers/${supplier.address}`}>
                  {shorten(supplier.address, 8, 6)}
                </Link>
                <span
                  className={`badge ${supplier.active ? 'bg-emerald-100 text-emerald-900' : 'bg-slate-100 text-slate-700'}`}
                >
                  {supplier.active ? t('active') : t('removed')}
                </span>
              </div>
              <dl className="mt-3 space-y-1 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-600">{t('paid')}</dt>
                  <dd className="tabular-nums text-slate-900">
                    {amount(supplier.totalPaid)} {unit}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-600">{t('needs')}</dt>
                  <dd className="tabular-nums text-slate-900">{supplier.needIds.length}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-600">{t('registered')}</dt>
                  <dd className="text-slate-900">{timestamp(supplier.registeredAt)}</dd>
                </div>
              </dl>
              <p className="mt-2 text-xs">
                <ExplorerLink kind="address" value={supplier.address} />
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
