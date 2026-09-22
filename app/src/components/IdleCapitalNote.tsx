import type { NeedDetail } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { ExplorerLink } from '@/components/ExplorerLink'
import { amount } from '@/lib/format'

/**
 * What a need does with money nobody can spend yet. Deliveries on a long programme run for months, and the
 * escrow behind them sits still; a need whose NGO opted in lets it wait in a lending vault instead.
 *
 * This is a disclosure before it is a feature. A donor is repaid the principal they gave and never a slice of
 * what it earned, but the venue is a third party, and being told so belongs next to the money, not in a doc.
 */
export function IdleCapitalNote({ need }: { need: NeedDetail }) {
  const t = useTranslations('idle')
  const tCommon = useTranslations('common')
  const idle = need.idleCapital
  if (!idle) return null

  const unit = tCommon('amountUnit')
  const deployed = BigInt(idle.deployed)
  const earned = BigInt(idle.earned)
  const lost = BigInt(idle.lost)

  return (
    <section className="card" aria-labelledby="idle-capital">
      <h2 id="idle-capital" className="section-title">
        {t('title')}
      </h2>
      <p className="mt-1 text-sm text-slate-700">{t('body')}</p>

      <dl className="mt-3 grid gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-slate-600">{t('deployed')}</dt>
          <dd className="text-sm font-semibold tabular-nums">
            {amount(deployed)} {unit}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-600">{t('earned')}</dt>
          <dd className="text-sm font-semibold tabular-nums text-emerald-800">
            {amount(earned)} {unit}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-600">{t('paidOut')}</dt>
          <dd className="text-sm font-semibold tabular-nums">
            {amount(idle.paidOut)} {unit}
          </dd>
        </div>
      </dl>

      {lost > 0n ? (
        <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">
          {t('lost', { amount: amount(lost), unit })}
        </p>
      ) : null}

      {/* The venue stays on the record after the position closes, but "where it waits" is only true while
          something is actually lent — so the line follows the money, not the address. */}
      {idle.venue && deployed > 0n ? (
        <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <span>{t('venue')}</span>
          <ExplorerLink kind="address" value={idle.venue} />
        </p>
      ) : (
        <p className="mt-3 text-xs text-slate-600">{t('idleNow')}</p>
      )}

      <p className="mt-2 text-xs text-slate-600">{t('donorPromise')}</p>
    </section>
  )
}
