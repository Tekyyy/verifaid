import type { ReleasePolicyView } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { bpsToPercent } from '@/lib/policies'

/**
 * The rule a need's tranches are released under, in plain words: who approves, how much agreement it takes, and
 * what a rejection does. Shown next to the evidence, because it is the rule the evidence is being judged by.
 */
export function ReleasePolicyNote({
  policy,
  verifiers,
  strikes,
  compact = false,
}: {
  policy: ReleasePolicyView
  /** Independent verifiers the need required to open, which is also how many must sign a release. */
  verifiers: number
  /** Rejections so far; omitted where the need has none yet (a form, say). */
  strikes?: number
  compact?: boolean
}) {
  const t = useTranslations('policy')
  const values = {
    approve: bpsToPercent(policy.donorApprovalBps),
    reject: bpsToPercent(policy.donorRejectionBps),
    verifiers: Math.max(1, verifiers),
  }

  return (
    <div className={compact ? 'space-y-1 text-xs text-slate-700' : 'space-y-1 text-sm text-slate-700'}>
      <p>
        <span className="font-semibold text-slate-900">{t(`name.${policy.kind}`)}.</span>{' '}
        {t(`summary.${policy.kind}`, values)}
      </p>
      <p>{t('retries', { retries: policy.retries })}</p>
      {strikes !== undefined && strikes > 0 ? (
        <p className="font-medium text-amber-800">{t('strikes', { strikes })}</p>
      ) : null}
    </div>
  )
}
