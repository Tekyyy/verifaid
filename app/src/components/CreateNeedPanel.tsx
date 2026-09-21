'use client'

import { CATEGORIES, CUSTODY_MODE, type CustodyMode, categoryHash, needsRegistryAbi } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { type Address, type Hex, isAddress, keccak256, stringToHex, zeroAddress } from 'viem'
import { CustodianPicker } from '@/components/CustodianPicker'
import { DateField, FormError, Panel, SelectField, TextArea, TextField } from '@/components/form'
import { checkPlan, emptyRow, PaymentPlanEditor, type PlanRow } from '@/components/PaymentPlanEditor'
import { TxStatus } from '@/components/TxStatus'
import { deployment } from '@/lib/config'
import {
  bpsPercent,
  dateInputToUnix,
  isBytes32,
  isZeroHash,
  parseAmount,
  shorten,
  ZERO_BYTES32,
} from '@/lib/format'
import { useTx } from '@/lib/hooks'
import { storeDossier } from '@/lib/services'

/** Contract bounds (NeedsRegistry): at most 5 tranches, cost cap at most 20%. */
const MAX_TRANCHES = 5
const MAX_COST_BPS = 2000

const hashText = (text: string): Hex => (text.trim() ? keccak256(stringToHex(text)) : ZERO_BYTES32)

/** bytes32 from a short ASCII code, right-padded — the same encoding the contracts use for region codes. */
const toBytes32String = (value: string): Hex => stringToHex(value, { size: 32 })

/** "12.5" (percent) → 1250 bps; null when it is not a number in [min, max] percent. */
const percentToBps = (value: string, min: number, max: number): number | null => {
  const trimmed = value.trim().replace(',', '.')
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(trimmed)) return null
  const bps = Math.round(Number(trimmed) * 100)
  return bps >= min && bps <= max ? bps : null
}

export function CreateNeedPanel() {
  const t = useTranslations('ngo')
  const tCommon = useTranslations('common')
  const tErrors = useTranslations('errors')
  const tCustody = useTranslations('custody')
  const tx = useTx()

  const [programId, setProgramId] = useState('')
  const [category, setCategory] = useState<string>(CATEGORIES[0])
  const [target, setTarget] = useState('')
  const [region, setRegion] = useState('')
  const [metadataUri, setMetadataUri] = useState('')
  const [verifications, setVerifications] = useState('1')
  const [tranches, setTranches] = useState('30,40,30')
  const [dossierText, setDossierText] = useState('')
  const [dossierHash, setDossierHash] = useState('')
  const [custodyMode, setCustodyMode] = useState<CustodyMode>('OnChain')
  const [plan, setPlan] = useState<PlanRow[]>([emptyRow(3)])
  const [custodian, setCustodian] = useState('')
  const [fundingDate, setFundingDate] = useState('')
  const [executionDate, setExecutionDate] = useState('')
  const [minFunding, setMinFunding] = useState('100')
  const [costCap, setCostCap] = useState('0')
  const [costDisclosure, setCostDisclosure] = useState('')
  const [outcome, setOutcome] = useState('')
  const [serviceError, setServiceError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const parts = tranches
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  const sum = parts.reduce((total, part) => total + (Number(part) || 0), 0)

  // Percent in the form, basis points on chain; the last tranche absorbs the rounding drift.
  const trancheBps = parts.map((part) => Math.round(Number(part) * 100))
  const drift = 10_000 - trancheBps.reduce((total, value) => total + value, 0)
  if (drift !== 0 && trancheBps.length > 0)
    trancheBps[trancheBps.length - 1] = (trancheBps.at(-1) as number) + drift
  const onChain = custodyMode === 'OnChain'
  const planCheck = checkPlan(plan, trancheBps)

  const parsedTarget = parseAmount(target)
  const fundingDeadline = dateInputToUnix(fundingDate)
  const executionDeadline = dateInputToUnix(executionDate)
  const minFundingBps = percentToBps(minFunding, 1, 10_000)
  const costBps = percentToBps(costCap, 0, MAX_COST_BPS)
  const outcomeHash = hashText(outcome)
  const disclosureHash = costBps ? hashText(costDisclosure) : ZERO_BYTES32
  const today = new Date().toISOString().slice(0, 10)

  /** The plan always has one share per tranche: changing the tranche plan reshapes it, keeping what was typed. */
  const fitPlan = (rows: PlanRow[]): PlanRow[] =>
    rows.map((row) => ({
      ...row,
      shares: Array.from({ length: trancheBps.length }, (_, index) => row.shares[index] ?? ''),
    }))

  const store = async () => {
    setServiceError(null)
    const result = await storeDossier(dossierText)
    if (result.ok) setDossierHash(result.data.hash)
    else setServiceError(tErrors('serviceUnavailable', { detail: result.error }))
  }

  /** Mirrors NeedsRegistry._validateTerms so the NGO learns what is wrong before paying for a revert. */
  const validate = (): string | null => {
    const now = Math.floor(Date.now() / 1000)
    if (!/^\d+$/.test(programId) || !parsedTarget || !region.trim()) return tErrors('required')
    if (new TextEncoder().encode(region.trim()).length > 31) return t('errorRegion')
    if (!/^\d+$/.test(verifications) || Number(verifications) < 1 || Number(verifications) > 255) {
      return t('errorVerifications')
    }
    if (parts.length < 1 || parts.length > MAX_TRANCHES || parts.some((part) => !(Number(part) > 0))) {
      return tErrors('invalidTranches')
    }
    if (Math.round(sum * 100) !== 10_000) return tErrors('invalidTranches')
    if (!isBytes32(dossierHash) || isZeroHash(dossierHash)) return t('errorDossier')
    if (custodyMode === 'OffChain' && (!isAddress(custodian) || custodian === zeroAddress)) {
      return t('errorCustodian')
    }
    if (fundingDeadline === null || executionDeadline === null) return t('errorDate')
    // Money escrowed on-chain always has a delivery horizon, so donors always have a way back (expire).
    if (onChain && executionDeadline === 0) return t('errorExecutionRequired')
    if (fundingDeadline !== 0 && fundingDeadline <= now) return t('errorFundingDeadline')
    if (executionDeadline !== 0 && (executionDeadline <= now || executionDeadline <= fundingDeadline)) {
      return t('errorExecutionDeadline')
    }
    if (minFundingBps === null) return t('errorMinFunding')
    if (costBps === null) return t('errorCostCap', { max: bpsPercent(MAX_COST_BPS) })
    if (costBps > 0 && !costDisclosure.trim()) return t('errorDisclosure')
    if (!outcome.trim()) return t('errorOutcome')
    if (onChain && planCheck.problem) return t(planCheck.problem)
    return null
  }

  const submit = async () => {
    const problem = validate()
    if (problem) return setError(problem)
    setError(null)

    await tx.run({
      address: deployment?.contracts.NeedsRegistry as Address,
      abi: needsRegistryAbi,
      functionName: 'createNeed',
      args: [
        {
          programId: BigInt(programId),
          category: categoryHash(category),
          targetAmount: parsedTarget as bigint,
          regionCode: toBytes32String(region.trim()),
          dossierHash: dossierHash as Hex,
          metadataURI: metadataUri,
          verificationsRequired: Number(verifications),
          trancheBps,
          custodyMode: CUSTODY_MODE.indexOf(custodyMode),
          custodian: custodyMode === 'OffChain' ? (custodian as Address) : zeroAddress,
          fundingDeadline: BigInt(fundingDeadline ?? 0),
          executionDeadline: BigInt(executionDeadline ?? 0),
          minFundingBps: minFundingBps as number,
          thirdPartyCostBps: costBps as number,
          expectedOutcomeHash: outcomeHash,
          costDisclosureHash: disclosureHash,
          // Off-chain needs are paid by their custodian, so only on-chain needs carry a plan.
          payees: onChain ? (planCheck.payees ?? []) : [],
        },
      ],
    })
  }

  const unit = tCommon('amountUnit')
  const fundingText =
    fundingDeadline && fundingDeadline > 0
      ? t('summaryFundingDeadline', { date: fundingDate })
      : t('summaryNoFundingDeadline')
  const executionText =
    executionDeadline && executionDeadline > 0
      ? t('summaryExecutionDeadline', { date: executionDate })
      : t('summaryNoExecutionDeadline')

  return (
    <Panel title={t('needTitle')} description={t('needBody')}>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label={t('programId')} value={programId} onChange={setProgramId} inputMode="numeric" />
        <SelectField label={t('category')} value={category} onChange={setCategory} options={CATEGORIES} />
        <TextField
          label={t('targetAmount', { unit })}
          value={target}
          onChange={setTarget}
          inputMode="decimal"
        />
        <TextField label={t('region')} value={region} onChange={setRegion} placeholder="ES-CM" />
        <TextField
          label={t('metadataUri')}
          value={metadataUri}
          onChange={setMetadataUri}
          placeholder="ipfs://…"
        />
        <TextField
          label={t('verificationsRequired')}
          value={verifications}
          onChange={setVerifications}
          inputMode="numeric"
        />
      </div>

      <TextField
        label={t('tranchePlan')}
        value={tranches}
        onChange={setTranches}
        hint={t('tranchePlanHint', { sum })}
        inputMode="numeric"
      />

      <TextArea label={t('dossier')} value={dossierText} onChange={setDossierText} rows={3} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-secondary" onClick={store}>
          {t('dossierStore')}
        </button>
        <span className="mono">{dossierHash || ZERO_BYTES32}</span>
      </div>
      <TextField label={t('dossierHash')} value={dossierHash} onChange={setDossierHash} placeholder="0x…" />
      <FormError message={serviceError} />

      <fieldset className="space-y-3 rounded-md border border-slate-200 p-3">
        <legend className="px-1 text-sm font-semibold text-slate-900">{t('termsTitle')}</legend>

        <div>
          <p className="label">{t('custodyModel')}</p>
          <div className="mt-1 grid gap-2 sm:grid-cols-2">
            {CUSTODY_MODE.map((mode) => (
              <label
                key={mode}
                className={`flex cursor-pointer gap-2 rounded-md border p-3 text-sm ${
                  custodyMode === mode ? 'border-indigo-700 bg-indigo-50' : 'border-slate-300 bg-white'
                }`}
              >
                <input
                  type="radio"
                  name="custody-mode"
                  value={mode}
                  checked={custodyMode === mode}
                  onChange={() => setCustodyMode(mode)}
                />
                <span>
                  <span className="block font-semibold">{tCustody(mode)}</span>
                  <span className="block text-xs text-slate-700">{tCustody(`${mode}Body`)}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        {onChain ? (
          <PaymentPlanEditor
            rows={fitPlan(plan)}
            onChange={setPlan}
            trancheBps={trancheBps}
            check={planCheck}
          />
        ) : (
          <CustodianPicker value={custodian} onChange={setCustodian} />
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <DateField
            label={t('fundingDeadline')}
            value={fundingDate}
            onChange={setFundingDate}
            min={today}
            hint={t('deadlineHint')}
          />
          <DateField
            label={t('executionDeadline')}
            value={executionDate}
            onChange={setExecutionDate}
            min={fundingDate || today}
            hint={t('executionDeadlineHint')}
          />
          <TextField
            label={t('minFunding')}
            value={minFunding}
            onChange={setMinFunding}
            inputMode="decimal"
            hint={t('minFundingHint')}
          />
          <TextField
            label={t('costCap')}
            value={costCap}
            onChange={setCostCap}
            inputMode="decimal"
            hint={t('costCapHint', { max: bpsPercent(MAX_COST_BPS) })}
          />
        </div>

        {costBps ? (
          <div>
            <TextArea
              label={t('costDisclosure')}
              value={costDisclosure}
              onChange={setCostDisclosure}
              rows={3}
              hint={t('costDisclosureHint')}
            />
            <p className="hint">
              {t('hashLabel')}: <span className="mono">{disclosureHash}</span>
            </p>
          </div>
        ) : null}

        <div>
          <TextArea
            label={t('expectedOutcome')}
            value={outcome}
            onChange={setOutcome}
            rows={3}
            hint={t('expectedOutcomeHint')}
          />
          <p className="hint">
            {t('hashLabel')}: <span className="mono">{outcomeHash}</span>
          </p>
        </div>
      </fieldset>

      <section
        className="rounded-md border border-indigo-200 bg-indigo-50 p-3 text-sm text-slate-900"
        aria-live="polite"
      >
        <h3 className="font-semibold">{t('summaryTitle')}</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>
            {t('summaryTarget', {
              amount: parsedTarget ? target.trim() : '—',
              unit,
              category,
              region: region.trim() || '—',
              count: parts.length,
              plan: parts.map((part) => `${part}%`).join(' / '),
            })}
          </li>
          <li>
            {custodyMode === 'OnChain'
              ? t('summaryCustodyOnChain')
              : t('summaryCustodyOffChain', { custodian: custodian ? shorten(custodian) : '—' })}
          </li>
          <li>{fundingText}</li>
          <li>{executionText}</li>
          <li>
            {minFundingBps === null || minFundingBps >= 10_000
              ? t('summaryAllOrNothing')
              : t('summaryPartial', { percent: bpsPercent(minFundingBps) })}
          </li>
          <li>{costBps ? t('summaryCosts', { percent: bpsPercent(costBps) }) : t('summaryNoCosts')}</li>
          <li>{t('summaryOutcome', { hash: shorten(outcomeHash, 10, 6) })}</li>
        </ul>
      </section>

      <FormError message={error} />

      <button
        type="button"
        className="btn-primary"
        disabled={tx.phase === 'signing' || tx.phase === 'pending'}
        onClick={submit}
      >
        {t('createNeed')}
      </button>
      <TxStatus state={tx} />
    </Panel>
  )
}
