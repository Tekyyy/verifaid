import { Skeleton } from '@/components/Skeleton'

/** The need page is two columns of cards; this keeps the layout still while they load. */
export default function Loading() {
  return (
    <div className="space-y-6" role="status" aria-busy="true">
      <Skeleton className="h-40 w-full" />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
        <div className="space-y-4">
          <Skeleton className="h-56 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    </div>
  )
}
