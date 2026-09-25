import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { TrackForm } from '@/components/TrackForm'

export async function generateMetadata(props: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const params = await props.params

  const { locale } = params

  const t = await getTranslations({ locale, namespace: 'track' })
  return { title: t('title') }
}

export default async function TrackIndexPage() {
  const t = await getTranslations('track')

  return (
    <div className="max-w-2xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
        <p className="mt-1 text-sm text-slate-700">{t('subtitle')}</p>
      </header>
      <TrackForm />
      <p className="text-sm text-slate-700">{t('privacyNote')}</p>
    </div>
  )
}
