import type { SettlementView } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { ExplorerLink } from '@/components/ExplorerLink'
import { amount, shorten, timestamp } from '@/lib/format'
import { isZeroUid } from '@/lib/links'

/** Tranche payouts reconciled by Settlement attestations: what reached the supplier and what fees took. */
export function SettlementList({ settlements }: { settlements: SettlementView[] }) {
  const t = useTranslations('settlements')
  const tCommon = useTranslations('common')

  if (settlements.length === 0) return <p className="text-sm text-slate-600">{t('empty')}</p>

  return (
    <ul className="space-y-2">
      {settlements.map((settlement) => (
        <li key={settlement.uid} className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-semibold text-slate-900">
              {t('tranche', { index: settlement.trancheIndex })}
            </p>
            <span className="text-slate-600">{timestamp(settlement.timestamp)}</span>
          </div>
          <dl className="mt-2 grid grid-cols-3 gap-2">
            <div>
              <dt className="text-slate-600">{t('gross')}</dt>
              <dd className="font-semibold tabular-nums">{amount(settlement.gross)}</dd>
            </div>
            <div>
              <dt className="text-slate-600">{t('fee')}</dt>
              <dd className="font-semibold tabular-nums">{amount(settlement.fee)}</dd>
            </div>
            <div>
              <dt className="text-slate-600">{t('net')}</dt>
              <dd className="font-semibold tabular-nums">{amount(settlement.net)}</dd>
            </div>
          </dl>
          <p className="mt-1 text-slate-500">{tCommon('amountUnit')}</p>
          <dl className="mt-2 space-y-1">
            <div className="flex flex-wrap gap-1">
              <dt className="text-slate-600">{t('supplierRef')}</dt>
              <dd className="font-mono text-slate-700" title={settlement.supplierRefHash}>
                {shorten(settlement.supplierRefHash, 10, 6)}
              </dd>
            </div>
            {!isZeroUid(settlement.fxRef) ? (
              <div className="flex flex-wrap gap-1">
                <dt className="text-slate-600">{t('fxRef')}</dt>
                <dd className="font-mono text-slate-700" title={settlement.fxRef}>
                  {shorten(settlement.fxRef, 10, 6)}
                </dd>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="flex items-center gap-1">
                <span className="text-slate-600">{t('attester')}</span>
                <ExplorerLink kind="address" value={settlement.attester} />
              </span>
              <span className="flex items-center gap-1">
                <span className="text-slate-600">{tCommon('attestation')}</span>
                <ExplorerLink kind="attestation" value={settlement.uid} />
              </span>
              <span className="flex items-center gap-1">
                <span className="text-slate-600">{tCommon('transaction')}</span>
                <ExplorerLink kind="tx" value={settlement.txHash} />
              </span>
            </div>
          </dl>
        </li>
      ))}
    </ul>
  )
}
