'use client'

import { useSearchParams } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { useTransition } from 'react'
import { usePathname, useRouter } from '@/i18n/navigation'
import { type Locale, locales } from '@/i18n/routing'

const LABELS: Record<Locale, string> = { en: 'English', es: 'Español' }

/** Switches locale in place: same route, same query, different language prefix. */
export function LocaleSwitcher() {
  const t = useTranslations('common')
  const locale = useLocale()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const change = (next: string) => {
    const query = searchParams.toString()
    startTransition(() => {
      router.replace(`${pathname}${query ? `?${query}` : ''}`, { locale: next as Locale })
    })
  }

  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="sr-only sm:not-sr-only sm:text-slate-600">{t('language')}</span>
      <select
        className="min-h-[44px] rounded-md border border-slate-300 bg-white px-2 py-1 text-sm"
        value={locale}
        disabled={isPending}
        onChange={(event) => change(event.target.value)}
      >
        {locales.map((value) => (
          <option key={value} value={value}>
            {LABELS[value]}
          </option>
        ))}
      </select>
    </label>
  )
}
