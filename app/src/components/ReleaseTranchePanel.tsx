'use client'

import { aidVaultAbi, type NeedDetail } from '@poa/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useEffect, useId, useState } from 'react'
import { type Address, isAddressEqual } from 'viem'
import { useAccount } from 'wagmi'
import { Panel, TextField } from '@/components/form'
import { TxStatus } from '@/components/TxStatus'
import { amount, bpsPercent, shorten } from '@/lib/format'
import { useLedger, useMounted, useTx } from '@/lib/hooks'
import { getNeed, getNeeds, type Result } from '@/lib/indexer'

/** Only a funded need, or one in delivery, can have a tranche waiting to be released. */
const RELEASE_STATUSES = new Set(['Funded', 'InDelivery'])

const releasable = (need: NeedDetail) => need.tranches.filter((tranche) => tranche.status === 'Releasable')

/** The connected NGO's needs that could have something to release, with their tranches. */
const loadCandidates = async (ngo: Address): Promise<Result<NeedDetail[]>> => {
  const needs = await getNeeds()
  if (!needs.ok) return needs
  const mine = needs.data.filter((need) => isAddressEqual(need.ngo, ngo) && RELEASE_STATUSES.has(need.status))
  const details = await Promise.all(mine.map((need) => getNeed(need.id)))
  return { ok: true, data: details.flatMap((detail) => (detail.ok ? [detail.data] : [])) }
}

/**
 * Releasing a tranche, picked rather than typed: the NGO's funded needs, then that need's tranches, with only the
 * releasable ones selectable. The contract decides who is paid — the need's payment plan, straight from the
 * vault — and the panel says so before the signature. The ids stay typeable when the indexer cannot answer.
 */
export function ReleaseTranchePanel() {
  const t = useTranslations('ngo')
  const tCommon = useTranslations('common')
  const tStatus = useTranslations('trancheStatus')
  const needSelectId = useId()
  const trancheSelectId = useId()
  const mounted = useMounted()
  const { address } = useAccount()
  const queryClient = useQueryClient()
  const tx = useTx()
  const [needId, setNeedId] = useState('')
  const [index, setIndex] = useState('')
  const vault = useLedger(needId)

  const query = useQuery({
    queryKey: ['ngo-release', address],
    queryFn: () => loadCandidates(address as Address),
    enabled: Boolean(address),
  })
  const candidates = query.data?.ok ? query.data.data : []
  const need = candidates.find((candidate) => candidate.id === needId)

  // Start on the first need that has something ready, and on its first ready tranche.
  useEffect(() => {
    if (needId || candidates.length === 0) return
    const first = candidates.find((candidate) => releasable(candidate).length > 0) ?? candidates[0]
    if (first) setNeedId(first.id)
  }, [candidates, needId])
  useEffect(() => {
    if (!need) return
    const current = need.tranches.find((tranche) => String(tranche.index) === index)
    if (current?.status === 'Releasable') return
    setIndex(String(releasable(need)[0]?.index ?? ''))
  }, [need, index])

  const unit = tCommon('amountUnit')
  const release = async () => {
    if (!vault || !/^\d+$/.test(index)) return
    const result = await tx.run({
      address: vault,
      abi: aidVaultAbi,
      functionName: 'releaseTranche',
      args: [BigInt(index)],
    })
    if (!result) return
    // The indexer trails the receipt; refresh once it shows the tranche paid, so it drops out of the list.
    for (let attempt = 0; attempt < 20; attempt++) {
      const fresh = await getNeed(needId)
      if (
        fresh.ok &&
        fresh.data.tranches.find((tranche) => String(tranche.index) === index)?.status === 'Released'
      ) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 1_500))
    }
    setIndex('')
    await queryClient.invalidateQueries({ queryKey: ['ngo-release'] })
  }

  const button = (
    <button
      type="button"
      className="btn-primary"
      disabled={!vault || !/^\d+$/.test(index) || tx.phase === 'signing' || tx.phase === 'pending'}
      onClick={release}
    >
      {t('releaseTranche')}
    </button>
  )

  if (!mounted || !address) {
    return (
      <Panel title={t('releaseTitle')} description={t('releaseBody')}>
        <p className="hint">{t('releaseConnect')}</p>
      </Panel>
    )
  }

  // The indexer could not answer: typing the ids still works, and the contract checks them.
  if (query.data && !query.data.ok) {
    return (
      <Panel title={t('releaseTitle')} description={t('releaseBody')}>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label={t('needId')} value={needId} onChange={setNeedId} inputMode="numeric" />
          <TextField label={t('trancheIndex')} value={index} onChange={setIndex} inputMode="numeric" />
        </div>
        {button}
        <TxStatus state={tx} />
      </Panel>
    )
  }

  const tranche = need?.tranches.find((candidate) => String(candidate.index) === index)
  const payees = (need?.payees ?? [])
    .filter((payee) => tranche && (payee.shareBps[tranche.index] ?? 0) > 0)
    .map((payee) =>
      payee.account
        ? `${payee.label} (${shorten(payee.account, 6, 4)})`
        : `${payee.label || t('releaseYourOrg')}`,
    )

  return (
    <Panel title={t('releaseTitle')} description={t('releaseBody')}>
      {query.isLoading ? <p className="hint">{tCommon('loading')}</p> : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor={needSelectId}>
            {t('releaseNeed')}
          </label>
          <select
            id={needSelectId}
            className="input"
            value={need ? needId : ''}
            disabled={candidates.length === 0}
            onChange={(event) => {
              setNeedId(event.target.value)
              setIndex('')
            }}
          >
            <option value="" disabled>
              {candidates.length === 0 ? t('releaseNoNeeds') : t('releasePickNeed')}
            </option>
            {candidates.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {t('releaseNeedOption', {
                  id: candidate.id,
                  category: candidate.categoryLabel,
                  ready: releasable(candidate).length,
                })}
              </option>
            ))}
          </select>
          {candidates.length === 0 && query.data?.ok ? (
            <p className="hint">{t('releaseNoNeedsHint')}</p>
          ) : null}
        </div>

        <div>
          <label className="label" htmlFor={trancheSelectId}>
            {t('releaseTrancheLabel')}
          </label>
          <select
            id={trancheSelectId}
            className="input"
            value={tranche?.status === 'Releasable' ? index : ''}
            disabled={!need}
            onChange={(event) => setIndex(event.target.value)}
          >
            <option value="" disabled>
              {need && releasable(need).length === 0 ? t('releaseNothingReady') : t('releasePickTranche')}
            </option>
            {(need?.tranches ?? []).map((option) => (
              <option key={option.index} value={option.index} disabled={option.status !== 'Releasable'}>
                {t('releaseTrancheOption', {
                  index: option.index,
                  percent: bpsPercent(option.bps),
                  amount: amount(option.amount),
                  unit,
                  status: tStatus(option.status),
                })}
              </option>
            ))}
          </select>
        </div>
      </div>

      {tranche?.status === 'Releasable' && payees.length > 0 ? (
        <p className="text-sm text-slate-800">
          {t('releasePaysTo', { amount: amount(tranche.amount), unit, payees: payees.join(', ') })}
        </p>
      ) : null}
      {need && releasable(need).length === 0 ? <p className="hint">{t('releaseWaiting')}</p> : null}

      {button}
      <TxStatus state={tx} />
    </Panel>
  )
}
