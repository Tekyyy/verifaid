'use client'

import { type ReactNode, useEffect, useId, useState } from 'react'

export interface TabSpec<K extends string> {
  key: K
  label: string
  content: ReactNode
}

/**
 * The selected tab, kept in the URL (`?tab=…`) so a reload or a shared link opens the same one. Read after mount, so
 * the server render and the first client render agree on the default.
 */
export const useTabParam = <K extends string>(keys: readonly K[], fallback: K) => {
  const [active, setActive] = useState<K>(fallback)

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('tab')
    if (requested && (keys as readonly string[]).includes(requested)) setActive(requested as K)
  }, [keys])

  const select = (key: K) => {
    setActive(key)
    const url = new URL(window.location.href)
    url.searchParams.set('tab', key)
    window.history.replaceState(null, '', url)
  }
  return [active, select] as const
}

/**
 * Tabs whose panels all stay mounted (only hidden), so a half-filled form survives switching away and back.
 */
export function Tabs<K extends string>({
  tabs,
  active,
  onSelect,
  label,
}: {
  tabs: TabSpec<K>[]
  active: K
  onSelect: (key: K) => void
  /** Accessible name of the tab list. */
  label: string
}) {
  const id = useId()

  return (
    <div className="space-y-6">
      <div
        role="tablist"
        aria-label={label}
        className="no-scrollbar -mx-4 flex gap-1 overflow-x-auto border-b border-slate-200 px-4 sm:mx-0 sm:px-0"
      >
        {tabs.map((tab) => {
          const selected = tab.key === active
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              id={`${id}-tab-${tab.key}`}
              aria-selected={selected}
              aria-controls={`${id}-panel-${tab.key}`}
              onClick={() => onSelect(tab.key)}
              className={`-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors ${
                selected
                  ? 'border-teal-700 text-teal-800'
                  : 'border-transparent text-slate-600 hover:border-slate-300 hover:text-slate-900'
              }`}
            >
              {tab.label}
            </button>
          )
        })}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.key}
          role="tabpanel"
          id={`${id}-panel-${tab.key}`}
          aria-labelledby={`${id}-tab-${tab.key}`}
          hidden={tab.key !== active}
          className="space-y-6"
        >
          {tab.content}
        </div>
      ))}
    </div>
  )
}
