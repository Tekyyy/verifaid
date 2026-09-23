import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { IndexerNotice } from '@/components/Notice'
import { VerifierQueue } from '@/components/VerifierQueue'
import { getNeeds } from '@/lib/indexer'

export const dynamic = 'force-dynamic'

export async function generateMetadata({
  params: { locale },
}: {
  params: { locale: string }
}): Promise<Metadata> {
  const t = await getTranslations({ locale, namespace: 'verifier' })
  return { title: t('title') }
}

export default async function VerifierPage() {
  const t = await getTranslations('verifier')
  const needs = await getNeeds({ status: 'Pending' })

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
        <p className="mt-1 text-sm text-slate-700">{t('subtitle')}</p>
      </header>

      {!needs.ok ? <IndexerNotice error={needs.error} /> : null}

      <VerifierQueue needs={needs.ok ? needs.data : []} />
    </div>
  )
}
