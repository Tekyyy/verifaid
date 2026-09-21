import { Skeleton, SkeletonPage } from '@/components/Skeleton'

export default function Loading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-28 w-full" />
      <SkeletonPage cards={6} />
    </div>
  )
}
