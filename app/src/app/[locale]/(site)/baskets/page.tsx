import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { IndexerNotice } from '@/components/Notice'
import { Link } from '@/i18n/navigation'
import { basketName } from '@/lib/baskets'
import { amount, categoryIcon } from '@/lib/format'
import { getBaskets } from '@/lib/indexer'

export const dynamic = 'force-dynamic'

export async function generateMetadata(props: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const params = await props.params

  const { locale } = params

  const t = await getTranslations({ locale, namespace: 'baskets' })
  return { title: t('title') }
}

/**
 * Giving baskets: a cause instead of a need. One gift is split equally, by the contract, between every need of a
 * category raising money right now, and each part is an ordinary donation in the giver's name. A basket holds no
 * money of its own; what it shows is what its needs still need and what its category has delivered.
 */
export default async function BasketsPage() {
  const t = await getTranslations('baskets')
  const tCommon = await getTranslations('common')
  const baskets = await getBaskets()
  const unit = tCommon('amountUnit')

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-700">{t('subtitle')}</p>
      </header>

      <section aria-labelledby="basket-how">
        <h2 id="basket-how" className="sr-only">
          {t('howTitle')}
        </h2>
        <ol className="grid gap-3 sm:grid-cols-3">
          {(['how1', 'how2', 'how3'] as const).map((step, index) => (
            <li key={step} className="card">
              <p className="text-xs font-semibold uppercase tracking-wide text-teal-800">{index + 1}</p>
              <p className="mt-1 text-sm text-slate-800">{t(step)}</p>
            </li>
          ))}
        </ol>
      </section>

      {!baskets.ok ? <IndexerNotice error={baskets.error} /> : null}

      {baskets.ok ? (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {baskets.data.map((basket) => {
            const name = basketName(t, basket.category)
            const open = basket.openNeedIds.length
            const href = `/baskets/${basket.category.toLowerCase()}`
            return (
              <li key={basket.id} className="card flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <span
                    className="flex h-12 w-12 flex-none items-center justify-center rounded-lg bg-teal-50 text-2xl"
                    aria-hidden="true"
                  >
                    {categoryIcon(basket.category)}
                  </span>
                  <div className="min-w-0">
                    <h2 className="text-base font-semibold leading-tight">
                      <Link className="text-slate-900 no-underline hover:underline" href={href}>
                        {name}
                      </Link>
                    </h2>
                    <p className="text-xs text-slate-600">{t('openNeeds', { count: open })}</p>
                  </div>
                </div>

                {open > 0 ? (
                  <p className="text-sm font-semibold tabular-nums text-slate-900">
                    {t('stillNeeded', { amount: amount(basket.stillNeeded), unit })}
                  </p>
                ) : null}

                <div className="space-y-0.5 text-xs text-slate-600">
                  <p>{t('given', { amount: amount(basket.givenThroughBasket), unit })}</p>
                  <p>
                    {t('record', {
                      completed: basket.needsCompleted,
                      total: basket.needsTotal,
                      released: amount(basket.released),
                      unit,
                    })}
                  </p>
                </div>

                <p className="mt-auto pt-1 text-sm">
                  <Link className="link" href={href}>
                    {open > 0 ? t('cta') : t('view')}
                  </Link>
                </p>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}
