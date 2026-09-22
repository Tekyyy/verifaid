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
      <span className="sr-only sm:not-sr-only sm:text-slate-500">{t('language')}</span>
      <select
        className="appearance-none rounded-md bg-white bg-no-repeat py-1.5 pl-3 pr-9 text-sm text-slate-500 shadow-sm"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='%2364748b'%3E%3Cpath fill-rule='evenodd' d='M5.23 7.21a.75.75 0 011.06.02L10 10.94l3.71-3.71a.75.75 0 111.06 1.06l-4.24 4.25a.75.75 0 01-1.06 0L5.21 8.27a.75.75 0 01.02-1.06z' clip-rule='evenodd'/%3E%3C/svg%3E\")",
          backgroundPosition: 'right 0.6rem center',
          backgroundSize: '1rem',
        }}
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
