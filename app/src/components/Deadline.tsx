import { RelativeTime } from '@/components/RelativeTime'
import { timestamp } from '@/lib/format'

/** An absolute UTC deadline with a live countdown, or the given fallback when there is none. */
export function Deadline({ seconds, none }: { seconds: number | null | undefined; none: string }) {
  if (!seconds) return <span className="text-slate-700">{none}</span>
  return (
    <span className="text-slate-800">
      <time dateTime={new Date(seconds * 1000).toISOString()}>{timestamp(seconds)}</time>
      <RelativeTime seconds={seconds} />
    </span>
  )
}
