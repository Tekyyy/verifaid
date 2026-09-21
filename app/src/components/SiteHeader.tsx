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
    <header className="sticky top-0 z-40 border-b border-slate-200/80 bg-white/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
        <Link
          href="/"
          className="flex items-center gap-2 text-[15px] font-semibold tracking-tight text-slate-900 no-underline"
        >
          <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-indigo-700" />
          {tCommon('appName')}
        </Link>

        <div className="order-3 w-full sm:order-none sm:w-auto">
          <SiteNav />
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span
            className="hidden rounded-full border border-slate-200 px-2.5 py-0.5 text-xs font-medium text-slate-600 sm:inline-flex"
            title={tCommon('network')}
          >
            {chain.name}
          </span>
          <LocaleSwitcher />
          <ConnectButton />
        </div>
      </div>
    </header>
  )
}
