import type { DonorTrancheSlice, TrancheView } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { ExplorerLink } from '@/components/ExplorerLink'
import { TrancheStatusBadge } from '@/components/StatusBadge'
import { amount, timestamp } from '@/lib/format'

const FILL: Record<TrancheView['status'], string> = {
  Locked: 'bg-slate-300',
  Releasable: 'bg-amber-400',
  Released: 'bg-emerald-600',
}

const hasDonorShare = (tranche: TrancheView | DonorTrancheSlice): tranche is DonorTrancheSlice =>
  'donorShare' in tranche

/**
 * The tranche plan as one bar plus a row per tranche. Widths are the tranche shares, so the bar reads as
 * "how much of this need has actually been paid out" at a glance.
 *
 * `amount` is always the full tranche. When a donor's slice is present it is shown as a clearly labelled
 * second number rather than replacing the first, so neither figure can be mistaken for the other.
 */
export function TrancheBar({ tranches }: { tranches: (TrancheView | DonorTrancheSlice)[] }) {
  const t = useTranslations('need')
  const tDonor = useTranslations('donor')
  const tCommon = useTranslations('common')

  if (tranches.length === 0) return null

  return (
    <div>
      <div className="flex h-4 w-full overflow-hidden rounded-md border border-slate-300 bg-white">
        {tranches.map((tranche) => (
          <div
            key={tranche.index}
            className={`${FILL[tranche.status]} border-r border-white last:border-r-0`}
            style={{ width: `${tranche.bps / 100}%` }}
            title={`${t('trancheLabel', { index: tranche.index })} — ${tranche.bps / 100}%`}
          />
        ))}
      </div>

      <ul className="mt-3 space-y-2">
        {tranches.map((tranche) => (
          <li
            key={tranche.index}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 px-3 py-2"
          >
            <div>
              <p className="text-sm font-semibold text-slate-900">
                {t('trancheLabel', { index: tranche.index })}
              </p>
              <p className="text-xs text-slate-600">{t('trancheShare', { bps: tranche.bps / 100 })}</p>
            </div>
            <div className="text-right">
              <p className="text-sm font-semibold tabular-nums">
                {amount(tranche.amount)} {tCommon('amountUnit')}
              </p>
              {hasDonorShare(tranche) ? (
                <p className="text-xs text-indigo-800 tabular-nums">
                  {tDonor('trancheShare')}: {amount(tranche.donorShare)} {tCommon('amountUnit')}
                </p>
              ) : null}
              {tranche.releasedAt ? (
                <p className="text-xs text-slate-600">{timestamp(tranche.releasedAt)}</p>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <TrancheStatusBadge status={tranche.status} />
              {tranche.releaseTxHash ? <ExplorerLink kind="tx" value={tranche.releaseTxHash} /> : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
