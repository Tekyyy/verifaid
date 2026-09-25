import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { UnsubscribeForm } from '@/components/UnsubscribeForm'

export async function generateMetadata(props: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const params = await props.params

  const { locale } = params

  const t = await getTranslations({ locale, namespace: 'alerts' })
  return { title: t('unsubscribeTitle'), robots: { index: false, follow: false } }
}

export default async function UnsubscribePage() {
  const t = await getTranslations('alerts')

  return (
    <div className="max-w-xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">{t('unsubscribeTitle')}</h1>
        <p className="mt-1 text-sm text-slate-700">{t('unsubscribeBody')}</p>
      </header>
      <UnsubscribeForm />
    </div>
  )
}
