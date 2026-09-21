/**
 * What a page shows while its data is on the way. Next renders these the moment a link is clicked, so a
 * navigation paints immediately instead of leaving the previous page on screen — the difference between an app
 * that feels slow and one that feels busy.
 */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-slate-200/70 ${className}`} aria-hidden="true" />
}

export function SkeletonCard() {
  return (
    <div className="card space-y-3">
      <Skeleton className="h-4 w-2/5" />
      <Skeleton className="h-2 w-full" />
      <div className="grid grid-cols-2 gap-2">
        <Skeleton className="h-8" />
        <Skeleton className="h-8" />
        <Skeleton className="h-8" />
        <Skeleton className="h-8" />
      </div>
      <Skeleton className="h-3 w-3/5" />
    </div>
  )
}

/** A page header plus a grid of cards: the shape almost every list page in this app has. */
export function SkeletonPage({ cards = 6 }: { cards?: number }) {
  return (
    <div className="space-y-6" role="status" aria-busy="true">
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: cards }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
          <SkeletonCard key={index} />
        ))}
      </div>
    </div>
  )
}
