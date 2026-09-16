import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { NeedCard } from '@/components/NeedCard'
import { NeedFilters } from '@/components/NeedFilters'
import { EmptyState, IndexerNotice } from '@/components/Notice'
import { getNeeds } from '@/lib/indexer'

export const dynamic = 'force-dynamic'

export async function generateMetadata({
  params: { locale },
}: {
  params: { locale: string }
}): Promise<Metadata> {
  const t = await getTranslations({ locale, namespace: 'needs' })
  return { title: t('title') }
}

const single = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value

export default async function NeedsPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>
}) {
  const t = await getTranslations('needs')
  const filters = {
    status: single(searchParams.status),
    category: single(searchParams.category),
    region: single(searchParams.region),
  }
  const needs = await getNeeds(filters)

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
        <p className="mt-1 text-sm text-slate-700">{t('subtitle')}</p>
      </header>

      <NeedFilters values={filters} />

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
