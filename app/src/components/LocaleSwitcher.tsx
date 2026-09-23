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

  // What shows is a label ("ES" on a phone, "Español" otherwise); the real select lies transparent on top of it,
  // so tapping still opens the system picker and the header keeps its room for the wallet.
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="sr-only sm:not-sr-only sm:text-slate-500">{t('language')}</span>
      <span
        className="relative inline-flex items-center rounded-md bg-white bg-no-repeat py-1.5 pl-2.5 pr-7 text-sm
          text-slate-500 shadow-sm focus-within:outline focus-within:outline-2 focus-within:outline-offset-2
          focus-within:outline-teal-700 sm:pl-3 sm:pr-9"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='%2364748b'%3E%3Cpath fill-rule='evenodd' d='M5.23 7.21a.75.75 0 011.06.02L10 10.94l3.71-3.71a.75.75 0 111.06 1.06l-4.24 4.25a.75.75 0 01-1.06 0L5.21 8.27a.75.75 0 01.02-1.06z' clip-rule='evenodd'/%3E%3C/svg%3E\")",
          backgroundPosition: 'right 0.5rem center',
          backgroundSize: '1rem',
        }}
      >
        <span aria-hidden="true" className="sm:hidden">
          {locale.toUpperCase()}
        </span>
        <span aria-hidden="true" className="hidden sm:inline">
          {LABELS[locale as Locale]}
        </span>
        {/* 16px so iOS does not zoom the page when the picker opens. */}
        <select
          className="absolute inset-0 h-full w-full cursor-pointer appearance-none text-base opacity-0"
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
      </span>
    </label>
  )
}
