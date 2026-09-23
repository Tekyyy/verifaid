import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { NgoNeedManagement } from '@/components/NgoConsole'
import { Link } from '@/i18n/navigation'

export async function generateMetadata({
  params: { locale },
}: {
  params: { locale: string }
}): Promise<Metadata> {
  const t = await getTranslations({ locale, namespace: 'ngo' })
  return { title: t('manageTitle') }
}

export default async function NgoManagePage() {
  const t = await getTranslations('ngo')

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('manageTitle')}</h1>
          <p className="mt-1 text-sm text-slate-700">{t('manageSubtitle')}</p>
        </div>
        <Link href="/ngo" className="btn-secondary">
          {t('backToSetup')}
        </Link>
      </header>
      <NgoNeedManagement />
    </div>
  )
}
