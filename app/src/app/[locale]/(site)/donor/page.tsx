import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { DonorTracePanel } from '@/components/DonorTracePanel'

export async function generateMetadata({
  params: { locale },
}: {
  params: { locale: string }
}): Promise<Metadata> {
  const t = await getTranslations({ locale, namespace: 'donor' })
  return { title: t('title') }
}

export default async function DonorPage() {
  const t = await getTranslations('donor')

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
        <p className="mt-1 text-sm text-slate-700">{t('subtitle')}</p>
      </header>
      <DonorTracePanel />
    </div>
  )
}
