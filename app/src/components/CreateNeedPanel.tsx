'use client'

import { CATEGORIES, CUSTODY_MODE, type CustodyMode, categoryHash, needsRegistryAbi } from '@poa/shared'
import { useQuery } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { type Address, type Hex, isAddress, keccak256, stringToHex, zeroAddress } from 'viem'
import { CustodianPicker } from '@/components/CustodianPicker'
import { Advanced, DateField, FormError, Panel, SelectField, TextArea, TextField } from '@/components/form'
import {
  checkPlan,
  MAX_NGO_SHARE_BPS,
  NGO_PAYEE,
  PaymentPlanEditor,
  type PlanRow,
} from '@/components/PaymentPlanEditor'
import { ProgramPicker } from '@/components/ProgramPicker'
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
import { getSuppliers } from '@/lib/indexer'
import { storeDossier } from '@/lib/services'

/** Contract bounds (NeedsRegistry): at most 5 tranches, cost cap at most 20%. */
const MAX_TRANCHES = 5
const MAX_COST_BPS = 2000

/**
 * How long the need has to raise the money, and then to deliver it. An NGO picks one of these instead of two
 * dates; the exact deadlines are in the advanced section and in the summary before signing.
 */
const TIMELINES = {
  fast: { funding: 14, delivery: 45 },
  standard: { funding: 30, delivery: 90 },
  long: { funding: 60, delivery: 180 },
} as const
type Timeline = keyof typeof TIMELINES | 'custom'

const DEFAULTS = {
  tranches: '30,40,30',
  minFunding: '100',
  costCap: '0',
  timeline: 'standard' as Timeline,
}

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

const inDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)

/**
 * Registering a need is the moment an NGO asks for money, so the form asks for what an NGO knows — what it needs,
 * how much, where, who it will pay — and derives the rest: the tranche plan, the verification threshold, the two
 * deadlines, the dossier hash. Everything derived is restated in plain words before signing, and every on-chain
 * value stays editable under "Advanced settings", because they are the terms donors are shown and cannot change.
 */
export function CreateNeedPanel() {
  const t = useTranslations('ngo')
  const tCommon = useTranslations('common')
  const tErrors = useTranslations('errors')
  const tCustody = useTranslations('custody')
  const tx = useTx()

  // ── what the NGO fills in ──────────────────────────────────────────────────
  const [programId, setProgramId] = useState('')
  const [category, setCategory] = useState<string>(CATEGORIES[0])
  const [target, setTarget] = useState('')
  const [region, setRegion] = useState('')
  const [outcome, setOutcome] = useState('')
  const [dossierText, setDossierText] = useState('')
  const [supplier, setSupplier] = useState('')
  const [keepPercent, setKeepPercent] = useState('0')
  const [timeline, setTimeline] = useState<Timeline>(DEFAULTS.timeline)

  // ── advanced: empty means "use the value derived above" ────────────────────
  const [tranches, setTranches] = useState(DEFAULTS.tranches)
  const [minFunding, setMinFunding] = useState(DEFAULTS.minFunding)
  const [costCap, setCostCap] = useState(DEFAULTS.costCap)
  const [costDisclosure, setCostDisclosure] = useState('')
  const [metadataUri, setMetadataUri] = useState('')
  const [verifications, setVerifications] = useState('')
  const [fundingDate, setFundingDate] = useState('')
  const [executionDate, setExecutionDate] = useState('')
  const [dossierHash, setDossierHash] = useState('')
  const [custodyMode, setCustodyMode] = useState<CustodyMode>('OnChain')
  const [custodian, setCustodian] = useState('')
  const [customPlan, setCustomPlan] = useState<PlanRow[] | null>(null)

  const [serviceError, setServiceError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const suppliers = useQuery({ queryKey: ['suppliers'], queryFn: getSuppliers })
  const activeSuppliers = suppliers.data?.ok ? suppliers.data.data.filter((one) => one.active) : []

  const parts = tranches
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  const sum = parts.reduce((total, part) => total + (Number(part) || 0), 0)
  const trancheBps = parts.map((part) => Math.round(Number(part) * 100))
  const drift = 10_000 - trancheBps.reduce((total, value) => total + value, 0)
  if (drift !== 0 && trancheBps.length > 0)
    trancheBps[trancheBps.length - 1] = (trancheBps.at(-1) as number) + drift

  const onChain = custodyMode === 'OnChain'
  const parsedTarget = parseAmount(target)
  const minFundingBps = percentToBps(minFunding, 1, 10_000)
  const costBps = percentToBps(costCap, 0, MAX_COST_BPS)
  const keepBps = percentToBps(keepPercent, 0, 10_000)
  const outcomeHash = hashText(outcome)
  const disclosureHash = costBps ? hashText(costDisclosure) : ZERO_BYTES32
  const today = new Date().toISOString().slice(0, 10)

  // ── derived, and overridable in the advanced section ───────────────────────
  const custom = timeline === 'custom'
  const fundingDay = custom ? fundingDate : inDays(TIMELINES[timeline].funding)
  const executionDay = custom ? executionDate : inDays(TIMELINES[timeline].delivery)
  const fundingDeadline = dateInputToUnix(fundingDay)
  const executionDeadline = dateInputToUnix(executionDay)
  /** Above the high-value threshold the contract demands two independent verifications, so ask for them. */
  const highValue = parsedTarget !== null && parsedTarget > BigInt(deployment?.params.highValueThreshold ?? 0)
  const verificationsRequired = verifications.trim() || (highValue ? '2' : '1')
  const dossier = dossierHash || hashText(dossierText)

  /**
   * The simple plan: one supplier does the work, and the NGO keeps a disclosed share of every tranche. The
   * advanced editor replaces it with any plan the contract accepts (up to five payees, per-tranche shares).
   */
  const derivedPlan: PlanRow[] = [
    {
      account: supplier,
      label: t('planSupplierLabel'),
      ref: '',
      shares: trancheBps.map(() => (100 - Number(keepPercent || '0')).toString()),
    },
    ...(Number(keepPercent || '0') > 0
      ? [
          {
            account: NGO_PAYEE,
            label: t('planNgoLabel'),
            ref: '',
            shares: trancheBps.map(() => keepPercent.trim()),
          },
        ]
      : []),
  ]
  const plan = customPlan ?? derivedPlan
  const planCheck = checkPlan(plan, trancheBps)

  const store = async () => {
    setServiceError(null)
    const result = await storeDossier(dossierText)
    if (result.ok) setDossierHash(result.data.hash)
    else setServiceError(tErrors('serviceUnavailable', { detail: result.error }))
  }

  /** Mirrors NeedsRegistry._validateTerms so the NGO learns what is wrong before paying for a revert. */
  const validate = (): string | null => {
    const now = Math.floor(Date.now() / 1000)
    if (!/^\d+$/.test(programId)) return t('errorProgram')
    if (!parsedTarget || !region.trim()) return tErrors('required')
    if (new TextEncoder().encode(region.trim()).length > 31) return t('errorRegion')
    if (!outcome.trim()) return t('errorOutcome')
    if (isZeroHash(dossier)) return t('errorDossier')
    if (!isBytes32(dossier)) return t('errorDossier')
    if (parts.length < 1 || parts.length > MAX_TRANCHES || parts.some((part) => !(Number(part) > 0))) {
      return tErrors('invalidTranches')
    }
    if (Math.round(sum * 100) !== 10_000) return tErrors('invalidTranches')
    if (custodyMode === 'OffChain' && (!isAddress(custodian) || custodian === zeroAddress)) {
      return t('errorCustodian')
    }
    if (fundingDeadline === null || executionDeadline === null) return t('errorDate')
    if (fundingDeadline !== 0 && fundingDeadline <= now) return t('errorFundingDeadline')
    // Money escrowed on-chain always has a delivery horizon, so donors always have a way back (expire).
    if (onChain && executionDeadline === 0) return t('errorExecutionRequired')
    if (executionDeadline !== 0 && (executionDeadline <= now || executionDeadline <= fundingDeadline)) {
      return t('errorExecutionDeadline')
    }
    if (minFundingBps === null) return t('errorMinFunding')
    if (costBps === null) return t('errorCostCap', { max: bpsPercent(MAX_COST_BPS) })
    if (costBps > 0 && !costDisclosure.trim()) return t('errorDisclosure')
    if (!/^\d+$/.test(verificationsRequired) || Number(verificationsRequired) < 1) {
      return t('errorVerifications')
    }
    if (onChain && keepBps !== null && keepBps > MAX_NGO_SHARE_BPS) return t('planNgoCap')
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
          dossierHash: dossier as Hex,
          metadataURI: metadataUri,
          verificationsRequired: Number(verificationsRequired),
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

  return (
    <Panel title={t('needTitle')} description={t('needBody')}>
      {/* ── what the NGO is asking for ─────────────────────────────────────── */}
      <TextField
        label={t('outcomeSimple')}
        value={outcome}
        onChange={setOutcome}
        placeholder={t('outcomePlaceholder')}
        hint={t('outcomeSimpleHint')}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label={t('targetAmount', { unit })}
          value={target}
          onChange={setTarget}
          inputMode="decimal"
        />
        <TextField label={t('region')} value={region} onChange={setRegion} placeholder="ES-CM" />
        <SelectField label={t('category')} value={category} onChange={setCategory} options={CATEGORIES} />
        <ProgramPicker value={programId} onChange={setProgramId} />
      </div>

      <div>
        <p className="label">{t('timelineLabel')}</p>
        <div className="mt-1 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {([...Object.keys(TIMELINES), 'custom'] as Timeline[]).map((key) => (
            <label
              key={key}
              className={`flex cursor-pointer gap-2 rounded-md border p-3 text-sm ${
                timeline === key ? 'border-indigo-700 bg-indigo-50' : 'border-slate-300 bg-white'
              }`}
            >
              <input
                type="radio"
                name="timeline"
                value={key}
                checked={timeline === key}
                onChange={() => {
                  setTimeline(key)
                  if (key !== 'custom') {
                    setFundingDate('')
                    setExecutionDate('')
                  }
                }}
              />
              <span>
                <span className="block font-semibold">{t(`timeline_${key}`)}</span>
                <span className="block text-xs text-slate-700">
                  {key === 'custom'
                    ? t('timelineCustomHint')
                    : t('timelineDates', {
                        funding: inDays(TIMELINES[key].funding),
                        delivery: inDays(TIMELINES[key].delivery),
                      })}
                </span>
              </span>
            </label>
          ))}
        </div>
        {custom ? (
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
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
          </div>
        ) : null}
      </div>

      {/* ── who gets paid ──────────────────────────────────────────────────── */}
      {onChain && !customPlan ? (
        <fieldset className="space-y-3 rounded-md border border-slate-200 p-3">
          <legend className="px-1 text-sm font-semibold text-slate-900">{t('planTitle')}</legend>
          <p className="text-xs text-slate-700">{t('planSimpleBody')}</p>
          <SupplierPicker
            suppliers={activeSuppliers.map((one) => one.address)}
            value={supplier}
            onChange={setSupplier}
            loading={suppliers.isLoading}
          />
          <TextField
            label={t('planKeep')}
            value={keepPercent}
            onChange={setKeepPercent}
            inputMode="decimal"
            hint={t('planKeepHint', { max: bpsPercent(MAX_NGO_SHARE_BPS) })}
          />
          <button
            type="button"
            className="text-xs text-slate-600 underline"
            onClick={() => setCustomPlan(derivedPlan)}
          >
            {t('planCustomise')}
          </button>
        </fieldset>
      ) : null}

      {onChain && customPlan ? (
        <>
          <PaymentPlanEditor
            rows={customPlan.map((row) => ({
              ...row,
              shares: Array.from({ length: trancheBps.length }, (_, index) => row.shares[index] ?? ''),
            }))}
            onChange={setCustomPlan}
            trancheBps={trancheBps}
            check={planCheck}
          />
          <button
            type="button"
            className="text-xs text-slate-600 underline"
            onClick={() => setCustomPlan(null)}
          >
            {t('planSimplify')}
          </button>
        </>
      ) : null}

      {/* ── the assessment a verifier will check ───────────────────────────── */}
      <TextArea
        label={t('dossier')}
        value={dossierText}
        onChange={setDossierText}
        rows={3}
        hint={t('dossierSimpleHint')}
      />

      {/* ── everything an NGO should not have to decide ────────────────────── */}
      <Advanced title={t('advancedTitle')} hint={t('advancedHint')}>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label={t('tranchePlan')}
            value={tranches}
            onChange={setTranches}
            hint={t('tranchePlanHint', { sum })}
            inputMode="numeric"
          />
          <TextField
            label={t('minFunding')}
            value={minFunding}
            onChange={setMinFunding}
            inputMode="decimal"
            hint={t('minFundingHint')}
          />
          <TextField
            label={t('verificationsRequired')}
            value={verificationsRequired}
            onChange={setVerifications}
            inputMode="numeric"
            hint={highValue ? t('verificationsHighValue') : t('verificationsHint')}
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
          <TextArea
            label={t('costDisclosure')}
            value={costDisclosure}
            onChange={setCostDisclosure}
            rows={3}
            hint={t('costDisclosureHint')}
          />
        ) : null}

        <TextField
          label={t('metadataUri')}
          value={metadataUri}
          onChange={setMetadataUri}
          placeholder="ipfs://…"
        />

        <div>
          <TextField
            label={t('dossierHash')}
            value={dossier}
            onChange={setDossierHash}
            placeholder="0x…"
            hint={t('dossierHashHint')}
          />
          <button type="button" className="btn-secondary mt-2 text-xs" onClick={store}>
            {t('dossierStore')}
          </button>
          <FormError message={serviceError} />
        </div>

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

        {!onChain ? <CustodianPicker value={custodian} onChange={setCustodian} /> : null}
      </Advanced>

      {/* ── what donors will be shown, in plain words ──────────────────────── */}
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
              ? t('summaryPlan', {
                  payee: supplier && !customPlan ? shorten(supplier) : t('summaryPlanCustom'),
                  ngo: bpsPercent(keepBps ?? 0),
                })
              : t('summaryCustodyOffChain', { custodian: custodian ? shorten(custodian) : '—' })}
          </li>
          <li>
            {fundingDay ? t('summaryFundingDeadline', { date: fundingDay }) : t('summaryNoFundingDeadline')}
          </li>
          <li>
            {executionDay
              ? t('summaryExecutionDeadline', { date: executionDay })
              : t('summaryNoExecutionDeadline')}
          </li>
          <li>
            {minFundingBps === null || minFundingBps >= 10_000
              ? t('summaryAllOrNothing')
              : t('summaryPartial', { percent: bpsPercent(minFundingBps) })}
          </li>
          <li>{t('summaryVerifications', { count: verificationsRequired })}</li>
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

/** Only addresses the admin registered as suppliers can be paid, so the list is the registry's, not free text. */
function SupplierPicker({
  suppliers,
  value,
  onChange,
  loading,
}: {
  suppliers: string[]
  value: string
  onChange: (value: string) => void
  loading: boolean
}) {
  const t = useTranslations('ngo')

  return (
    <div>
      <p className="label">{t('planAccount')}</p>
      <select
        className="input font-mono"
        value={suppliers.includes(value) ? value : ''}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{loading ? t('custodianLoading') : t('planPick')}</option>
        {suppliers.map((address) => (
          <option key={address} value={address}>
            {address}
          </option>
        ))}
      </select>
      {suppliers.length === 0 && !loading ? <p className="hint">{t('planNoSuppliers')}</p> : null}
      <TextField label={t('planAccountManual')} value={value} onChange={onChange} placeholder="0x…" />
    </div>
  )
}
