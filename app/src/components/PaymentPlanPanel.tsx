import type { NeedDetail, PayeeChangeView, PayeeView } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { ExplorerLink } from '@/components/ExplorerLink'
import { Link } from '@/i18n/navigation'
import { amount, bpsPercent, shorten, timestamp } from '@/lib/format'

/**
 * The payment plan of an on-chain need: the registered suppliers its vault pays directly, what share of each
 * tranche each one gets, and what has actually reached them. Nothing here is reported by the NGO — the shares
 * are fixed on chain when the need is created (and verified with it), and every payment is a vault event.
 */
export function PaymentPlanPanel({ need }: { need: NeedDetail }) {
  const t = useTranslations('plan')
  const tCommon = useTranslations('common')
  const unit = tCommon('amountUnit')
  const pending = need.payeeChanges.filter((change) => change.status === 'PENDING')

  if (need.payees.length === 0) return null

  return (
    <section className="card" aria-labelledby="plan">
      <h2 id="plan" className="section-title">
        {t('title')}
      </h2>
      <p className="mt-1 text-sm text-slate-700">{t('note')}</p>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-slate-600">
            <tr>
              <th className="py-2 pr-3 font-medium">{t('colPayee')}</th>
              {need.tranches.map((tranche) => (
                <th key={tranche.index} className="py-2 pr-3 text-right font-medium">
                  {t('colTranche', { index: tranche.index + 1 })}
                </th>
              ))}
              <th className="py-2 pr-3 text-right font-medium">{t('colNeedShare')}</th>
              <th className="py-2 text-right font-medium">{t('colPaid', { unit })}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {need.payees.map((payee) => (
              <PayeeRow key={payee.index} payee={payee} tranches={need.tranches.length} />
            ))}
          </tbody>
        </table>
      </div>

      {need.payments.some((payment) => payment.held) ? (
        <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">
          {t('heldNote')}
        </p>
      ) : null}

      {pending.length > 0 ? (
        <div className="mt-4 space-y-2">
          <h3 className="text-sm font-semibold text-slate-900">{t('changesTitle')}</h3>
          {pending.map((change) => (
            <PendingChange key={change.changeId} change={change} />
          ))}
        </div>
      ) : null}

      {need.payments.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-sm font-semibold text-slate-900">{t('paymentsTitle')}</h3>
          <ul className="mt-2 space-y-1 text-xs text-slate-700">
            {need.payments.map((payment) => (
              <li
                key={`${payment.txHash}-${payment.payee}-${payment.trancheIndex}`}
                className="flex flex-wrap items-center gap-x-2 tabular-nums"
              >
                <span className="font-semibold">
                  {amount(payment.amount)} {unit}
                </span>
                <span>
                  {payment.held
                    ? t('paymentHeld', {
                        index: payment.trancheIndex + 1,
                        payee: shorten(payment.payee),
                      })
                    : t('paymentPaid', {
                        index: payment.trancheIndex + 1,
                        payee: payment.toNgo ? t('theNgo') : shorten(payment.payee),
                      })}
                </span>
                <span className="text-slate-500">{timestamp(payment.timestamp)}</span>
                <ExplorerLink kind="tx" value={payment.txHash} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}

function PayeeRow({ payee, tranches }: { payee: PayeeView; tranches: number }) {
  const t = useTranslations('plan')
  const held = BigInt(payee.held) > 0n

  return (
    <tr>
      <td className="py-2 pr-3">
        <span className="block font-medium text-slate-900">{payee.label || t('unnamed')}</span>
        {payee.account ? (
          <Link className="link mono text-xs" href={`/suppliers/${payee.account}`}>
            {shorten(payee.account)}
          </Link>
        ) : (
          <span className="text-xs text-slate-600">{t('ngoShare')}</span>
        )}
      </td>
      {Array.from({ length: tranches }, (_, index) => (
        <td
          // biome-ignore lint/suspicious/noArrayIndexKey: one cell per tranche, in tranche order
          key={index}
          className="py-2 pr-3 text-right tabular-nums text-slate-800"
        >
          {bpsPercent(payee.shareBps[index] ?? 0)}%
        </td>
      ))}
      <td className="py-2 pr-3 text-right tabular-nums font-medium text-slate-900">
        {bpsPercent(payee.needShareBps)}%
      </td>
      <td className="py-2 text-right tabular-nums">
        {amount(payee.paid)}
        {held ? (
          <span className="block text-xs text-amber-900">
            {t('heldAmount', { amount: amount(payee.held) })}
          </span>
        ) : null}
      </td>
    </tr>
  )
}

function PendingChange({ change }: { change: PayeeChangeView }) {
  const t = useTranslations('plan')
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-800">
      <p>
        {t('changeLine', {
          from: shorten(change.from),
          to: shorten(change.to),
          label: change.label || t('unnamed'),
        })}
      </p>
      <p className="mt-1 text-slate-600">
        {t('changeApprovals', { approvals: change.approvals, required: change.approvalsRequired })} ·{' '}
        {timestamp(change.proposedAt)}
      </p>
    </div>
  )
}
