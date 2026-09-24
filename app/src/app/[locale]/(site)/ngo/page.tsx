import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { NgoConsole } from '@/components/NgoConsole'
import { NgoRoleNotice } from '@/components/NgoRoleNotice'

export async function generateMetadata({
  params: { locale },
}: {
  params: { locale: string }
}): Promise<Metadata> {
  const t = await getTranslations({ locale, namespace: 'ngo' })
  return { title: t('title') }
}

/** The console draws its own header (who is signed in, and the two main actions) above its tabs. */
export default function NgoPage() {
  return (
    <div className="space-y-6">
      <NgoRoleNotice />
      <NgoConsole />
    </div>
  )
}
