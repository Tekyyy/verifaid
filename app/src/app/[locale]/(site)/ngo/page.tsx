import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { NgoConsole } from '@/components/NgoConsole'
import { NgoRoleNotice } from '@/components/NgoRoleNotice'
import { SectionJump } from '@/components/SectionJump'
import { Link } from '@/i18n/navigation'

export async function generateMetadata({
  params: { locale },
}: {
  params: { locale: string }
}): Promise<Metadata> {
  const t = await getTranslations({ locale, namespace: 'ngo' })
  return { title: t('title') }
}

export default async function NgoPage() {
  const t = await getTranslations('ngo')

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
          <p className="mt-1 text-sm text-slate-700">{t('subtitle')}</p>
        </div>
        <Link href="/ngo/manage" className="btn-primary">
          {t('manageButton')}
        </Link>
      </header>
      <NgoRoleNotice />
      <SectionJump label={t('jumpLabel')} placeholder={t('jumpPlaceholder')} />
      <NgoConsole />
    </div>
  )
}
