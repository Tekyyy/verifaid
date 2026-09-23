'use client'

import { aidVaultAbi } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import type { Address } from 'viem'
import { useReadContract } from 'wagmi'
import { Panel, TextField } from '@/components/form'
import { TxStatus } from '@/components/TxStatus'
import { deployment } from '@/lib/config'
import { amount } from '@/lib/format'
import { useLedger, useTx } from '@/lib/hooks'

/**
 * Working the money that waits. Every one of these is permissionless on the contract — the rules decide the
 * amount, not who is asking — so this is a convenience for the NGO and a stand-in for the keeper that will
 * eventually do it on a schedule. Nothing here can send money anywhere except back into the vault or, once the
 * need is over and the position closed, the earnings to the NGO.
 */
export function IdleCapitalPanel({ needId: fixedNeedId }: { needId?: string } = {}) {
  const t = useTranslations('idle')
  const tCommon = useTranslations('common')
  const deploy = useTx()
  const unwind = useTx()
  const harvest = useTx()
  const payout = useTx()
  const [typedNeedId, setNeedId] = useState('')
  // Fixed by the need dashboard; typed when the panel stands alone.
  const needId = fixedNeedId ?? typedNeedId
  const vault = useLedger(needId)

  const enabled = Boolean(vault)
  const { data: room, refetch: refetchRoom } = useReadContract({
    address: vault,
    abi: aidVaultAbi,
    functionName: 'deployableAmount',
    query: { enabled },
  })
  const { data: principal, refetch: refetchPrincipal } = useReadContract({
    address: vault,
    abi: aidVaultAbi,
    functionName: 'deployedPrincipal',
    query: { enabled },
  })
  const { data: value, refetch: refetchValue } = useReadContract({
    address: vault,
    abi: aidVaultAbi,
    functionName: 'sleeveValue',
    query: { enabled },
  })

  if (!deployment?.external.YieldVenue) return null

  const unit = tCommon('amountUnit')
  const deployable = room ?? 0n
  const lent = principal ?? 0n
  const unrealised = value?.[1] ?? 0n

  const refresh = async () => {
    await Promise.all([refetchRoom(), refetchPrincipal(), refetchValue()])
  }

  const run = async (
    tx: ReturnType<typeof useTx>,
    functionName: 'deployIdle' | 'unwind' | 'harvest' | 'payYield',
    args?: readonly [bigint],
  ) => {
    if (!vault) return
    const result = await tx.run({
      address: vault as Address,
      abi: aidVaultAbi,
      functionName,
      ...(args ? { args } : {}),
      // biome-ignore lint/suspicious/noExplicitAny: four writes with different arities share one call site
    } as any)
    if (result) await refresh()
  }

  const busy = (tx: ReturnType<typeof useTx>) => tx.phase === 'signing' || tx.phase === 'pending'
  const anyBusy = busy(deploy) || busy(unwind) || busy(harvest) || busy(payout)

  return (
    <Panel title={t('manageTitle')} description={t('manageBody')}>
      {fixedNeedId === undefined ? (
        <TextField label={t('needId')} value={typedNeedId} onChange={setNeedId} inputMode="numeric" />
      ) : null}

      {vault ? (
        <>
          <dl className="grid gap-3 sm:grid-cols-3">
            <div>
              <dt className="text-xs text-slate-600">{t('deployable')}</dt>
              <dd className="text-sm font-semibold tabular-nums">
                {amount(deployable)} {unit}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-600">{t('deployed')}</dt>
              <dd className="text-sm font-semibold tabular-nums">
                {amount(lent)} {unit}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-600">{t('unrealised')}</dt>
              <dd className="text-sm font-semibold tabular-nums text-emerald-800">
                {amount(unrealised)} {unit}
              </dd>
            </div>
          </dl>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary"
              disabled={anyBusy || deployable === 0n}
              onClick={() => run(deploy, 'deployIdle', [deployable])}
            >
              {t('deployButton')}
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={anyBusy || lent === 0n}
              onClick={() => run(unwind, 'unwind', [lent + unrealised])}
            >
              {t('unwindButton')}
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={anyBusy || unrealised === 0n}
              onClick={() => run(harvest, 'harvest')}
            >
              {t('harvestButton')}
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={anyBusy}
              onClick={() => run(payout, 'payYield')}
            >
              {t('payButton')}
            </button>
          </div>

          <TxStatus state={deploy} />
          <TxStatus state={unwind} />
          <TxStatus state={harvest} />
          <TxStatus state={payout} />
          <p className="hint">{t('manageHint')}</p>
        </>
      ) : null}
    </Panel>
  )
}
