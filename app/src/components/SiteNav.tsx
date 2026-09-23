'use client'

import { useTranslations } from 'next-intl'
import { useEffect, useRef } from 'react'
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
  const navRef = useRef<HTMLElement>(null)

  // On a phone the bar is one row that scrolls sideways; keep the page you are on in view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-centre after every navigation, not only on mount
  useEffect(() => {
    const current = navRef.current?.querySelector<HTMLElement>('[aria-current="page"]')
    const bar = navRef.current?.parentElement
    if (!current || !bar || bar.scrollWidth <= bar.clientWidth) return
    const offset = current.getBoundingClientRect().left - bar.getBoundingClientRect().left
    bar.scrollLeft += offset - (bar.clientWidth - current.offsetWidth) / 2
  }, [pathname])

  return (
    <nav
      ref={navRef}
      aria-label={tCommon('mainNavigation')}
      className="flex w-max items-center gap-2 sm:w-full sm:flex-wrap sm:justify-between sm:gap-x-2 sm:gap-y-1"
    >
      {PUBLIC_ROUTES.map((route) => (
        <NavLink key={route.href} href={route.href} current={isCurrent(route.href)}>
          {t(route.key)}
        </NavLink>
      ))}
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
      className={`shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-sm no-underline transition-all ${
        current
          ? 'bg-teal-600 font-semibold text-white shadow'
          : muted
            ? 'bg-white/60 font-normal text-slate-400 hover:bg-white hover:text-slate-600 hover:shadow-sm'
            : 'bg-white font-medium text-slate-500 shadow-sm hover:bg-slate-50 hover:shadow'
      }`}
    >
      {children}
    </Link>
  )
}
