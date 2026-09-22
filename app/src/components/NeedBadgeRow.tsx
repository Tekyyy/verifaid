import type { NeedBadges, OrgTaxStatusView } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { bpsPercent } from '@/lib/format'
import { parseJurisdiction, regimeOf } from '@/lib/taxEligibility'

/**
 * What the chain can say about the organisation behind a need. Both badges are facts recomputed from events,
 * not a score anyone awards or can buy:
 *
 * - **photos of the work** — the need's own NGO published images of what it delivered (a `WorkPhotos`
 *   attestation it signed; nobody else's counts),
 * - **payout record** — the share of everything this NGO ever released that actually reached the payees its
 *   plans named. Below 100% means money is still held because a token refused a transfer.
 */
export function NeedBadgeRow({
  badges,
  taxStatus = null,
  className = '',
}: {
  badges: NeedBadges
  taxStatus?: OrgTaxStatusView | null
  className?: string
}) {
  const t = useTranslations('badges')
  const tDeduction = useTranslations('deduction')
  const regime = regimeOf(taxStatus)
  const country = taxStatus ? parseJurisdiction(taxStatus.jurisdiction).country : ''
  const clean = badges.payoutAccuracyBps !== null && badges.payoutAccuracyBps >= 10_000

  if (badges.workPhotos === 0 && badges.payoutAccuracyBps === null && !taxStatus) return null

  return (
    <ul className={`flex flex-wrap gap-1.5 ${className}`}>
      {badges.workPhotos > 0 ? (
        <li className="badge bg-sky-100 text-sky-900" title={t('photosHint')}>
          <span aria-hidden="true">📷</span> {t('photos')}
        </li>
      ) : null}
      {badges.payoutAccuracyBps !== null ? (
        <li
          className={`badge ${clean ? 'bg-emerald-100 text-emerald-900' : 'bg-amber-100 text-amber-900'}`}
          title={clean ? t('payoutsHint') : t('payoutsPartialHint')}
        >
          <span aria-hidden="true">{clean ? '✅' : '⏳'}</span>{' '}
          {clean ? t('payouts') : t('payoutsPartial', { percent: bpsPercent(badges.payoutAccuracyBps) })}
        </li>
      ) : null}
      {taxStatus && regime ? (
        <li
          className="badge bg-emerald-100 text-emerald-900"
          title={t('taxDeductibleHint')}
          data-testid="tax-deductible-badge"
        >
          {t('taxDeductible', { regime: tDeduction(regime === 'US_501C3' ? 'regimeUS' : 'regimeSG') })}
        </li>
      ) : taxStatus ? (
        <li
          className={`badge ${taxStatus.verified ? 'bg-teal-100 text-teal-800' : 'bg-slate-100 text-slate-600'}`}
          title={taxStatus.verified ? t('taxVerifiedHint') : t('taxClaimedHint')}
        >
          {taxStatus.verified
            ? t('tax', { jurisdiction: country, id: taxStatus.taxId })
            : `${t('tax', { jurisdiction: country, id: taxStatus.taxId })} ${t('taxUnchecked')}`}
        </li>
      ) : null}
      {badges.needsCompleted > 0 ? (
        <li className="badge bg-slate-100 text-slate-700" title={t('deliveredHint')}>
          {t('delivered', { completed: badges.needsCompleted, total: badges.needsTotal })}
        </li>
      ) : null}
    </ul>
  )
}
