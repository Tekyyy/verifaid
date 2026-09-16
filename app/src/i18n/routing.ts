import { defineRouting } from 'next-intl/routing'

export const locales = ['en', 'es'] as const
export type Locale = (typeof locales)[number]

export const routing = defineRouting({
  locales,
  defaultLocale: 'en',
  // Always prefix so a shared link keeps the language it was read in.
  localePrefix: 'always',
  localeDetection: true,
})

export const isLocale = (value: string): value is Locale => (locales as readonly string[]).includes(value)
