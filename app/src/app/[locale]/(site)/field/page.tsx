import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { FieldConsole } from '@/components/FieldConsole'

export async function generateMetadata({
  params: { locale },
}: {
  params: { locale: string }
}): Promise<Metadata> {
  const t = await getTranslations({ locale, namespace: 'field' })
  return { title: t('title') }
}

export default async function FieldPage() {
  const t = await getTranslations('field')

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
        <p className="mt-1 text-sm text-slate-700">{t('subtitle')}</p>
      </header>
      <FieldConsole />
    </div>
  )
}
