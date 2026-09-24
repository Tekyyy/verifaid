'use client'

import {
  type DeliveryView,
  deliveryManagerAbi,
  type ReleasePolicyView,
  VOTE_SIGNATURE_TTL_SECONDS,
  voiceName,
  voteTypedData,
} from '@poa/shared'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import type { Address } from 'viem'
import { useAccount, useReadContract, useSignTypedData } from 'wagmi'
import { ReleasePolicyNote } from '@/components/ReleasePolicyNote'
import { TxStatus } from '@/components/TxStatus'
import { VoteProgress } from '@/components/VoteProgress'
import { useRouter } from '@/i18n/navigation'
import { relayVote } from '@/lib/appApi'
import { chainId, deployment } from '@/lib/config'
import { amount } from '@/lib/format'
import { useMounted, useTx, useWrongChain } from '@/lib/hooks'

type SignedState =
  | { phase: 'idle' }
  | { phase: 'signing' | 'sending' }
  | { phase: 'done'; txHash: string }
  | { phase: 'failed'; error: string }

/**
 * Where the people with a say decide how the money was spent. The evidence itself is in the need's Deliveries
 * section; this is the decision beside it: the rule it is judged by, how far approval and rejection have got,
 * what this wallet's say weighs, and one signature.
 *
 * A vote can be sent as a transaction, or signed for free and relayed by the platform (`voteBySig`), so voting
 * never costs a donor gas. Who has a say is the contract's call, through the need's release policy; the panel
 * only asks it.
 */
export function DeliveryReviewPanel({
  needId,
  delivery,
  policy,
  verifications,
  strikes,
  ownerIsBeneficiary = false,
}: {
  needId: string
  delivery: DeliveryView
  policy: ReleasePolicyView
  verifications: number
  strikes: number
  /** The evidence was filed by the beneficiary who posted the need, not by an NGO. */
  ownerIsBeneficiary?: boolean
}) {
  const t = useTranslations('evidence')
  const tCommon = useTranslations('common')
  const tPolicy = useTranslations('policy')
  const mounted = useMounted()
  const router = useRouter()
  const { address } = useAccount()
  const wrongChain = useWrongChain()
  const tx = useTx()
  const { signTypedDataAsync } = useSignTypedData()
  const [free, setFree] = useState(true)
  const [confirmReject, setConfirmReject] = useState(false)
  const [signed, setSigned] = useState<SignedState>({ phase: 'idle' })
  const manager = deployment?.contracts.DeliveryManager as Address | undefined
  const unit = tCommon('amountUnit')

  const { data: say } = useReadContract({
    address: manager,
    abi: deliveryManagerAbi,
    functionName: 'voiceOf',
    args: address ? [BigInt(needId), address] : undefined,
    query: { enabled: Boolean(manager && address) },
  })
  const { data: voted, refetch } = useReadContract({
    address: manager,
    abi: deliveryManagerAbi,
    functionName: 'hasVoted',
    args: address ? [BigInt(delivery.id), address] : undefined,
    query: { enabled: Boolean(manager && address) },
  })

  const voice = say ? voiceName(Number(say[0])) : undefined
  const weight = say?.[1]
  const files = delivery.manifest?.files.length ?? 0
  const busy =
    tx.phase === 'signing' ||
    tx.phase === 'pending' ||
    signed.phase === 'signing' ||
    signed.phase === 'sending'

  const settle = async () => {
    setConfirmReject(false)
    await refetch()
    // The page itself is rendered on the server: ask for it again so the totals move.
    setTimeout(() => router.refresh(), 2_000)
  }

  const vote = async (approve: boolean) => {
    if (!manager || !address) return
    if (!free) {
      const result = await tx.run({
        address: manager,
        abi: deliveryManagerAbi,
        functionName: approve ? 'approve' : 'reject',
        args: [BigInt(delivery.id)],
      })
      if (result) await settle()
      return
    }

    setSigned({ phase: 'signing' })
    try {
      const deadline = BigInt(Math.floor(Date.now() / 1000) + VOTE_SIGNATURE_TTL_SECONDS)
      const signature = await signTypedDataAsync(
        voteTypedData({
          chainId,
          deliveryManager: manager,
          voter: address,
          deliveryId: BigInt(delivery.id),
          approve,
          deadline,
        }),
      )
      setSigned({ phase: 'sending' })
      const relayed = await relayVote({
        deliveryId: delivery.id,
        voter: address,
        approve,
        deadline: deadline.toString(),
        signature,
      })
      if (!relayed.ok) {
        setSigned({ phase: 'failed', error: relayed.error })
        return
      }
      setSigned({ phase: 'done', txHash: relayed.data.txHash })
      await settle()
    } catch (error) {
      const message = error instanceof Error ? error.message.split('\n')[0] : String(error)
      setSigned({ phase: 'failed', error: message || 'failed' })
    }
  }

  return (
    <section className="card space-y-3 border-teal-300" aria-labelledby="review">
      <h2 id="review" className="section-title">
        {t('reviewTitle', { spent: delivery.trancheIndex - 1 })}
      </h2>
      <p className="text-sm text-slate-700">
        {t('reviewBody', { next: delivery.trancheIndex, owner: ownerIsBeneficiary ? 'beneficiary' : 'ngo' })}
      </p>
      <ReleasePolicyNote
        policy={policy}
        verifiers={verifications}
        strikes={strikes}
        compact
        ownerIsBeneficiary={ownerIsBeneficiary}
      />
      <a className="link text-sm" href={`#delivery-${delivery.id}`}>
        {t('reviewSee', { count: files })}
      </a>

      <VoteProgress delivery={delivery} unit={unit} />

      {!mounted || !address ? (
        <p className="text-sm text-slate-600">{t('reviewConnect')}</p>
      ) : voted || signed.phase === 'done' ? (
        <p className="text-sm font-medium text-emerald-800">{t('reviewDone')}</p>
      ) : voice === 'None' || weight === 0n ? (
        <p className="text-sm text-slate-600">{t('reviewNoSay')}</p>
      ) : voice !== undefined && weight !== undefined ? (
        <div className="space-y-3">
          <p className="text-xs text-slate-700">
            {voice === 'Verifier'
              ? t('reviewWeightVerifier')
              : t('reviewWeight', { weight: amount(weight), unit })}
          </p>

          {confirmReject ? (
            <div className="space-y-2 rounded-md border border-red-200 bg-red-50 p-3">
              <p className="text-sm text-red-900">
                {t('reviewRejectWarning')}{' '}
                {tPolicy('retries', { retries: Math.max(0, policy.retries - strikes) })}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-danger"
                  disabled={wrongChain || busy}
                  onClick={() => vote(false)}
                >
                  {t('reviewRejectConfirm')}
                </button>
                <button type="button" className="btn-secondary" onClick={() => setConfirmReject(false)}>
                  {t('reviewRejectCancel')}
                </button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                className="btn-primary"
                disabled={wrongChain || busy}
                onClick={() => vote(true)}
              >
                {t('reviewApprove')}
              </button>
              <button
                type="button"
                className="btn-danger"
                disabled={wrongChain || busy}
                onClick={() => setConfirmReject(true)}
              >
                {t('reviewReject')}
              </button>
            </div>
          )}

          <label className="flex items-start gap-2 text-xs text-slate-700">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={free}
              onChange={(event) => setFree(event.target.checked)}
            />
            <span>{t('reviewFree')}</span>
          </label>
        </div>
      ) : null}

      {signed.phase === 'signing' ? <p className="text-xs text-slate-600">{t('reviewSigning')}</p> : null}
      {signed.phase === 'sending' ? <p className="text-xs text-slate-600">{t('reviewSending')}</p> : null}
      {signed.phase === 'failed' ? (
        <p className="text-xs text-red-800">{t('reviewRelayError', { detail: signed.error })}</p>
      ) : null}
      <TxStatus state={tx} />
    </section>
  )
}
