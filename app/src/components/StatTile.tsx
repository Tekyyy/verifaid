import type { ReactNode } from 'react'

/** One figure in a row of figures: a label, the number, and an optional line under it. Use inside a `<dl>`. */
export function StatTile({
  label,
  value,
  hint,
  size = 'md',
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  size?: 'sm' | 'md' | 'lg'
}) {
  const valueClass = size === 'lg' ? 'text-3xl' : size === 'sm' ? 'text-lg' : 'text-2xl'
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <dt className="text-xs font-medium text-slate-600">{label}</dt>
      <dd className={`mt-1 font-bold tabular-nums text-teal-700 ${valueClass}`}>{value}</dd>
      {hint ? <dd className="mt-0.5 text-xs text-slate-500">{hint}</dd> : null}
    </div>
  )
}
