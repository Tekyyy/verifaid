'use client'

import { CATEGORIES, NEED_STATUS } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'

export interface NeedFilterValues {
  status?: string
  category?: string
  region?: string
}

/**
 * A plain form: it submits on "Apply" and works with the keyboard alone. Filters live in the URL so a
 * filtered list can be linked to and read by the server component that renders it.
 */
export function NeedFilters({ values }: { values: NeedFilterValues }) {
  const t = useTranslations('needs')
  const tCommon = useTranslations('common')
  const tStatus = useTranslations('needStatus')
  const router = useRouter()

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const params = new URLSearchParams()
    for (const key of ['status', 'category', 'region'] as const) {
      const value = String(form.get(key) ?? '').trim()
      if (value) params.set(key, value)
    }
    const query = params.toString()
    router.push(`/needs${query ? `?${query}` : ''}`)
  }

  return (
    <form className="card grid gap-3 sm:grid-cols-4" onSubmit={submit}>
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
