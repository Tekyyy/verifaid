import { SkeletonPage } from '@/components/Skeleton'

/** Shown the instant a navigation starts, for every page in this group that has no closer skeleton. */
export default function Loading() {
  return <SkeletonPage />
}
