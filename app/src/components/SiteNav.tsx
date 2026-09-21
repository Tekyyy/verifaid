'use client'

import { useTranslations } from 'next-intl'
import { Link, usePathname } from '@/i18n/navigation'

/**
 * What anyone comes here to do, then the tools for the people who run it. The split is visual only — both are
 * public pages — but it keeps the bar readable: a donor never has to scan past "Field agent" to find "Needs".
 */
const PUBLIC_ROUTES = [
  { href: '/needs', key: 'needs' },
  { href: '/impact', key: 'impact' },
  { href: '/suppliers', key: 'suppliers' },
  { href: '/track', key: 'track' },
] as const

const ROLE_ROUTES = [
  { href: '/donor', key: 'donor' },
  { href: '/ngo', key: 'ngo' },
  { href: '/verifier', key: 'verifier' },
  { href: '/field', key: 'field' },
] as const

export function SiteNav() {
  const t = useTranslations('nav')
  const tCommon = useTranslations('common')
  const pathname = usePathname()
  const isCurrent = (href: string) => pathname === href || pathname.startsWith(`${href}/`)

  return (
    <nav
      aria-label={tCommon('mainNavigation')}
      className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1"
    >
      {PUBLIC_ROUTES.map((route) => (
        <NavLink key={route.href} href={route.href} current={isCurrent(route.href)}>
          {t(route.key)}
        </NavLink>
      ))}
      <span aria-hidden="true" className="mx-1 hidden h-4 w-px bg-slate-200 sm:block" />
      {ROLE_ROUTES.map((route) => (
        <NavLink key={route.href} href={route.href} current={isCurrent(route.href)} muted>
          {t(route.key)}
        </NavLink>
      ))}
    </nav>
  )
}

function NavLink({
  href,
  current,
  muted = false,
  children,
}: {
  href: string
  current: boolean
  muted?: boolean
  children: React.ReactNode
}) {
  return (
    <Link
      href={href}
      aria-current={current ? 'page' : undefined}
      // prefetch: a click should not wait for the page to be fetched from scratch
      prefetch
      className={`rounded-md px-2.5 py-1.5 text-sm no-underline transition-colors ${
        current
          ? 'bg-slate-100 font-semibold text-slate-900'
          : muted
            ? 'font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-900'
            : 'font-medium text-slate-700 hover:bg-slate-100 hover:text-slate-900'
      }`}
    >
      {children}
    </Link>
  )
}
