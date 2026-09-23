'use client'

import { aidVaultAbi, easAbi, needsRegistryAbi, trancheStatusName } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { type Address, type Hex, keccak256, stringToHex } from 'viem'
import { useReadContract } from 'wagmi'
import { FormError, Panel, TextField } from '@/components/form'
import { Notice } from '@/components/Notice'
import { TxStatus } from '@/components/TxStatus'
import { deployment } from '@/lib/config'
import { attestationRequest, hasSchema, schemaRecipient } from '@/lib/eas'
import { amount, bpsPercent, parseAmount, ZERO_BYTES32 } from '@/lib/format'
import { useLedger, useTx } from '@/lib/hooks'

const hashText = (text: string): Hex => (text.trim() ? keccak256(stringToHex(text.trim())) : ZERO_BYTES32)

/**
 * Settlement attestation for an on-chain need: after the vault released a tranche to the NGO, the NGO reports
 * how it reached the supplier — gross (must equal the tranche), the fee intermediaries kept, and hashed
 * supplier and FX references. The resolver caps all fees on the need, cumulatively, at the disclosed rate.
 */
export function SettlementPanel() {
  const t = useTranslations('ngo')
  const tCommon = useTranslations('common')
  const tErrors = useTranslations('errors')
  const tx = useTx()
  const [needId, setNeedId] = useState('')
  const [trancheIndex, setTrancheIndex] = useState('')
  const [fee, setFee] = useState('0')
  const [supplierRef, setSupplierRef] = useState('')
  const [fxRef, setFxRef] = useState('')
  const [error, setError] = useState<string | null>(null)

  const validId = /^\d+$/.test(needId)
  const ledger = useLedger(needId)
  const registry = deployment?.contracts.NeedsRegistry as Address

  const { data: capBps } = useReadContract({
    address: registry,
    abi: needsRegistryAbi,
    functionName: 'thirdPartyCostBpsOf',
    args: validId ? [BigInt(needId)] : undefined,
    query: { enabled: validId },
  })
  const { data: tranches } = useReadContract({
    address: ledger,
    abi: aidVaultAbi,
    functionName: 'getTranches',
    query: { enabled: Boolean(ledger) },
  })

  const released = (tranches ?? [])
    .map((tranche, index) => ({ index, amount: tranche.amount, status: trancheStatusName(tranche.status) }))
    .filter((tranche) => tranche.status === 'Released')
  const selected = released.find((tranche) => String(tranche.index) === trancheIndex)
  const parsedFee = parseAmount(fee)

  if (!hasSchema('Settlement')) {
    return (
      <Panel title={t('settlementTitle')} description={t('settlementBody')}>
        <Notice tone="warning" title={t('settlementNoSchema')} />
      </Panel>
    )
  }

  const submit = async () => {
    if (!validId || !ledger || !selected || parsedFee === null || !supplierRef.trim()) {
      return setError(tErrors('required'))
    }
    if (parsedFee > selected.amount) return setError(t('settlementFeeTooHigh'))
    setError(null)
    const recipient = schemaRecipient('Settlement', ledger) as Address
    await tx.run({
      address: deployment?.external.EAS as Address,
      abi: easAbi,
      functionName: 'attest',
      args: [
        attestationRequest({
          name: 'Settlement',
          recipient,
          values: [
            BigInt(needId),
            BigInt(selected.index),
            selected.amount,
            parsedFee,
            selected.amount - parsedFee,
            hashText(supplierRef),
            hashText(fxRef),
          ],
        }),
      ],
    })
  }

  const unit = tCommon('amountUnit')

  return (
    <Panel title={t('settlementTitle')} description={t('settlementBody')}>
      <TextField
        label={t('needId')}
        value={needId}
        onChange={(value) => {
          setNeedId(value)
          setTrancheIndex('')
        }}
        inputMode="numeric"
      />
      <p className="hint mono">{ledger ?? '—'}</p>

      <div>
        <label className="label" htmlFor="settlement-tranche">
          {t('settlementTranche')}
        </label>
        <select
          id="settlement-tranche"
          className="input"
          value={trancheIndex}
          onChange={(event) => setTrancheIndex(event.target.value)}
          disabled={released.length === 0}
        >
          <option value="">{released.length === 0 ? t('settlementNoReleased') : t('settlementPick')}</option>
          {released.map((tranche) => (
            <option key={tranche.index} value={tranche.index}>
              {t('settlementTrancheOption', {
                index: tranche.index,
                amount: amount(tranche.amount),
                unit,
              })}
            </option>
          ))}
        </select>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label={t('settlementFee', { unit })}
          value={fee}
          onChange={setFee}
          inputMode="decimal"
          hint={capBps !== undefined ? t('settlementCapHint', { percent: bpsPercent(capBps) }) : undefined}
        />
        <div>
          <p className="label">{t('settlementNet', { unit })}</p>
          <p className="mt-1 flex min-h-[44px] items-center text-sm font-semibold tabular-nums">
            {selected && parsedFee !== null && parsedFee <= selected.amount
              ? amount(selected.amount - parsedFee)
              : '—'}
          </p>
        </div>
        <TextField
          label={t('settlementSupplierRef')}
          value={supplierRef}
          onChange={setSupplierRef}
          hint={t('settlementSupplierHint')}
        />
        <TextField
          label={t('settlementFxRef')}
          value={fxRef}
          onChange={setFxRef}
          hint={t('settlementFxHint')}
        />
      </div>
      <p className="hint">
        {t('hashLabel')}: <span className="mono">{hashText(supplierRef)}</span>
      </p>

      <FormError message={error} />
      <button
        type="button"
        className="btn-primary"
        disabled={!selected || tx.phase === 'signing' || tx.phase === 'pending'}
        onClick={submit}
      >
        {t('settlementSubmit')}
      </button>
      <TxStatus state={tx} />
    </Panel>
  )
}
