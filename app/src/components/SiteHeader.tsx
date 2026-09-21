import { useTranslations } from 'next-intl'
import { ConnectButton } from '@/components/ConnectButton'
import { LocaleSwitcher } from '@/components/LocaleSwitcher'
import { Link } from '@/i18n/navigation'
import { chain } from '@/lib/config'

const ROUTES = [
  { href: '/needs', key: 'needs' },
  { href: '/impact', key: 'impact' },
  { href: '/suppliers', key: 'suppliers' },
  { href: '/track', key: 'track' },
  { href: '/donor', key: 'donor' },
  { href: '/ngo', key: 'ngo' },
  { href: '/verifier', key: 'verifier' },
  { href: '/field', key: 'field' },
] as const

export function SiteHeader() {
  const t = useTranslations('nav')
  const tCommon = useTranslations('common')

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
        <Link href="/" className="text-base font-bold text-slate-900 no-underline">
          {tCommon('appName')}
        </Link>

        <nav aria-label={tCommon('mainNavigation')} className="order-3 w-full sm:order-none sm:w-auto">
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {ROUTES.map((route) => (
              <li key={route.href}>
                <Link
                  className="text-slate-700 no-underline hover:text-indigo-800 hover:underline"
                  href={route.href}
                >
                  {t(route.key)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="ml-auto flex flex-wrap items-center gap-3">
          <span className="badge bg-slate-100 text-slate-700" title={tCommon('network')}>
            {chain.name}
          </span>
          <LocaleSwitcher />
          <ConnectButton />
        </div>
      </div>
    </header>
  )
}
