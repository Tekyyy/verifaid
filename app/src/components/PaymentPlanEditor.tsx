'use client'

import { useQuery } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useId } from 'react'
import { type Hex, isAddress, keccak256, stringToHex } from 'viem'
import { TextField } from '@/components/form'
import { ZERO_BYTES32 } from '@/lib/format'
import { getSuppliers } from '@/lib/indexer'

/**
 * Contract bounds (NeedsRegistry): at most 5 payees, and an NGO takes at most 25% of a need for itself. A certified
 * beneficiary's own share is the aid itself and has no cap.
 */
export const MAX_PAYEES = 5
export const MAX_NGO_SHARE_BPS = 2500
export const NO_OWN_SHARE_CAP = 10_000
/**
 * The owner's own share is the zero address in the plan; the vault resolves it to the NGO's payout Safe, or to the
 * wallet of the beneficiary who posted the need.
 */
export const NGO_PAYEE = 'ngo' as const

export interface PlanRow {
  /** A registered supplier's address, or `NGO_PAYEE` for the NGO's own disclosed share. */
  account: string
  label: string
  /** The contract or quote agreed with this payee; stored as a hash. */
  ref: string
  /** Percent of each tranche, one entry per tranche, as typed. */
  shares: string[]
}

export const emptyRow = (tranches: number): PlanRow => ({
  account: '',
  label: '',
  ref: '',
  shares: Array.from({ length: tranches }, () => ''),
})

const percentToBps = (value: string): number | null => {
  const trimmed = value.trim().replace(',', '.')
  if (trimmed === '') return 0
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(trimmed)) return null
  const bps = Math.round(Number(trimmed) * 100)
  return bps >= 0 && bps <= 10_000 ? bps : null
}

export interface PlanPayee {
  account: `0x${string}`
  shareBps: number[]
  refHash: Hex
  label: string
}

export interface PlanCheck {
  /** The plan as `NeedsRegistry.Payee[]`, or null while it is not valid. */
  payees: PlanPayee[] | null
  /** Sum of each tranche's shares in bps, for the live totals under the table. */
  trancheSums: number[]
  /** The NGO's share of the whole need in bps (its shares weighted by the tranche plan). */
  ngoShareBps: number
  /** Translation key of the first problem, or null. */
  problem: string | null
}

/**
 * Mirrors `NeedsRegistry._validatePayees`, so an NGO sees what is wrong before paying for a revert: one to five
 * payees, a share for every tranche, each tranche summing to exactly 100%, no payee that never gets anything,
 * at most one NGO entry, no duplicates, and the NGO's own share capped at 25% of the need.
 */
export const checkPlan = (
  rows: PlanRow[],
  trancheBps: number[],
  maxOwnShareBps: number = MAX_NGO_SHARE_BPS,
): PlanCheck => {
  const trancheSums = trancheBps.map(() => 0)
  let ngoShareBps = 0
  let ngoEntries = 0
  let problem: string | null = null
  const payees: PlanPayee[] = []
  const seen = new Set<string>()

  if (rows.length === 0 || rows.length > MAX_PAYEES) problem ??= 'planCount'

  for (const row of rows) {
    const isNgo = row.account === NGO_PAYEE
    if (!isNgo && !isAddress(row.account)) problem ??= 'planAddress'
    const key = isNgo ? NGO_PAYEE : row.account.toLowerCase()
    if (seen.has(key)) problem ??= 'planDuplicate'
    seen.add(key)
    if (isNgo) ngoEntries += 1

    const shareBps: number[] = []
    let total = 0
    row.shares.forEach((share, index) => {
      const bps = percentToBps(share)
      if (bps === null) {
        problem ??= 'planShare'
        shareBps.push(0)
        return
      }
      shareBps.push(bps)
      total += bps
      trancheSums[index] = (trancheSums[index] ?? 0) + bps
      if (isNgo) ngoShareBps += ((trancheBps[index] ?? 0) * bps) / 10_000
    })
    if (total === 0) problem ??= 'planEmptyPayee'

    payees.push({
      account: isNgo ? '0x0000000000000000000000000000000000000000' : (row.account as `0x${string}`),
      shareBps,
      refHash: row.ref.trim() ? keccak256(stringToHex(row.ref.trim())) : ZERO_BYTES32,
      label: row.label.trim(),
    })
  }

  if (ngoEntries > 1) problem ??= 'planNgoTwice'
  if (trancheSums.some((sum) => sum !== 10_000)) problem ??= 'planTrancheSum'
  if (Math.round(ngoShareBps) > maxOwnShareBps) problem ??= 'planNgoCap'

  return { payees: problem ? null : payees, trancheSums, ngoShareBps: Math.round(ngoShareBps), problem }
}

/**
 * The payment plan an on-chain need is created with: who its vault pays directly, and what part of every tranche
 * each one receives. Only addresses the admin registered as suppliers are accepted by the contract, so the list
 * comes from the indexer; an address can still be pasted, and the contract remains the final check.
 */
export function PaymentPlanEditor({
  rows,
  onChange,
  trancheBps,
  check,
  asBeneficiary = false,
}: {
  rows: PlanRow[]
  onChange: (rows: PlanRow[]) => void
  trancheBps: number[]
  check: PlanCheck
  /** The plan of a need a beneficiary posts: the own share is their wallet, not an NGO's payout Safe. */
  asBeneficiary?: boolean
}) {
  const t = useTranslations('ngo')
  const query = useQuery({ queryKey: ['suppliers'], queryFn: getSuppliers })
  const active = query.data?.ok ? query.data.data.filter((supplier) => supplier.active) : []

  const update = (index: number, patch: Partial<PlanRow>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  const updateShare = (index: number, trancheIndex: number, value: string) =>
    update(index, {
      shares: (rows[index]?.shares ?? []).map((share, i) => (i === trancheIndex ? value : share)),
    })

  return (
    <fieldset className="space-y-3 rounded-md border border-slate-200 p-3">
      <legend className="px-1 text-sm font-semibold text-slate-900">{t('planTitle')}</legend>
      <p className="text-xs text-slate-700">{t('planBody')}</p>
      {!query.isLoading && active.length === 0 ? <p className="hint">{t('planNoSuppliers')}</p> : null}

      {rows.map((row, index) => (
        <PlanRowFields
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional — the plan's own payee index
          key={index}
          row={row}
          index={index}
          suppliers={active.map((supplier) => supplier.address)}
          trancheBps={trancheBps}
          onField={(patch) => update(index, patch)}
          onShare={(trancheIndex, value) => updateShare(index, trancheIndex, value)}
          onRemove={rows.length > 1 ? () => onChange(rows.filter((_, i) => i !== index)) : undefined}
          asBeneficiary={asBeneficiary}
        />
      ))}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-secondary text-xs"
          disabled={rows.length >= MAX_PAYEES}
          onClick={() => onChange([...rows, emptyRow(trancheBps.length)])}
        >
          {t('planAdd')}
        </button>
        <span className="text-xs text-slate-600">
          {t('planTotals', {
            totals: check.trancheSums.map((sum) => `${(sum / 100).toFixed(0)}%`).join(' / '),
            ngo: (check.ngoShareBps / 100).toFixed(2),
            owner: asBeneficiary ? 'beneficiary' : 'ngo',
          })}
        </span>
      </div>
    </fieldset>
  )
}

function PlanRowFields({
  row,
  index,
  suppliers,
  trancheBps,
  onField,
  onShare,
  onRemove,
  asBeneficiary,
}: {
  row: PlanRow
  index: number
  suppliers: string[]
  trancheBps: number[]
  onField: (patch: Partial<PlanRow>) => void
  onShare: (trancheIndex: number, value: string) => void
  onRemove?: () => void
  asBeneficiary: boolean
}) {
  const t = useTranslations('ngo')
  const id = useId()
  const isNgo = row.account === NGO_PAYEE

  return (
    <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
          {t('planPayee', { index: index + 1 })}
        </span>
        {onRemove ? (
          <button type="button" className="text-xs text-slate-600 underline" onClick={onRemove}>
            {t('planRemove')}
          </button>
        ) : null}
      </div>

      <div>
        <label className="label" htmlFor={id}>
          {t('planAccount')}
        </label>
        <select
          id={id}
          className="input font-mono"
          value={suppliers.includes(row.account) || isNgo ? row.account : ''}
          onChange={(event) => onField({ account: event.target.value })}
        >
          <option value="">{t('planPick')}</option>
          <option value={NGO_PAYEE}>{asBeneficiary ? t('planOwnOption') : t('planNgoOption')}</option>
          {suppliers.map((address) => (
            <option key={address} value={address}>
              {address}
            </option>
          ))}
        </select>
        {!isNgo ? (
          <TextField
            label={t('planAccountManual')}
            value={isNgo ? '' : row.account}
            onChange={(value) => onField({ account: value })}
            placeholder="0x…"
          />
        ) : null}
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <TextField label={t('planLabel')} value={row.label} onChange={(value) => onField({ label: value })} />
        <TextField
          label={t('planRef')}
          value={row.ref}
          onChange={(value) => onField({ ref: value })}
          hint={t('planRefHint')}
        />
      </div>

      <div className="grid gap-2 sm:grid-cols-5">
        {trancheBps.map((bps, trancheIndex) => (
          <TextField
            // biome-ignore lint/suspicious/noArrayIndexKey: one field per tranche, in tranche order
            key={trancheIndex}
            label={t('planTrancheShare', { index: trancheIndex + 1, tranche: (bps / 100).toFixed(0) })}
            value={row.shares[trancheIndex] ?? ''}
            onChange={(value) => onShare(trancheIndex, value)}
            inputMode="decimal"
          />
        ))}
      </div>
    </div>
  )
}
