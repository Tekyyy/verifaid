'use client'

import { basketId, communityProofsAbi } from '@poa/shared'
import { useQuery } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { formatUnits, zeroHash } from 'viem'
import { useAccount, useReadContract } from 'wagmi'
import { NeedStatusBadge } from '@/components/StatusBadge'
import { TxStatus } from '@/components/TxStatus'
import { Link } from '@/i18n/navigation'
import { basketName } from '@/lib/baskets'
import { deployment, TOKEN_DECIMALS } from '@/lib/config'
import { amount, parseAmount } from '@/lib/format'
import { useMounted, useTx, useWrongChain } from '@/lib/hooks'
import { getBaskets, getCredits, getNeeds } from '@/lib/indexer'

/**
 * A proof filer's reward credit (CommunityProofs.creditOf). A reward is never cash: it can only be given to a need
 * raising money, or to a basket, where the factory splits it equally. Either way the donation is made in the
 * contract's name, so it carries no vote, and when a need it went to fails its share comes back here as credit.
 */
export function RewardCreditPanel() {
  const t = useTranslations('credit')
  const tBaskets = useTranslations('baskets')
  const tCommon = useTranslations('common')
  const mounted = useMounted()
  const { address: wallet, isConnected } = useAccount()
  const wrongChain = useWrongChain()
  const give = useTx()
  const reclaim = useTx()
  const [target, setTarget] = useState('')
  const [value, setValue] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [reclaiming, setReclaiming] = useState<string | null>(null)

  const unit = tCommon('amountUnit')
  const contract = deployment?.contracts.CommunityProofs

  const credit = useReadContract({
    address: contract,
    abi: communityProofsAbi,
    functionName: 'creditOf',
    args: wallet ? [wallet] : undefined,
    query: { enabled: Boolean(wallet && contract) },
  })
  const balance = credit.data ?? 0n

  const baskets = useQuery({ queryKey: ['baskets'], queryFn: getBaskets, enabled: balance > 0n })
  const needs = useQuery({
    queryKey: ['needs', 'open'],
    queryFn: () => getNeeds({ open: true }),
    enabled: balance > 0n,
  })
  const history = useQuery({
    queryKey: ['credits', wallet],
    queryFn: () => getCredits(wallet as string),
    enabled: Boolean(wallet),
  })

  if (!contract) return null

  const openBaskets = baskets.data?.ok
    ? baskets.data.data.filter((basket) => basket.openNeedIds.length > 0)
    : []
  const openNeeds = needs.data?.ok ? needs.data.data.filter((need) => BigInt(need.fundingGap) > 0n) : []
  const gifts = history.data?.ok ? history.data.data : []
  const parsed = parseAmount(value)
  const busy = (state: { phase: string }) => state.phase === 'signing' || state.phase === 'pending'

  const refresh = async () => {
    // The indexer trails the receipt by a block or two.
    await credit.refetch()
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    await Promise.all([history.refetch(), baskets.refetch(), needs.refetch()])
  }

  const run = async () => {
    if (!parsed || parsed <= 0n || parsed > balance) return setFormError(t('errorAmount'))
    const [kind, key] = target.split(':')
    const basket = kind === 'basket' ? openBaskets.find((item) => item.category === key) : undefined
    if (!key || (kind === 'basket' && !basket)) return setFormError(t('errorTarget'))
    setFormError(null)
    const result = await give.run({
      address: contract,
      abi: communityProofsAbi,
      functionName: 'giveCredit',
      args: basket
        ? [basketId(basket.category), basket.openNeedIds.map((id) => BigInt(id)), parsed]
        : [zeroHash, [BigInt(key)], parsed],
    })
    if (result) {
      setValue('')
      await refresh()
    }
  }

  const reclaimFor = async (needId: string) => {
    setReclaiming(needId)
    const result = await reclaim.run({
      address: contract,
      abi: communityProofsAbi,
      functionName: 'reclaimCredit',
      args: [BigInt(needId)],
    })
    if (result) await refresh()
    setReclaiming(null)
  }

  return (
    <section className="card" aria-labelledby="reward-credit">
      <h2 id="reward-credit" className="section-title">
        {t('title')}
      </h2>
      <p className="mt-1 max-w-3xl text-sm text-slate-700">{t('body')}</p>

      {!mounted || !isConnected || !wallet ? (
        <p className="mt-3 text-sm text-slate-700">{t('connect')}</p>
      ) : (
        <div className="mt-3 space-y-4">
          <p className="text-2xl font-bold tabular-nums text-teal-700">
            {t('balance', { amount: amount(balance), unit })}
          </p>

          {balance === 0n ? (
            <p className="text-sm text-slate-600">{t('none')}</p>
          ) : openBaskets.length === 0 && openNeeds.length === 0 ? (
            <p className="text-sm text-slate-600">
              {baskets.isLoading || needs.isLoading ? tCommon('loading') : t('noTargets')}
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <div>
                <label className="label" htmlFor="credit-target">
                  {t('toLabel')}
                </label>
                <select
                  id="credit-target"
                  className="input"
                  value={target}
                  onChange={(event) => {
                    setTarget(event.target.value)
                    give.reset()
                  }}
                >
                  <option value="">{t('choose')}</option>
                  {openBaskets.length > 0 ? (
                    <optgroup label={t('groupBaskets')}>
                      {openBaskets.map((basket) => (
                        <option key={basket.category} value={`basket:${basket.category}`}>
                          {t('toBasket', {
                            name: basketName(tBaskets, basket.category),
                            count: basket.openNeedIds.length,
                          })}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                  {openNeeds.length > 0 ? (
                    <optgroup label={t('groupNeeds')}>
                      {openNeeds.map((need) => (
                        <option key={need.id} value={`need:${need.id}`}>
                          {t('toNeed', {
                            id: need.id,
                            category: need.categoryLabel,
                            region: need.regionLabel,
                          })}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="credit-amount">
                  {t('amountLabel', { unit })}
                </label>
                <div className="flex gap-2">
                  <input
                    id="credit-amount"
                    className="input"
                    inputMode="decimal"
                    autoComplete="off"
                    value={value}
                    onChange={(event) => {
                      setValue(event.target.value)
                      give.reset()
                    }}
                    placeholder={amount(balance)}
                  />
                  <button
                    type="button"
                    className="btn-secondary shrink-0 px-3"
                    onClick={() => setValue(formatUnits(balance, TOKEN_DECIMALS))}
                  >
                    {t('all')}
                  </button>
                </div>
              </div>
              <div className="sm:col-span-2">
                {formError ? (
                  <p className="mb-2 text-xs text-red-800" role="alert">
                    {formError}
                  </p>
                ) : null}
                <button
                  type="button"
                  className="btn-accent w-full sm:w-auto"
                  onClick={run}
                  disabled={wrongChain || busy(give) || !target || !parsed}
                >
                  {t('give', { amount: parsed ? amount(parsed) : '0.00', unit })}
                </button>
                <TxStatus state={give} />
                {give.phase === 'success' ? (
                  <p className="mt-2 text-sm font-medium text-emerald-800">{t('success')}</p>
                ) : null}
              </div>
            </div>
          )}

          {gifts.length > 0 ? (
            <div>
              <h3 className="text-sm font-semibold text-slate-900">{t('historyTitle')}</h3>
              <ul className="mt-2 space-y-2">
                {gifts.map((gift) => (
                  <li
                    key={gift.needId}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 px-3 py-2 text-xs"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <Link className="link font-semibold" href={`/needs/${gift.needId}`}>
                        #{gift.needId}
                      </Link>
                      <NeedStatusBadge status={gift.needStatus} />
                      {BigInt(gift.given) > 0n ? (
                        <span className="tabular-nums">
                          {t('historyGiven', { amount: amount(gift.given), unit })}
                        </span>
                      ) : null}
                      {BigInt(gift.reclaimed) > 0n ? (
                        <span className="tabular-nums text-slate-600">
                          {t('historyReclaimed', { amount: amount(gift.reclaimed), unit })}
                        </span>
                      ) : null}
                    </span>
                    {gift.reclaimable ? (
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-amber-900">{t('failed')}</span>
                        <button
                          type="button"
                          className="btn-secondary px-3 py-1 text-xs"
                          disabled={wrongChain || busy(reclaim)}
                          onClick={() => reclaimFor(gift.needId)}
                        >
                          {reclaiming === gift.needId && busy(reclaim) ? tCommon('loading') : t('reclaim')}
                        </button>
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
              <TxStatus state={reclaim} />
            </div>
          ) : null}
        </div>
      )}
    </section>
  )
}
