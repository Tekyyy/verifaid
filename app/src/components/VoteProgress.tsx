import type { DeliveryView } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { ProgressBar } from '@/components/ProgressBar'
import { amount, percent } from '@/lib/format'

/** How far each group with a say has got, for approving and for rejecting. Groups with no say are left out. */
export function VoteProgress({ delivery, unit }: { delivery: DeliveryView; unit: string }) {
  const t = useTranslations('need')
  const donors = delivery.requiredAmount !== '0'
  const verifiers = delivery.requiredVerifiers > 0

  return (
    <div className="space-y-2">
      {donors ? (
        <>
          <div>
            <ProgressBar
              tone="emerald"
              value={Math.min(100, percent(delivery.approvedAmount, delivery.requiredAmount))}
              label={t('approvalProgress', {
                approved: amount(delivery.approvedAmount),
                required: amount(delivery.requiredAmount),
                unit,
              })}
            />
            <p className="mt-1 text-xs text-slate-700">
              {t('approvalProgress', {
                approved: amount(delivery.approvedAmount),
                required: amount(delivery.requiredAmount),
                unit,
              })}
            </p>
          </div>
          <div>
            <ProgressBar
              tone="red"
              value={Math.min(100, percent(delivery.rejectedAmount, delivery.rejectionAmount))}
              label={t('rejectionProgress', {
                rejected: amount(delivery.rejectedAmount),
                required: amount(delivery.rejectionAmount),
                unit,
              })}
            />
            <p className="mt-1 text-xs text-slate-700">
              {t('rejectionProgress', {
                rejected: amount(delivery.rejectedAmount),
                required: amount(delivery.rejectionAmount),
                unit,
              })}
            </p>
          </div>
        </>
      ) : null}
      {verifiers ? (
        <p className="text-xs text-slate-700">
          {t('verifierProgress', {
            approved: delivery.verifierApprovals,
            rejected: delivery.verifierRejections,
            required: delivery.requiredVerifiers,
          })}
        </p>
      ) : null}
    </div>
  )
}
