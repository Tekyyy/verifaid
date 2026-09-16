'use client'

import { useFormatter, useNow } from 'next-intl'
import { useMounted } from '@/lib/mounted'

/**
 * "in 3 days" / "2 hours ago", refreshed every half minute. Rendered only after mount: the server and the
 * browser disagree on "now", and the absolute UTC timestamp next to it is what an auditor relies on anyway.
 */
export function RelativeTime({ seconds }: { seconds: number }) {
  const mounted = useMounted()
  const format = useFormatter()
  const now = useNow({ updateInterval: 30_000 })
  if (!mounted) return null
  return <span className="text-slate-600"> ({format.relativeTime(new Date(seconds * 1000), now)})</span>
}
