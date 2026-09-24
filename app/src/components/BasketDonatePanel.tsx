'use client'

import { donationForwarderFactoryAbi, equalSplit, mockEURCAbi } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { useEffect, useMemo, useState } from 'react'
import type { Hex } from 'viem'
import { useAccount, useReadContract } from 'wagmi'
import { TxStatus } from '@/components/TxStatus'
import { Link, useRouter } from '@/i18n/navigation'
import { deployment } from '@/lib/config'
import { amount, parseAmount } from '@/lib/format'
import { batchCall, useMounted, useTx, useWrongChain } from '@/lib/hooks'

/**
 * One gift to a basket: approve the factory, then `DonationForwarderFactory.donateEqually`, which splits it equally
 * between the basket's needs taking money and donates each part in the giver's name (a receipt per need, a say on
 * its evidence, a refund if it fails). The two calls go out as one batch when the wallet can bundle them.
 *
 * The split shown before signing is `equalSplit` over the latest figures; the contract recomputes it from what each
 * need can take when the gift lands, so a need that filled up in between simply takes less.
 */
export function BasketDonatePanel({
  name,
  basket,
  needs,
}: {
  /** The basket's name in the reader's language. */
  name: string
  basket: Hex
  /** The needs taking money, ascending by id (the contract requires it), with what each can still take. */
  needs: { id: string; room: string }[]
}) {
  const t = useTranslations('baskets')
  const tCommon = useTranslations('common')
  const tErrors = useTranslations('errors')
  const mounted = useMounted()
  const { address: wallet, isConnected } = useAccount()
  const wrongChain = useWrongChain()
  const give = useTx()
  const [value, setValue] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const unit = tCommon('amountUnit')
  const token = deployment?.external.Token
  const factory = deployment?.contracts.DonationForwarderFactory
  const parsed = parseAmount(value)

  const balance = useReadContract({
    address: token,
    abi: mockEURCAbi,
    functionName: 'balanceOf',
    args: wallet ? [wallet] : undefined,
    query: { enabled: Boolean(wallet && token) },
  })

  const preview = useMemo(
    () =>
      parsed && parsed > 0n
        ? equalSplit(
            parsed,
            needs.map((need) => BigInt(need.room)),
          )
        : null,
    [parsed, needs],
  )

  const run = async () => {
    if (!parsed || parsed <= 0n || !token || !factory) return setFormError(t('errorAmount'))
    setFormError(null)
    await give.runBatch([
      batchCall({ address: token, abi: mockEURCAbi, functionName: 'approve', args: [factory, parsed] }),
      batchCall({
        address: factory,
        abi: donationForwarderFactoryAbi,
        functionName: 'donateEqually',
        args: [basket, needs.map((need) => BigInt(need.id)), parsed],
      }),
    ])
  }

  // The page is rendered on the server: ask for it again once the indexer has the gift.
  const pageRouter = useRouter()
  useEffect(() => {
    if (give.phase !== 'success') return
    const timer = setTimeout(() => pageRouter.refresh(), 2_500)
    return () => clearTimeout(timer)
  }, [give.phase, pageRouter])

  if (!factory || !token || needs.length === 0) return null
  const busy = give.phase === 'signing' || give.phase === 'pending'

  return (
    <section className="card" aria-labelledby="basket-donate">
      <h2 id="basket-donate" className="section-title">
        {t('donateTitle', { name })}
      </h2>
      <p className="mt-1 text-sm text-slate-700">{t('donateBody')}</p>

      <div className="mt-3">
        <label className="label" htmlFor="basket-amount">
          {t('amountLabel', { unit })}
        </label>
        <input
          id="basket-amount"
          className="input"
          inputMode="decimal"
          autoComplete="off"
          value={value}
          onChange={(event) => {
            setValue(event.target.value)
            give.reset()
          }}
          placeholder="100.00"
        />
        {mounted && balance.data !== undefined ? (
          <p className="hint">{t('balance', { amount: amount(balance.data), unit })}</p>
        ) : null}
      </div>

      {preview ? (
        <div className="mt-3 rounded-md bg-slate-50 p-3 text-xs text-slate-700" aria-live="polite">
          <p className="font-semibold">{t('previewTitle')}</p>
          <ul className="mt-1 space-y-0.5 tabular-nums">
            {needs.map((need, index) => (
              <li key={need.id} className="flex justify-between gap-4">
                <span>{t('previewLine', { id: need.id })}</span>
                <span>
                  {amount(preview.amounts[index] ?? 0n)} {unit}
                </span>
              </li>
            ))}
          </ul>
          {preview.returned > 0n ? (
            <p className="mt-1 font-medium text-amber-900">
              {t('previewReturned', { amount: amount(preview.returned), unit })}
            </p>
          ) : null}
          <p className="mt-2 text-slate-600">{t('previewNote')}</p>
        </div>
      ) : null}

      {formError ? (
        <p className="mt-2 text-xs text-red-800" role="alert">
          {formError}
        </p>
      ) : null}

      {!isConnected ? (
        <p className="mt-3 text-sm text-slate-700">{tErrors('connectFirst')}</p>
      ) : (
        <div className="mt-4">
          <button
            type="button"
            className="btn-accent w-full sm:w-auto"
            onClick={run}
            disabled={wrongChain || busy || !parsed || parsed <= 0n}
          >
            {t('send', { amount: parsed ? amount(parsed) : '0.00', unit })}
          </button>
          <TxStatus state={give} />
        </div>
      )}

      {give.phase === 'success' ? (
        <div className="mt-3 space-y-1">
          <p className="text-sm font-medium text-emerald-800">{t('success')}</p>
          <Link className="link text-sm" href="/donor">
            {t('mine')}
          </Link>
        </div>
      ) : null}
    </section>
  )
}
