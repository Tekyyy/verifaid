import { MAX_BASKET_NEEDS } from '@poa/shared'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { BasketDonatePanel } from '@/components/BasketDonatePanel'
import { ExplorerLink } from '@/components/ExplorerLink'
import { NeedCard } from '@/components/NeedCard'
import { EmptyState, IndexerNotice, Notice } from '@/components/Notice'
import { Link } from '@/i18n/navigation'
import { basketName } from '@/lib/baskets'
import { amount, categoryIcon, shorten, timestamp } from '@/lib/format'
import { getBasket } from '@/lib/indexer'

export const dynamic = 'force-dynamic'

export async function generateMetadata({
  params,
}: {
  params: { locale: string; category: string }
}): Promise<Metadata> {
  const t = await getTranslations({ locale: params.locale, namespace: 'baskets' })
  return { title: t('donateTitle', { name: basketName(t, params.category) }) }
}

/** One basket: the needs a gift to it would be split between, the form to give, and the gifts it has had. */
export default async function BasketPage({ params }: { params: { category: string } }) {
  const t = await getTranslations('baskets')
  const tCommon = await getTranslations('common')
  const tErrors = await getTranslations('errors')
  const basket = await getBasket(params.category)
  const unit = tCommon('amountUnit')

  if (!basket.ok) {
    return basket.error.kind === 'http' && basket.error.status === 404 ? (
      <Notice tone="error" title={tErrors('notFoundTitle')}>
        <Link className="link" href="/baskets">
          {t('back')}
        </Link>
      </Notice>
    ) : (
      <IndexerNotice error={basket.error} />
    )
  }

  const data = basket.data
  const name = basketName(t, data.category)
  // What each need can still take, for the split preview; the contract recomputes it when the gift lands.
  const rooms = data.needs.map((need) => ({ id: need.id, room: need.fundingGap }))

  return (
    <div className="space-y-6">
      <p className="text-sm">
        <Link className="link" href="/baskets">
          {t('back')}
        </Link>
      </p>
      <header className="flex items-center gap-3">
        <span
          className="flex h-14 w-14 flex-none items-center justify-center rounded-xl bg-teal-50 text-3xl"
          aria-hidden="true"
        >
          {categoryIcon(data.category)}
        </span>
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">{t('donateTitle', { name })}</h1>
          <p className="text-sm text-slate-700">
            {t('openNeeds', { count: data.openNeedIds.length })}
            {data.openNeedIds.length > 0
              ? ` · ${t('stillNeeded', { amount: amount(data.stillNeeded), unit })}`
              : ''}
          </p>
          <p className="text-xs text-slate-600">
            {t('given', { amount: amount(data.givenThroughBasket), unit })} ·{' '}
            {t('record', {
              completed: data.needsCompleted,
              total: data.needsTotal,
              released: amount(data.released),
              unit,
            })}
          </p>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <aside className="space-y-4 lg:order-2">
          {data.needs.length > 0 ? (
            <BasketDonatePanel name={name} basket={data.id} needs={rooms} />
          ) : (
            <Notice title={name}>{t('closed')}</Notice>
          )}
        </aside>

        <div className="min-w-0 space-y-6 lg:order-1">
          <section aria-labelledby="basket-needs">
            <h2 id="basket-needs" className="section-title">
              {t('needsTitle')}
            </h2>
            <p className="mt-1 text-sm text-slate-600">{t('needsBody', { max: MAX_BASKET_NEEDS })}</p>
            {data.needs.length === 0 ? (
              <div className="mt-3">
                <EmptyState title={t('closed')} />
              </div>
            ) : (
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                {data.needs.map((need) => (
                  <NeedCard key={need.id} need={need} />
                ))}
              </div>
            )}
          </section>

          <section aria-labelledby="basket-gifts" className="card">
            <h2 id="basket-gifts" className="section-title">
              {t('giftsTitle')}
            </h2>
            {data.recentGifts.length === 0 ? (
              <p className="mt-2 text-sm text-slate-600">{t('noGifts')}</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {data.recentGifts.map((gift) => (
                  <li key={gift.id} className="rounded-md border border-slate-200 px-3 py-2 text-xs">
                    <p className="font-semibold tabular-nums">
                      {t('giftLine', {
                        amount: amount(BigInt(gift.total) - BigInt(gift.returned)),
                        unit,
                        count: gift.needs.length,
                      })}
                      {gift.fromCredit ? (
                        <span className="ml-2 font-normal text-amber-900">{t('fromCredit')}</span>
                      ) : null}
                    </p>
                    <p className="mt-1 text-slate-600">
                      {gift.needs.map((part, index) => (
                        <span key={part.needId}>
                          {index > 0 ? ' · ' : ''}
                          <Link className="link" href={`/needs/${part.needId}`}>
                            #{part.needId}
                          </Link>{' '}
                          {amount(part.amount)}
                        </span>
                      ))}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="text-slate-600">{shorten(gift.donor)}</span>
                      <ExplorerLink kind="tx" value={gift.txHash} />
                      <span className="text-slate-500">{timestamp(gift.timestamp)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
