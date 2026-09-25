import { NextIntlClientProvider } from 'next-intl'
import { getMessages, getTranslations, setRequestLocale } from 'next-intl/server'
import type { ReactNode } from 'react'
import { Providers } from '@/components/Providers'
import { SiteHeader } from '@/components/SiteHeader'
import { isLocale } from '@/i18n/routing'

/** Everything with a wallet and a navigation bar. `/confirm` deliberately sits outside this group. */
export default async function SiteLayout(props: {
  children: ReactNode
  params: Promise<{ locale: string }>
}) {
  const params = await props.params

  const { locale } = params

  const { children } = props

  if (isLocale(locale)) setRequestLocale(locale)
  const messages = await getMessages()
  const t = await getTranslations({ locale, namespace: 'common' })

  return (
    <NextIntlClientProvider messages={messages}>
      <Providers>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded
            focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:font-semibold"
        >
          {t('skipToContent')}
        </a>
        <SiteHeader />
        <main id="main" className="mx-auto max-w-6xl px-4 py-8">
          {children}
        </main>
        <footer className="border-t border-slate-200 bg-white">
          <div className="mx-auto max-w-6xl px-4 py-6 text-xs text-slate-600">{t('footer')}</div>
        </footer>
      </Providers>
    </NextIntlClientProvider>
  )
}
