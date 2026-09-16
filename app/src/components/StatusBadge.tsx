import type { DeliveryStatus, NeedStatus, TrancheStatus } from '@poa/shared'
import { useTranslations } from 'next-intl'

const NEED_TONES: Record<NeedStatus, string> = {
  Pending: 'bg-slate-200 text-slate-800',
  Verified: 'bg-sky-100 text-sky-900',
  Funding: 'bg-indigo-100 text-indigo-900',
  Funded: 'bg-violet-100 text-violet-900',
  InDelivery: 'bg-amber-100 text-amber-900',
  Completed: 'bg-emerald-100 text-emerald-900',
  Cancelled: 'bg-red-100 text-red-900',
}

const DELIVERY_TONES: Record<DeliveryStatus, string> = {
  Open: 'bg-slate-200 text-slate-800',
  Challengeable: 'bg-amber-100 text-amber-900',
  Disputed: 'bg-orange-100 text-orange-900',
  Finalized: 'bg-emerald-100 text-emerald-900',
  Rejected: 'bg-red-100 text-red-900',
}

const TRANCHE_TONES: Record<TrancheStatus, string> = {
  Locked: 'bg-slate-200 text-slate-800',
  Releasable: 'bg-amber-100 text-amber-900',
  Released: 'bg-emerald-100 text-emerald-900',
}

export function NeedStatusBadge({ status }: { status: NeedStatus }) {
  const t = useTranslations('needStatus')
  return <span className={`badge ${NEED_TONES[status]}`}>{t(status)}</span>
}

export function DeliveryStatusBadge({ status }: { status: DeliveryStatus }) {
  const t = useTranslations('deliveryStatus')
  return <span className={`badge ${DELIVERY_TONES[status]}`}>{t(status)}</span>
}

export function TrancheStatusBadge({ status }: { status: TrancheStatus }) {
  const t = useTranslations('trancheStatus')
  return <span className={`badge ${TRANCHE_TONES[status]}`}>{t(status)}</span>
}
