import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { SupplierApplyPanel } from '@/components/SupplierApplyPanel'
import { Link } from '@/i18n/navigation'

export const dynamic = 'force-dynamic'

export async function generateMetadata({
  params: { locale },
}: {
  params: { locale: string }
}): Promise<Metadata> {
  const t = await getTranslations({ locale, namespace: 'suppliers' })
  return { title: t('applyTitle') }
}

/** Anyone can ask to be registered; an admin still decides. The request itself is public and signed. */
export default async function SupplierApplyPage() {
  const t = await getTranslations('suppliers')

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">{t('applyTitle')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-700">{t('applyLead')}</p>
        <p className="mt-2 text-sm">
          <Link className="link" href="/suppliers">
            {t('applyBack')}
          </Link>
        </p>
      </header>

      <SupplierApplyPanel />
    </div>
  )
}
