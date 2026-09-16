import type { NeedSummary } from '@poa/shared'
import { useTranslations } from 'next-intl'
import type { ReactNode } from 'react'
import { CustodyBadge } from '@/components/CustodyBadge'
import { Deadline } from '@/components/Deadline'
import { ExplorerLink } from '@/components/ExplorerLink'
import { amount, bpsOf, bpsPercent, timestamp } from '@/lib/format'

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-3 sm:gap-3">
      <dt className="text-slate-600">{label}</dt>
      <dd className="min-w-0 sm:col-span-2">{children}</dd>
    </div>
  )
}

/**
 * The commitments the NGO made when it registered the need — custody, deadlines, the funding threshold and
 * the cost cap — next to what has actually happened against them. All of it is fixed on chain at creation.
 */
export function TermsPanel({ need }: { need: NeedSummary }) {
  const t = useTranslations('terms')
  const tCommon = useTranslations('common')

  const fees = BigInt(need.fundingFees) + BigInt(need.settlementFees)
  const paidByDonors = BigInt(need.totalDonated) + BigInt(need.fundingFees)
  const minPercent = bpsPercent(need.minFundingBps)
  const capPercent = bpsPercent(need.thirdPartyCostBps)

  return (
    <section className="card" aria-labelledby="terms">
      <h2 id="terms" className="section-title">
        {t('title')}
      </h2>
      <p className="mt-1 text-sm text-slate-700">{t('note')}</p>

      <dl className="mt-4 space-y-3 text-sm">
        <Row label={t('custody')}>
          <CustodyBadge mode={need.custodyMode} explain />
        </Row>
        {need.custodyMode === 'OffChain' ? (
          <Row label={t('custodian')}>
            <ExplorerLink kind="address" value={need.custodian} />
          </Row>
        ) : null}
        <Row label={t('fundingDeadline')}>
          <Deadline seconds={need.fundingDeadline} none={t('openEnded')} />
        </Row>
        <Row label={t('executionDeadline')}>
          <Deadline seconds={need.executionDeadline} none={t('noDeadline')} />
        </Row>
        <Row label={t('minFunding')}>
          <p className="font-semibold">{minPercent}%</p>
          <p className="hint">
            {need.minFundingBps >= 10_000 ? t('allOrNothing') : t('partialAllowed', { percent: minPercent })}
          </p>
        </Row>
        <Row label={t('costCap')}>
          <p className="font-semibold">{need.thirdPartyCostBps === 0 ? t('noCosts') : `${capPercent}%`}</p>
          <p className="hint">
            {t('feesSoFar', {
              amount: amount(fees),
              unit: tCommon('amountUnit'),
              percent: bpsPercent(bpsOf(fees, paidByDonors)),
            })}
          </p>
          {need.costDisclosureHash ? (
            <p className="hint">
              {t('costDisclosure')}: <span className="mono">{need.costDisclosureHash}</span>
            </p>
          ) : null}
        </Row>
        <Row label={t('expectedOutcome')}>
          <span className="mono">{need.expectedOutcomeHash}</span>
          <p className="hint">{t('expectedOutcomeNote')}</p>
        </Row>
        {need.expiredAt ? <Row label={t('expiredAt')}>{timestamp(need.expiredAt)}</Row> : null}
      </dl>
    </section>
  )
}
