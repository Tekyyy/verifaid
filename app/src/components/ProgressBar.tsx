export function ProgressBar({
  value,
  label,
  tone = 'teal',
}: {
  /** 0-100. */
  value: number
  label: string
  tone?: 'teal' | 'emerald'
}) {
  const clamped = Math.max(0, Math.min(100, value))
  const fill = tone === 'emerald' ? 'bg-emerald-600' : 'bg-teal-600'

  return (
    <div
      className="h-2.5 w-full overflow-hidden rounded-full bg-slate-200"
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div className={`h-full ${fill}`} style={{ width: `${clamped}%` }} />
    </div>
  )
}
