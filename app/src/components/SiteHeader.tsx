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
    <header className="sticky top-0 z-40 border-b border-teal-150 bg-teal-100/50 backdrop-blur">
      <div className="mx-auto max-w-6xl px-4">
        {/* Fila 1: logo + wallet */}
        <div className="flex items-center justify-between gap-4 py-3">
          <Link
            href="/"
            className="shrink-0 whitespace-nowrap text-3xl font-bold tracking-tight text-teal-700 no-underline"
          >
            {tCommon('appName')}
          </Link>

          <div className="flex items-center gap-4">
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

        {/* Fila 2: navegación, con más aire respecto a la fila de arriba */}
        <div className="overflow-x-auto pb-3 pt-2.5">
          <SiteNav />
        </div>
      </div>
    </header>
  )
}