'use client'

import { CATEGORIES, CUSTODY_MODE, NEED_SORTS, NEED_STATUS } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { flagEmoji } from '@/lib/format'
import type { NeedFilters as NeedFilterValues } from '@/lib/indexer'

const TEXT_KEYS = ['status', 'category', 'region', 'country', 'custody', 'sort'] as const

/**
 * A plain form: it submits on "Apply" and works with the keyboard alone. Filters live in the URL so a
 * filtered list can be linked to and read by the server component that renders it.
 */
export function NeedFilters({ values, countries }: { values: NeedFilterValues; countries: string[] }) {
  const t = useTranslations('needs')
  const tCommon = useTranslations('common')
  const tStatus = useTranslations('needStatus')
  const tCustody = useTranslations('custody')
  const router = useRouter()

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const params = new URLSearchParams()
    for (const key of TEXT_KEYS) {
      const value = String(form.get(key) ?? '').trim()
      if (value) params.set(key, value)
    }
    if (form.get('open') === 'true') params.set('open', 'true')
    const query = params.toString()
    router.push(`/needs${query ? `?${query}` : ''}`)
  }

  return (
    <form className="card grid gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={submit}>
      <div>
        <label className="label" htmlFor="filter-status">
          {t('filterStatus')}
        </label>
        <select id="filter-status" name="status" className="input" defaultValue={values.status ?? ''}>
          <option value="">{tCommon('all')}</option>
          {NEED_STATUS.map((status) => (
            <option key={status} value={status}>
              {tStatus(status)}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="label" htmlFor="filter-category">
          {t('filterCategory')}
        </label>
        <select id="filter-category" name="category" className="input" defaultValue={values.category ?? ''}>
          <option value="">{tCommon('all')}</option>
          {CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {category}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="label" htmlFor="filter-country">
          {t('filterCountry')}
        </label>
        <select id="filter-country" name="country" className="input" defaultValue={values.country ?? ''}>
          <option value="">{tCommon('all')}</option>
          {countries.map((country) => (
            <option key={country} value={country}>
              {`${flagEmoji(country)} ${country}`.trim()}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="label" htmlFor="filter-region">
          {t('filterRegion')}
        </label>
        <input
          id="filter-region"
          name="region"
          className="input"
          defaultValue={values.region ?? ''}
          placeholder={t('filterRegionPlaceholder')}
        />
      </div>

      <div>
        <label className="label" htmlFor="filter-custody">
          {t('filterCustody')}
        </label>
        <select id="filter-custody" name="custody" className="input" defaultValue={values.custody ?? ''}>
          <option value="">{tCommon('all')}</option>
          {CUSTODY_MODE.map((mode) => (
            <option key={mode} value={mode}>
              {tCustody(mode)}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="label" htmlFor="filter-sort">
          {t('sort')}
        </label>
        <select id="filter-sort" name="sort" className="input" defaultValue={values.sort ?? ''}>
          <option value="">{t('sortDefault')}</option>
          {NEED_SORTS.map((sort) => (
            <option key={sort} value={sort}>
              {t(`sort_${sort}`)}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-end">
        <label className="flex min-h-[44px] items-center gap-2 text-sm font-medium text-slate-700">
          <input type="checkbox" name="open" value="true" defaultChecked={values.open ?? false} />
          {t('filterOpen')}
        </label>
      </div>

      <div className="flex items-end gap-2">
        <button type="submit" className="btn-primary">
          {tCommon('apply')}
        </button>
        <button type="button" className="btn-secondary" onClick={() => router.push('/needs')}>
          {tCommon('reset')}
        </button>
      </div>
    </form>
  )
}
