import { NextIntlClientProvider } from 'next-intl'
import { getMessages, getTranslations, setRequestLocale } from 'next-intl/server'
import type { ReactNode } from 'react'
import { LocaleSwitcher } from '@/components/LocaleSwitcher'
import { isLocale } from '@/i18n/routing'

/**
 * The beneficiary page has its own shell: no wallet provider, no navigation, and only the two message
 * namespaces it uses are serialized into the HTML. Everything here is in service of a cheap first load on a
 * low-end phone.
 */
export default async function ConfirmLayout({
  children,
  params: { locale },
}: {
  children: ReactNode
  params: { locale: string }
}) {
  if (isLocale(locale)) setRequestLocale(locale)
  const messages = await getMessages()
  const t = await getTranslations({ locale, namespace: 'common' })

  return (
    <NextIntlClientProvider messages={{ common: messages.common, confirm: messages.confirm }} locale={locale}>
      <div className="mx-auto flex min-h-screen max-w-md flex-col px-4 pb-8">
        <header className="flex items-center justify-between py-3">
          <span className="text-sm font-bold">{t('appName')}</span>
          <LocaleSwitcher />
        </header>
        <main id="main" className="flex-1">
          {children}
        </main>
      </div>
    </NextIntlClientProvider>
  )
}
