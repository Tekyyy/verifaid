import type { Metadata } from 'next'
import { NextIntlClientProvider } from 'next-intl'
import { getMessages, setRequestLocale } from 'next-intl/server'
import type { ReactNode } from 'react'
import { isLocale } from '@/i18n/routing'

export const metadata: Metadata = { robots: { index: false, follow: false } }

/**
 * Chrome-less shell for embeddable widgets: no header, no footer, no wallet provider, and only the message
 * namespaces the widgets use. These routes are the only ones allowed inside a third-party iframe
 * (`frame-ancestors *`, set in next.config.mjs).
 */
export default async function EmbedLayout(props: {
  children: ReactNode
  params: Promise<{ locale: string }>
}) {
  const params = await props.params

  const { locale } = params

  const { children } = props

  if (isLocale(locale)) setRequestLocale(locale)
  const messages = await getMessages()

  return (
    <NextIntlClientProvider
      locale={locale}
      messages={{ common: messages.common, track: messages.track, errors: messages.errors }}
    >
      <main id="main">{children}</main>
    </NextIntlClientProvider>
  )
}
