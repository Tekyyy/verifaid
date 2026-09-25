import { NEED_SORTS, type NeedSort } from '@poa/shared'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { NeedCard } from '@/components/NeedCard'
import { NeedFilters } from '@/components/NeedFilters'
import { EmptyState, IndexerNotice } from '@/components/Notice'
import { Link } from '@/i18n/navigation'
import { type NeedFilters as Filters, getNeeds } from '@/lib/indexer'

export const dynamic = 'force-dynamic'

export async function generateMetadata(props: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const params = await props.params

  const { locale } = params

  const t = await getTranslations({ locale, namespace: 'needs' })
  return { title: t('title') }
}

const single = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value

const oneOf = <T extends string>(options: readonly T[], value: string | undefined): T | undefined =>
  options.find((option) => option === value)

export default async function NeedsPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const searchParams = await props.searchParams
  const t = await getTranslations('needs')
  const country = single(searchParams.country)?.trim().toUpperCase()

  // The URL is the source of truth; anything that is not a known value is dropped rather than forwarded.
  const filters: Filters = {
    status: single(searchParams.status),
    category: single(searchParams.category),
    region: single(searchParams.region),
    country: country && /^[A-Z]{2}$/.test(country) ? country : undefined,
    open: single(searchParams.open) === 'true',
    sort: oneOf<NeedSort>(NEED_SORTS, single(searchParams.sort)),
  }
  const narrowed = Boolean(
    filters.status || filters.category || filters.region || filters.country || filters.open,
  )

  // Country options come from every need, not just the filtered page, so picking one never hides the others.
  const [needs, everything] = await Promise.all([
    getNeeds(filters),
    narrowed ? getNeeds({}) : Promise.resolve(null),
  ])
  const source = everything?.ok ? everything.data : needs.ok ? needs.data : []
  const countries = [...new Set([...source.map((need) => need.country), filters.country])]
    .filter((value): value is string => Boolean(value))
    .sort()

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
        <p className="mt-1 text-sm text-slate-700">{t('subtitle')}</p>
        <p className="mt-2 text-sm">
          <Link className="link" href="/baskets">
            {t('basketsHint')}
          </Link>
        </p>
      </header>

      <NeedFilters values={filters} countries={countries} />

      {!needs.ok ? (
        <IndexerNotice error={needs.error} />
      ) : needs.data.length === 0 ? (
        <EmptyState title={t('emptyTitle')} body={t('emptyBody')} />
      ) : (
        <>
          <p className="text-sm text-slate-600">{t('count', { count: needs.data.length })}</p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {needs.data.map((need) => (
              <NeedCard key={need.id} need={need} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
