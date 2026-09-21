import type { OrgTaxStatusView } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { type DonationChannel, isEligible, regimeOf, sgDeductionRate } from '@/lib/taxEligibility'

/**
 * Shown before a donor gives, and only when a gift to this need can be deducted: the organisation is a 501(c)(3)
 * or an IPC and the platform admin checked it in the register. Anything less renders nothing — an unchecked
 * claim is already visible as a badge, and "maybe deductible" is not something to put next to a donate button.
 */
export function TaxDeductionNotice({ taxStatus }: { taxStatus: OrgTaxStatusView | null }) {
  const t = useTranslations('deduction')
  const regime = regimeOf(taxStatus)
  if (!regime || !taxStatus) return null

  const us = regime === 'US_501C3'
  const rate = sgDeductionRate(Math.floor(Date.now() / 1000))
  const points = us
    ? [t('usDigital'), t('usCash'), t('usWhen'), t('usReceipt')]
    : [rate ? t('sgRate', { rate }) : t('sgRateUnknown'), t('sgCashOnly'), t('sgNric'), t('sgWhen')]

  return (
    <section
      className="card border-emerald-300 bg-emerald-50"
      aria-labelledby="tax-deduction"
      data-testid="tax-deduction-notice"
      data-regime={regime}
    >
      <h2 id="tax-deduction" className="section-title text-emerald-950">
        {us ? t('usTitle') : t('sgTitle')}
      </h2>
      <p className="mt-1 text-sm text-emerald-950">
        {t(us ? 'usBody' : 'sgBody', { name: taxStatus.legalName, id: taxStatus.taxId })}
      </p>
      {taxStatus.verifiedSource ? (
        <p className="mt-1 text-xs text-emerald-900">{t('checked', { source: taxStatus.verifiedSource })}</p>
      ) : null}
      <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-slate-800">
        {points.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-slate-600">{t('disclaimer')}</p>
    </section>
  )
}

/** One line inside a donation panel, only when money given *this way* can be deducted. */
export function DeductibleLine({
  taxStatus,
  channel,
}: {
  taxStatus: OrgTaxStatusView | null | undefined
  channel: DonationChannel
}) {
  const t = useTranslations('deduction')
  if (!isEligible(taxStatus, channel)) return null
  const regime = regimeOf(taxStatus)
  return (
    <p
      className="mt-2 rounded-md bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-900"
      data-testid={`deductible-${channel}`}
    >
      {t(channel === 'digital' ? 'lineDigital' : 'lineCash', {
        regime: t(regime === 'US_501C3' ? 'regimeUS' : 'regimeSG'),
      })}
    </p>
  )
}
