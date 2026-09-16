import type { DonationOutcome, TrackingRefKind } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { Notice } from '@/components/Notice'

const TONE: Record<DonationOutcome, 'info' | 'warning' | 'success'> = {
  InProgress: 'info',
  Completed: 'success',
  Refundable: 'warning',
  Refunded: 'info',
  Expired: 'warning',
  Cancelled: 'warning',
}

/** How the donation ended up, in one sentence, with what the donor can do about it when there is anything. */
export function OutcomeBanner({ outcome, refKind }: { outcome: DonationOutcome; refKind: TrackingRefKind }) {
  const t = useTranslations('track')
  const refundHint =
    outcome === 'Refundable' || outcome === 'Expired' || outcome === 'Cancelled'
      ? t(refKind === 'receipt' ? 'refundHintWallet' : 'refundHintPayment')
      : null

  return (
    <Notice tone={TONE[outcome]} title={t(`outcome_${outcome}`)}>
      <p>{t(`outcomeBody_${outcome}`)}</p>
      {refundHint ? <p className="mt-1">{refundHint}</p> : null}
    </Notice>
  )
}
