import type { Metadata, Viewport } from 'next'
import { notFound } from 'next/navigation'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import type { ReactNode } from 'react'
import { isLocale, locales } from '@/i18n/routing'
import '../globals.css'

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#312e81',
}

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }))
}

export async function generateMetadata(props: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const params = await props.params

  const { locale } = params

  const t = await getTranslations({ locale, namespace: 'common' })
  return {
    title: { default: t('appName'), template: `%s · ${t('appName')}` },
    description: t('tagline'),
  }
}

/**
 * Root layout. It deliberately does not mount `NextIntlClientProvider`: each route group decides which
 * message namespaces reach the browser, which is how `/confirm` stays small on a low-end phone.
 */
export default async function LocaleLayout(props: {
  children: ReactNode
  params: Promise<{ locale: string }>
}) {
  const params = await props.params

  const { locale } = params

  const { children } = props

  if (!isLocale(locale)) notFound()
  setRequestLocale(locale)

  return (
    <html lang={locale}>
      <body className="min-h-screen">{children}</body>
    </html>
  )
}
