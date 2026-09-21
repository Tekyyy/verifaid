'use client'

import { needsRegistryAbi } from '@poa/shared'
import { useQuery } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import { type Address, type Hex, isAddress, keccak256, stringToHex } from 'viem'
import { FormError, Panel, TextField } from '@/components/form'
import { TxStatus } from '@/components/TxStatus'
import { deployment } from '@/lib/config'
import { shorten, ZERO_BYTES32 } from '@/lib/format'
import { useTx } from '@/lib/hooks'
import { getNeed, getSuppliers } from '@/lib/indexer'

/**
 * Replacing a supplier in a need's payment plan: the NGO proposes one, and it only takes effect when enough
 * independent verifiers have approved it (the need's own threshold, never fewer than two). A tranche that is
 * already releasable cannot be redirected — the contract refuses it, so the work someone did is paid first.
 */
export function ProposePayeeChangePanel() {
  const t = useTranslations('ngo')
  const tx = useTx()
  const id = useId()
  const [needId, setNeedId] = useState('')
  const [index, setIndex] = useState('')
  const [account, setAccount] = useState('')
  const [label, setLabel] = useState('')
  const [ref, setRef] = useState('')
  const [error, setError] = useState<string | null>(null)

  const plan = useQuery({
    queryKey: ['need-plan', needId],
    queryFn: () => getNeed(needId),
    enabled: /^\d+$/.test(needId),
  })
  const suppliers = useQuery({ queryKey: ['suppliers'], queryFn: getSuppliers })
  const payees = plan.data?.ok ? plan.data.data.payees : []
  const active = suppliers.data?.ok ? suppliers.data.data.filter((supplier) => supplier.active) : []
  const registry = deployment?.contracts.NeedsRegistry as Address | undefined

  const propose = async () => {
    if (!registry || !/^\d+$/.test(needId) || !/^\d+$/.test(index) || !isAddress(account)) {
      return setError(t('changeErrorFields'))
    }
    setError(null)
    await tx.run({
      address: registry,
      abi: needsRegistryAbi,
      functionName: 'proposePayeeChange',
      args: [
        BigInt(needId),
        Number(index),
        account as Address,
        (ref.trim() ? keccak256(stringToHex(ref.trim())) : ZERO_BYTES32) as Hex,
        label.trim(),
      ],
    })
  }

  return (
    <Panel title={t('changeTitle')} description={t('changeBody')}>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label={t('needId')} value={needId} onChange={setNeedId} inputMode="numeric" />
        <div>
          <label className="label" htmlFor={`${id}-payee`}>
            {t('changeWhich')}
          </label>
          <select
            id={`${id}-payee`}
            className="input"
            value={index}
            onChange={(event) => setIndex(event.target.value)}
          >
            <option value="">{t('changePickPayee')}</option>
            {payees
              .filter((payee) => payee.account !== null)
              .map((payee) => (
                <option key={payee.index} value={String(payee.index)}>
                  {payee.index}: {payee.label || shorten(payee.account as Address)}
                </option>
              ))}
          </select>
          <p className="hint">{t('changeNoNgo')}</p>
        </div>
      </div>

      <div>
        <label className="label" htmlFor={`${id}-supplier`}>
          {t('changeReplacement')}
        </label>
        <select
          id={`${id}-supplier`}
          className="input font-mono"
          value={active.some((supplier) => supplier.address === account) ? account : ''}
          onChange={(event) => setAccount(event.target.value)}
        >
          <option value="">{t('planPick')}</option>
          {active.map((supplier) => (
            <option key={supplier.address} value={supplier.address}>
              {supplier.address}
            </option>
          ))}
        </select>
        <TextField label={t('planAccountManual')} value={account} onChange={setAccount} placeholder="0x…" />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label={t('planLabel')} value={label} onChange={setLabel} />
        <TextField label={t('planRef')} value={ref} onChange={setRef} hint={t('planRefHint')} />
      </div>

      <FormError message={error} />
      <button
        type="button"
        className="btn-primary"
        disabled={tx.phase === 'signing' || tx.phase === 'pending'}
        onClick={propose}
      >
        {t('changePropose')}
      </button>
      <TxStatus state={tx} />
    </Panel>
  )
}

/**
 * The verifier's side: approving a proposed replacement. The approval that reaches the threshold applies it, so
 * the last verifier's transaction is the one that moves the money's destination.
 */
export function ApprovePayeeChangePanel() {
  const t = useTranslations('verifier')
  const tPlan = useTranslations('plan')
  const tx = useTx()
  const [needId, setNeedId] = useState('')
  const [error, setError] = useState<string | null>(null)

  const plan = useQuery({
    queryKey: ['need-plan', needId],
    queryFn: () => getNeed(needId),
    enabled: /^\d+$/.test(needId),
  })
  const pending = plan.data?.ok
    ? plan.data.data.payeeChanges.filter((change) => change.status === 'PENDING')
    : []
  const registry = deployment?.contracts.NeedsRegistry as Address | undefined

  const approve = async (changeId: string) => {
    if (!registry || !/^\d+$/.test(needId)) return setError(t('changeErrorNeed'))
    setError(null)
    await tx.run({
      address: registry,
      abi: needsRegistryAbi,
      functionName: 'approvePayeeChange',
      args: [BigInt(needId), BigInt(changeId)],
    })
  }

  return (
    <Panel title={t('changeTitle')} description={t('changeBody')}>
      <TextField label={t('needId')} value={needId} onChange={setNeedId} inputMode="numeric" />
      {plan.data?.ok && pending.length === 0 ? <p className="hint">{t('changeNone')}</p> : null}
      <ul className="space-y-2">
        {pending.map((change) => (
          <li key={change.changeId} className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
            <p>
              {tPlan('changeLine', {
                from: shorten(change.from),
                to: shorten(change.to),
                label: change.label || tPlan('unnamed'),
              })}
            </p>
            <p className="mt-1 text-xs text-slate-600">
              {tPlan('changeApprovals', {
                approvals: change.approvals,
                required: change.approvalsRequired,
              })}
            </p>
            <button
              type="button"
              className="btn-primary mt-2 text-xs"
              disabled={tx.phase === 'signing' || tx.phase === 'pending'}
              onClick={() => approve(change.changeId)}
            >
              {t('changeApprove')}
            </button>
          </li>
        ))}
      </ul>
      <FormError message={error} />
      <TxStatus state={tx} />
    </Panel>
  )
}
