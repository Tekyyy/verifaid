import { type DepositAddressView, tokenSymbolOf } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { ExplorerLink } from '@/components/ExplorerLink'
import { deployment } from '@/lib/config'
import { amount, decimalsOfSymbol, shorten, timestamp, tokenAmount } from '@/lib/format'

const symbolOf = (token: string | null): string =>
  !token ? '—' : deployment ? tokenSymbolOf(deployment, token) : shorten(token)

/**
 * Everything a deposit address did, as the contracts reported it: each sweep's input, its value at Chainlink prices,
 * what reached the need and what the conversion cost; then every refund. Nothing here is estimated.
 */
export function DepositSweeps({ deposit }: { deposit: DepositAddressView }) {
  const t = useTranslations('deposit')
  const unit = useTranslations('common')('amountUnit')

  return (
    <div className="space-y-4">
      {deposit.sweeps.length === 0 ? (
        <p className="text-sm text-slate-600">{t('noSweeps')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-left text-xs">
            <caption className="sr-only">{t('sweepsTitle')}</caption>
            <thead className="text-slate-600">
              <tr>
                <th scope="col" className="py-1 pr-2 font-medium">
                  {t('colIn')}
                </th>
                <th scope="col" className="py-1 pr-2 text-right font-medium">
                  {t('colFair', { unit })}
                </th>
                <th scope="col" className="py-1 pr-2 text-right font-medium">
                  {t('colDeposited', { unit })}
                </th>
                <th scope="col" className="py-1 pr-2 text-right font-medium">
                  {t('colCost', { unit })}
                </th>
                <th scope="col" className="py-1 font-medium">
                  {t('colTx')}
                </th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {deposit.sweeps.map((sweep) => {
                const symbol = symbolOf(sweep.tokenIn)
                return (
                  <tr key={`${sweep.txHash}-${sweep.tokenIn}`} className="border-t border-slate-200">
                    <td className="py-1 pr-2">
                      {tokenAmount(sweep.amountIn, decimalsOfSymbol(symbol))} {symbol}
                    </td>
                    <td className="py-1 pr-2 text-right">{amount(sweep.fairValue)}</td>
                    <td className="py-1 pr-2 text-right font-semibold">{amount(sweep.deposited)}</td>
                    <td className="py-1 pr-2 text-right">{amount(sweep.conversionFee)}</td>
                    <td className="py-1">
                      <ExplorerLink kind="tx" value={sweep.txHash} />
                      <span className="block text-slate-500">{timestamp(sweep.timestamp)}</span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {deposit.refunds.length > 0 ? (
        <div>
          <h3 className="text-sm font-semibold">{t('refundsTitle')}</h3>
          <ul className="mt-1 space-y-1 text-xs">
            {deposit.refunds.map((refund) => {
              const symbol = refund.kind === 'VAULT' ? unit : symbolOf(refund.token)
              return (
                <li key={`${refund.txHash}-${refund.kind}`} className="flex flex-wrap items-center gap-x-2">
                  <span className="font-semibold tabular-nums">
                    {tokenAmount(refund.amount, decimalsOfSymbol(symbol))} {symbol}
                  </span>
                  <span className="text-slate-600">
                    {t(refund.kind === 'VAULT' ? 'refundVault' : 'refundLeftover', {
                      to: shorten(refund.to),
                    })}
                  </span>
                  <ExplorerLink kind="tx" value={refund.txHash} />
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
