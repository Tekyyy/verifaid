'use client'

import { communityProofsAbi, mockEURCAbi, type NeedDetail } from '@poa/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import type { Address } from 'viem'
import { useAccount, usePublicClient, useReadContract } from 'wagmi'
import { EvidenceFiles } from '@/components/DeliveryCard'
import { ExplorerLink } from '@/components/ExplorerLink'
import { FormError, Panel, TextField } from '@/components/form'
import { TxStatus } from '@/components/TxStatus'
import {
  bountyDeadline,
  MAX_BOUNTY_DAYS,
  MAX_REWARDS,
  MIN_BOUNTY_DAYS,
  openBountyOf,
  payableProofs,
} from '@/lib/community'
import { deployment } from '@/lib/config'
import { amount, parseAmount, timestamp } from '@/lib/format'
import { useTx } from '@/lib/hooks'

/**
 * The NGO's reward pot for community proof on one need. Opening one locks `reward × count` from the NGO's own wallet
 * — never donors' money — in the CommunityProofs contract; rewarding a proof credits one reward to the wallet that
 * filed it, once per wallet per need, as credit it can only give to a need or a basket; closing returns what is left.
 */
export function ProofBountyPanel({ need }: { need: NeedDetail }) {
  const t = useTranslations('community')
  const tCommon = useTranslations('common')
  const unit = tCommon('amountUnit')
  const queryClient = useQueryClient()
  const contract = deployment?.contracts.CommunityProofs
  const bounty = openBountyOf(need.bounties)

  const refresh = async () => {
    // The indexer trails the receipt by a block or two.
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    await queryClient.invalidateQueries({ queryKey: ['ngo-need', need.id] })
  }

  if (!contract) return null

  return (
    <Panel title={t('bountyTitle')} description={t('bountyBody')}>
      {bounty ? (
        <OpenPot need={need} contract={contract} onChange={refresh} />
      ) : (
        <OpenForm needId={need.id} contract={contract} unit={unit} onOpened={refresh} />
      )}
    </Panel>
  )
}

function OpenForm({
  needId,
  contract,
  unit,
  onOpened,
}: {
  needId: string
  contract: Address
  unit: string
  onOpened: () => Promise<void>
}) {
  const t = useTranslations('community')
  const { address } = useAccount()
  const publicClient = usePublicClient()
  const approve = useTx()
  const open = useTx()
  const [reward, setReward] = useState('5')
  const [count, setCount] = useState('10')
  const [days, setDays] = useState('30')
  const [error, setError] = useState<string | null>(null)
  const token = deployment?.external.Token as Address | undefined

  const perProof = parseAmount(reward)
  const howMany = /^\d+$/.test(count.trim()) ? Number(count.trim()) : null
  const howLong = /^\d+$/.test(days.trim()) ? Number(days.trim()) : null
  const total = perProof !== null && howMany !== null ? perProof * BigInt(howMany) : null

  const allowance = useReadContract({
    address: token,
    abi: mockEURCAbi,
    functionName: 'allowance',
    args: address ? [address, contract] : undefined,
    query: { enabled: Boolean(address && token) },
  })
  const approved = total !== null && total > 0n && (allowance.data ?? 0n) >= total

  const problem = (): string | null => {
    if (perProof === null || perProof <= 0n) return t('errorReward')
    if (howMany === null || howMany < 1 || howMany > MAX_REWARDS) return t('errorCount', { max: MAX_REWARDS })
    if (howLong === null || howLong < MIN_BOUNTY_DAYS || howLong > MAX_BOUNTY_DAYS) {
      return t('errorDays', { min: MIN_BOUNTY_DAYS, max: MAX_BOUNTY_DAYS })
    }
    return null
  }

  const runApprove = async () => {
    const reason = problem()
    if (reason || !token || total === null) return setError(reason)
    setError(null)
    const result = await approve.run({
      address: token,
      abi: mockEURCAbi,
      functionName: 'approve',
      args: [contract, total],
    })
    if (result) await allowance.refetch()
  }

  const runOpen = async () => {
    const reason = problem()
    if (reason || perProof === null || howMany === null || howLong === null) return setError(reason)
    setError(null)
    const latest = await publicClient?.getBlock().catch(() => null)
    const deadline = bountyDeadline(
      latest ? Number(latest.timestamp) : Math.floor(Date.now() / 1000),
      howLong,
    )
    const result = await open.run({
      address: contract,
      abi: communityProofsAbi,
      functionName: 'openBounty',
      args: [BigInt(needId), perProof, howMany, deadline],
    })
    if (result) await onOpened()
  }

  const busy = (state: { phase: string }) => state.phase === 'signing' || state.phase === 'pending'

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <TextField
          label={t('rewardLabel', { unit })}
          value={reward}
          onChange={setReward}
          inputMode="decimal"
        />
        <TextField label={t('countLabel')} value={count} onChange={setCount} inputMode="numeric" />
        <TextField label={t('daysLabel')} value={days} onChange={setDays} inputMode="numeric" />
      </div>
      {total !== null && total > 0n ? (
        <p className="text-sm text-slate-700">{t('total', { total: amount(total), unit })}</p>
      ) : null}
      <FormError message={error} />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-secondary"
          disabled={busy(approve) || approved}
          onClick={runApprove}
        >
          {approved ? t('approved') : t('approve')}
        </button>
        <button type="button" className="btn-primary" disabled={busy(open) || !approved} onClick={runOpen}>
          {t('open')}
        </button>
      </div>
      <TxStatus state={approve} />
      <TxStatus state={open} />
    </div>
  )
}

function OpenPot({
  need,
  contract,
  onChange,
}: {
  need: NeedDetail
  contract: Address
  onChange: () => Promise<void>
}) {
  const t = useTranslations('community')
  const tCommon = useTranslations('common')
  const unit = tCommon('amountUnit')
  const pay = useTx()
  const close = useTx()
  const [paying, setPaying] = useState<string | null>(null)
  const bounty = openBountyOf(need.bounties)
  if (!bounty) return null

  const waiting = payableProofs(need.communityProofs, bounty)
  const now = Math.floor(Date.now() / 1000)
  const empty = BigInt(bounty.balance) < BigInt(bounty.reward)
  const busy = (state: { phase: string }) => state.phase === 'signing' || state.phase === 'pending'

  const payFor = async (proofId: string) => {
    setPaying(proofId)
    const result = await pay.run({
      address: contract,
      abi: communityProofsAbi,
      functionName: 'rewardProof',
      args: [BigInt(proofId)],
    })
    if (result) await onChange()
    setPaying(null)
  }

  const closePot = async () => {
    const result = await close.run({
      address: contract,
      abi: communityProofsAbi,
      functionName: 'closeBounty',
      args: [BigInt(bounty.id)],
    })
    if (result) await onChange()
  }

  return (
    <div className="space-y-4">
      <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        {t('status', {
          reward: amount(bounty.reward),
          unit,
          paid: bounty.rewardsPaid,
          max: bounty.maxRewards,
          balance: amount(bounty.balance),
          date: timestamp(bounty.deadline),
        })}
        {now > bounty.deadline ? ` ${t('pastDeadline')}` : ''}
      </p>

      <div>
        <h3 className="text-sm font-semibold text-slate-900">{t('waitingTitle')}</h3>
        {waiting.length === 0 ? (
          <p className="mt-1 text-sm text-slate-600">{t('noneWaiting')}</p>
        ) : (
          <ul className="mt-2 space-y-3">
            {waiting.map((proof) => (
              <li key={proof.id} className="rounded-md border border-slate-200 bg-white p-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
                  <span className="flex items-center gap-1">
                    {t('filedBy')} <ExplorerLink kind="address" value={proof.submitter} /> ·{' '}
                    {timestamp(proof.submittedAt)}
                  </span>
                  <button
                    type="button"
                    className="btn-primary px-3 py-1 text-xs"
                    disabled={busy(pay) || empty}
                    onClick={() => payFor(proof.id)}
                  >
                    {paying === proof.id && busy(pay)
                      ? t('paying')
                      : t('pay', { amount: amount(bounty.reward), unit })}
                  </button>
                </div>
                {proof.manifest?.note ? (
                  <p className="mt-2 text-sm text-slate-800">{proof.manifest.note}</p>
                ) : null}
                {proof.manifest ? <EvidenceFiles files={proof.manifest.files} /> : null}
              </li>
            ))}
          </ul>
        )}
        <TxStatus state={pay} />
      </div>

      <div className="border-t border-slate-100 pt-3">
        <button type="button" className="btn-secondary" disabled={busy(close)} onClick={closePot}>
          {t('close', { amount: amount(bounty.balance), unit })}
        </button>
        <p className="hint mt-1">{t('closeHint')}</p>
        <TxStatus state={close} />
      </div>
    </div>
  )
}
