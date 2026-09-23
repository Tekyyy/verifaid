import { useTranslations } from 'next-intl'
import { ConnectButton } from '@/components/ConnectButton'
import { LocaleSwitcher } from '@/components/LocaleSwitcher'
import { SiteNav } from '@/components/SiteNav'
import { Link } from '@/i18n/navigation'
import { chain } from '@/lib/config'

/**
 * Sticky, quiet, and out of the way: the page below it is the product. The network is stated because every
 * figure on this site comes from that chain and a testnet must never be mistaken for the real one.
 */
export function SiteHeader() {
  const tCommon = useTranslations('common')

  return (
    <header className="sticky top-0 z-40 border-b border-teal-200 bg-teal-100/50 backdrop-blur">
      <div className="mx-auto max-w-6xl px-4">
        {/* Fila 1: logo + wallet */}
        <div className="flex items-center justify-between gap-2 py-2 sm:gap-4 sm:py-3">
          <Link
            href="/"
            className="shrink-0 whitespace-nowrap text-2xl font-bold tracking-tight text-teal-700 no-underline sm:text-3xl"
          >
            {tCommon('appName')}
          </Link>

          <div className="flex min-w-0 items-center gap-2 sm:gap-4">
            <span
              className="hidden rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-xs font-medium text-slate-600 sm:inline-flex"
              title={tCommon('network')}
            >
              {chain.name}
            </span>
            <LocaleSwitcher />
            <ConnectButton />
          </div>
        </div>

        {/* Fila 2: navegación. En móvil, una sola fila que se desliza de lado en vez de tres filas apiladas. */}
        <div className="no-scrollbar -mx-4 overflow-x-auto px-4 pb-2 pt-1 sm:mx-0 sm:px-0 sm:pb-3 sm:pt-2.5">
          <SiteNav />
        </div>
      </div>
    </header>
  )
}
