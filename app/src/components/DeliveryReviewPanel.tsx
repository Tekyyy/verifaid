'use client'

import { type DeliveryView, deliveryManagerAbi } from '@poa/shared'
import { useTranslations } from 'next-intl'
import type { Address } from 'viem'
import { useAccount, useReadContract } from 'wagmi'
import { ProgressBar } from '@/components/ProgressBar'
import { TxStatus } from '@/components/TxStatus'
import { useRouter } from '@/i18n/navigation'
import { deployment } from '@/lib/config'
import { amount, percent } from '@/lib/format'
import { useMounted, useTx, useWrongChain } from '@/lib/hooks'

/**
 * Where a donor says yes to how the money was spent. The evidence itself is in the need's Deliveries section; this
 * is the decision beside it: how far approval has got, what this donor's say weighs (what they gave), and one
 * signature. The NGO, its payout address and its payees have no say; the contract refuses them, and so does this.
 */
export function DeliveryReviewPanel({ needId, delivery }: { needId: string; delivery: DeliveryView }) {
  const t = useTranslations('evidence')
  const tCommon = useTranslations('common')
  const mounted = useMounted()
  const router = useRouter()
  const { address } = useAccount()
  const wrongChain = useWrongChain()
  const tx = useTx()
  const manager = deployment?.contracts.DeliveryManager as Address | undefined
  const unit = tCommon('amountUnit')

  const { data: weight } = useReadContract({
    address: manager,
    abi: deliveryManagerAbi,
    functionName: 'approvalWeight',
    args: address ? [BigInt(needId), address] : undefined,
    query: { enabled: Boolean(manager && address) },
  })
  const { data: approved, refetch } = useReadContract({
    address: manager,
    abi: deliveryManagerAbi,
    functionName: 'hasApproved',
    args: address ? [BigInt(delivery.id), address] : undefined,
    query: { enabled: Boolean(manager && address) },
  })

  const progress = Math.min(100, percent(delivery.approvedAmount, delivery.requiredAmount))
  const files = delivery.manifest?.files.length ?? 0

  const approve = async () => {
    const result = await tx.run({
      address: manager as Address,
      abi: deliveryManagerAbi,
      functionName: 'approve',
      args: [BigInt(delivery.id)],
    })
    if (!result) return
    await refetch()
    // The page itself is rendered on the server: ask for it again so the totals move.
    setTimeout(() => router.refresh(), 2_000)
  }

  return (
    <section className="card space-y-3 border-teal-300" aria-labelledby="review">
      <h2 id="review" className="section-title">
        {t('reviewTitle', { spent: delivery.trancheIndex - 1 })}
      </h2>
      <p className="text-sm text-slate-700">
        {t('reviewBody', {
          next: delivery.trancheIndex,
          threshold: (deployment?.params.donorApprovalBps ?? 3000) / 100,
        })}
      </p>
      <a className="link text-sm" href={`#delivery-${delivery.id}`}>
        {t('reviewSee', { count: files })}
      </a>

      <div>
        <ProgressBar
          tone="emerald"
          value={progress}
          label={t('reviewProgress', {
            approved: amount(delivery.approvedAmount),
            required: amount(delivery.requiredAmount),
            unit,
          })}
        />
        <p className="mt-1 text-xs text-slate-700">
          {t('reviewProgress', {
            approved: amount(delivery.approvedAmount),
            required: amount(delivery.requiredAmount),
            unit,
          })}
        </p>
      </div>

      {!mounted || !address ? (
        <p className="text-sm text-slate-600">{t('reviewConnect')}</p>
      ) : approved ? (
        <p className="text-sm font-medium text-emerald-800">{t('reviewDone')}</p>
      ) : weight === 0n ? (
        <p className="text-sm text-slate-600">{t('reviewNoSay')}</p>
      ) : weight !== undefined ? (
        <button
          type="button"
          className="btn-primary w-full"
          disabled={wrongChain || tx.phase === 'signing' || tx.phase === 'pending'}
          onClick={approve}
        >
          {t('reviewApprove', { weight: amount(weight), unit })}
        </button>
      ) : null}
      <TxStatus state={tx} />
    </section>
  )
}
