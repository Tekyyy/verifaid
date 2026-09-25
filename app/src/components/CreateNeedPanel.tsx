'use client'

import {
  beneficiaryRegistryAbi,
  CATEGORIES,
  categoryHash,
  certificationArgs,
  needsRegistryAbi,
  type SignedCertificate,
} from '@poa/shared'
import { useQuery } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { type Address, type Hex, keccak256, parseEventLogs, stringToHex, zeroAddress } from 'viem'
import { useReadContract } from 'wagmi'
import { Advanced, DateField, FormError, Panel, TextArea, TextField } from '@/components/form'
import { ImagePlaceholder } from '@/components/ImagePlaceholder'
import { Notice } from '@/components/Notice'
import {
  checkPlan,
  MAX_NGO_SHARE_BPS,
  NGO_PAYEE,
  NO_OWN_SHARE_CAP,
  PaymentPlanEditor,
  type PlanRow,
} from '@/components/PaymentPlanEditor'
import { ProgramPicker } from '@/components/ProgramPicker'
import { ReleasePolicyNote } from '@/components/ReleasePolicyNote'
import { TxStatus } from '@/components/TxStatus'
import { Link } from '@/i18n/navigation'
import { deployment, piiVaultUrl, vaultEnabled } from '@/lib/config'
import {
  bpsPercent,
  categoryIcon,
  dateInputToUnix,
  isBytes32,
  isZeroHash,
  parseAmount,
  shorten,
  ZERO_BYTES32,
} from '@/lib/format'
import { useTx } from '@/lib/hooks'
import { getSuppliers } from '@/lib/indexer'
import { builtInPolicies } from '@/lib/policies'
import { useVaultSession } from '@/lib/useVaultSession'
import { storeDossier } from '@/lib/vault'

/** Contract bounds (NeedsRegistry): at most 5 tranches, cost cap at most 20%. */
const MAX_TRANCHES = 5
/** Mirrors NeedsRegistry: a beneficiary's first tranche, paid before any evidence, is at most half the need. */
const MAX_BENEFICIARY_FIRST_TRANCHE_BPS = 5_000
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

/** The form, a step at a time: what is needed, by when, who is paid and who approves, then a last look. */
const WIZARD_STEPS = ['need', 'timeline', 'money', 'review'] as const

const inDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)

/**
 * Registering a need is the moment an NGO asks for money, so the form asks for what an NGO knows — what it needs,
 * how much, where, who it will pay — and derives the rest: the tranche plan, the verification threshold, the two
 * deadlines, the dossier hash. Everything derived is restated in plain words before signing, and every on-chain
 * value stays editable under "Advanced settings", because they are the terms donors are shown and cannot change.
 *
 * With a `certificate`, the same form is a certified beneficiary posting a need of their own: the programme is the
 * one their NGO certified them in, the tranches go to their own wallet (all of each one unless they choose to pay
 * a registered supplier directly), and the need goes through `BeneficiaryRegistry.createNeed`.
 */
export function CreateNeedPanel({ certificate }: { certificate?: SignedCertificate } = {}) {
  const t = useTranslations('ngo')
  const tCommon = useTranslations('common')
  const tErrors = useTranslations('errors')
  const tPolicy = useTranslations('policy')
  const tUi = useTranslations('ui')
  const tx = useTx()
  const optIn = useTx()
  const asBeneficiary = certificate !== undefined
  const [createdId, setCreatedId] = useState<string | null>(null)
  /** The step on screen, and the furthest one reached (steps up to it can be revisited from the stepper). */
  const [step, setStep] = useState(0)
  const [reached, setReached] = useState(0)

  // ── what the NGO (or the beneficiary) fills in ────────────────────────────
  const [programId, setProgramId] = useState(certificate?.certification.programId.toString() ?? '')
  const [category, setCategory] = useState<string>(CATEGORIES[0])
  const [target, setTarget] = useState('')
  const [region, setRegion] = useState('')
  const [outcome, setOutcome] = useState('')
  const [dossierText, setDossierText] = useState('')
  const [supplier, setSupplier] = useState('')
  const [keepPercent, setKeepPercent] = useState(asBeneficiary ? '100' : '0')
  const [timeline, setTimeline] = useState<Timeline>(DEFAULTS.timeline)
  /** Who approves each tranche after the first. Donors decide unless the NGO picks otherwise. */
  const policies = builtInPolicies()
  const [policyAddress, setPolicyAddress] = useState<string>(policies[0]?.address ?? '')
  const policy = policies.find((one) => one.address === policyAddress) ?? policies[0]

  /**
   * Whether this deployment approves a venue at all. With none, there is nothing to offer, so the option is
   * not shown rather than shown and broken.
   */
  const { data: venue } = useReadContract({
    address: deployment?.contracts.NeedsRegistry as Address | undefined,
    abi: needsRegistryAbi,
    functionName: 'yieldVenue',
    query: { enabled: Boolean(deployment?.contracts.NeedsRegistry) },
  })
  const venueApproved = Boolean(venue && venue !== zeroAddress)
  const [earnWhileWaiting, setEarnWhileWaiting] = useState(false)

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
   * The simple plan: one supplier does the work, and the NGO keeps a disclosed share of every tranche. For a
   * beneficiary it is the other way round: the tranches go to their own wallet, and a supplier is only added when
   * they choose to have part of each tranche paid to one directly. The advanced editor replaces it with any plan the
   * contract accepts (up to five payees, per-tranche shares).
   */
  // "12,5" is how half the world writes 12.5; the rest of the plan works in basis points to stay exact.
  const keptText = keepPercent.trim().replace(',', '.') || '0'
  const kept = Number(keptText)
  const supplierRow: PlanRow = {
    account: supplier,
    label: t('planSupplierLabel'),
    ref: '',
    shares: trancheBps.map(() => ((10_000 - Math.round(kept * 100)) / 100).toString()),
  }
  const ownRow: PlanRow = {
    account: NGO_PAYEE,
    label: asBeneficiary ? t('planOwnLabel') : t('planNgoLabel'),
    ref: '',
    shares: trancheBps.map(() => keptText),
  }
  const derivedPlan: PlanRow[] = [
    ...(!asBeneficiary || kept < 100 ? [supplierRow] : []),
    ...(kept > 0 ? [ownRow] : []),
  ]
  const plan = customPlan ?? derivedPlan
  const maxOwnShareBps = asBeneficiary ? NO_OWN_SHARE_CAP : MAX_NGO_SHARE_BPS
  const planCheck = checkPlan(plan, trancheBps, maxOwnShareBps)

  // Storing the assessment in the vault lets verifiers read it; it takes a wallet signature to sign in (no gas).
  const vault = useVaultSession()
  const store = async () => {
    setServiceError(null)
    if (!dossierText.trim()) return setServiceError(t('errorDossier'))
    const token = await vault.getToken()
    if (!token.ok) return setServiceError(tErrors('serviceUnavailable', { detail: token.error }))
    const result = await storeDossier({ baseUrl: piiVaultUrl }, token.data, dossierText)
    if (result.ok) setDossierHash(result.data.hash)
    else setServiceError(tErrors('serviceUnavailable', { detail: result.error }))
  }

  /**
   * Mirrors NeedsRegistry._validateTerms so the NGO learns what is wrong before paying for a revert. Each problem
   * names the step it belongs to, so "Continue" checks only what has been filled in so far and a failed submit
   * goes straight back to the step that needs fixing.
   */
  const problems = (): { step: number; message: string }[] => {
    const now = Math.floor(Date.now() / 1000)
    const found: { step: number; message: string }[] = []
    const add = (at: number, message: string) => found.push({ step: at, message })

    // 1 · the need
    if (!outcome.trim()) add(0, t('errorOutcome'))
    if (!parsedTarget || !region.trim()) add(0, tErrors('required'))
    else if (new TextEncoder().encode(region.trim()).length > 31) add(0, t('errorRegion'))
    if (!/^\d+$/.test(programId)) add(0, t('errorProgram'))

    // 2 · timeline
    if (fundingDeadline === null || executionDeadline === null) add(1, t('errorDate'))
    else {
      if (fundingDeadline !== 0 && fundingDeadline <= now) add(1, t('errorFundingDeadline'))
      // Money escrowed on-chain always has a delivery horizon, so donors always have a way back (expire).
      if (executionDeadline === 0) add(1, t('errorExecutionRequired'))
      else if (executionDeadline <= now || executionDeadline <= fundingDeadline) {
        add(1, t('errorExecutionDeadline'))
      }
    }

    // 3 · money and approval
    if (keepBps === null) add(2, t('planShare'))
    else if (!asBeneficiary && keepBps > MAX_NGO_SHARE_BPS) add(2, t('planNgoCap'))
    if (planCheck.problem) add(2, t(planCheck.problem))

    // 4 · review: the assessment and the advanced settings
    if (isZeroHash(dossier) || !isBytes32(dossier)) add(3, t('errorDossier'))
    if (
      parts.length < 1 ||
      parts.length > MAX_TRANCHES ||
      parts.some((part) => !(Number(part) > 0)) ||
      Math.round(sum * 100) !== 10_000
    ) {
      add(3, tErrors('invalidTranches'))
    } else if (
      asBeneficiary &&
      (trancheBps.length < 2 || (trancheBps[0] ?? 0) > MAX_BENEFICIARY_FIRST_TRANCHE_BPS)
    ) {
      add(3, t('errorBeneficiaryTranches', { max: bpsPercent(MAX_BENEFICIARY_FIRST_TRANCHE_BPS) }))
    }
    if (minFundingBps === null) add(3, t('errorMinFunding'))
    if (costBps === null) add(3, t('errorCostCap', { max: bpsPercent(MAX_COST_BPS) }))
    else if (costBps > 0 && !costDisclosure.trim()) add(3, t('errorDisclosure'))
    if (!/^\d+$/.test(verificationsRequired) || Number(verificationsRequired) < 1) {
      add(3, t('errorVerifications'))
    }
    return found
  }

  const goTo = (next: number) => {
    setError(null)
    setStep(next)
    setReached((previous) => Math.max(previous, next))
  }

  const advance = () => {
    const blocking = problems().find((problem) => problem.step <= step)
    if (blocking) {
      setError(blocking.message)
      if (blocking.step < step) setStep(blocking.step)
      return
    }
    goTo(step + 1)
  }

  const submit = async () => {
    const [first] = problems()
    if (first) {
      setError(first.message)
      setStep(first.step)
      return
    }
    setError(null)

    const params = {
      programId: BigInt(programId),
      category: categoryHash(category),
      targetAmount: parsedTarget as bigint,
      regionCode: toBytes32String(region.trim()),
      dossierHash: dossier as Hex,
      metadataURI: metadataUri,
      verificationsRequired: Number(verificationsRequired),
      trancheBps,
      fundingDeadline: BigInt(fundingDeadline ?? 0),
      executionDeadline: BigInt(executionDeadline ?? 0),
      minFundingBps: minFundingBps as number,
      thirdPartyCostBps: costBps as number,
      expectedOutcomeHash: outcomeHash,
      costDisclosureHash: disclosureHash,
      payees: planCheck.payees ?? [],
      // Zero asks for the platform default, which a deployment without the built-ins still has.
      releasePolicy: (policy?.address ?? zeroAddress) as Address,
    }
    const created = certificate
      ? await tx.run({
          address: deployment?.contracts.BeneficiaryRegistry as Address,
          abi: beneficiaryRegistryAbi,
          functionName: 'createNeed',
          args: [params, certificationArgs(certificate.certification), certificate.signature],
        })
      : await tx.run({
          address: deployment?.contracts.NeedsRegistry as Address,
          abi: needsRegistryAbi,
          functionName: 'createNeed',
          args: [params],
        })
    if (!created) return
    const [event] = parseEventLogs({ abi: needsRegistryAbi, eventName: 'NeedCreated', logs: created.logs })
    if (event) setCreatedId(event.args.needId.toString())

    // A second signature, and deliberately not bundled into the first: opting in only works while the need is
    // Pending, which is exactly the window where a donor can still be told about it before giving.
    if (event && earnWhileWaiting) {
      await optIn.run({
        address: deployment?.contracts.NeedsRegistry as Address,
        abi: needsRegistryAbi,
        functionName: 'enableYield',
        args: [event.args.needId],
      })
    }
  }

  const unit = tCommon('amountUnit')
  const last = step === WIZARD_STEPS.length - 1
  const busy = tx.phase === 'signing' || tx.phase === 'pending'

  return (
    <Panel
      title={asBeneficiary ? t('beneficiaryNeedTitle') : t('needTitle')}
      description={asBeneficiary ? t('beneficiaryNeedBody') : t('needBody')}
    >
      {/* ── where the form is ──────────────────────────────────────────────── */}
      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {WIZARD_STEPS.map((key, index) => {
          const current = index === step
          const done = index < step
          return (
            <li key={key}>
              <button
                type="button"
                disabled={index > reached}
                onClick={() => goTo(index)}
                aria-current={current ? 'step' : undefined}
                className={`flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed ${
                  current
                    ? 'border-teal-700 bg-teal-50'
                    : done
                      ? 'border-teal-200 bg-white hover:bg-teal-50'
                      : 'border-slate-200 bg-white text-slate-500'
                }`}
              >
                <span
                  className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                    current || done ? 'bg-teal-700 text-white' : 'bg-slate-200 text-slate-600'
                  }`}
                  aria-hidden="true"
                >
                  {done ? '✓' : index + 1}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-slate-900">{t(`step.${key}`)}</span>
                  <span className="hidden text-xs text-slate-600 sm:block">{t(`step.${key}Hint`)}</span>
                </span>
              </button>
            </li>
          )
        })}
      </ol>

      {/* ── 1 · the need ───────────────────────────────────────────────────── */}
      <div hidden={step !== 0} className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2">
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
          </div>
          <fieldset>
            <legend className="label">{t('category')}</legend>
            <div className="mt-1 flex flex-wrap gap-2">
              {CATEGORIES.map((option) => (
                <label
                  key={option}
                  className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium ${
                    category === option
                      ? 'border-teal-700 bg-teal-50 text-teal-900'
                      : 'border-slate-300 bg-white text-slate-700 hover:border-teal-300'
                  }`}
                >
                  <input
                    type="radio"
                    name="need-category"
                    value={option}
                    checked={category === option}
                    onChange={() => setCategory(option)}
                    className="sr-only"
                  />
                  <span aria-hidden="true">{categoryIcon(option)}</span>
                  {option}
                </label>
              ))}
            </div>
          </fieldset>
          {asBeneficiary ? (
            <div>
              <p className="label">{t('programLabel')}</p>
              <p className="mt-1 text-sm text-slate-800">{t('beneficiaryProgram', { id: programId })}</p>
            </div>
          ) : (
            <ProgramPicker value={programId} onChange={setProgramId} />
          )}
        </div>
        <aside className="space-y-2">
          <ImagePlaceholder
            label={tUi('coverPhoto')}
            hint={tUi('coverPhotoHint')}
            className="aspect-[5/2] w-full lg:aspect-[4/3]"
          />
          <p className="text-xs text-slate-600">{t('coverLater')}</p>
        </aside>
      </div>

      {/* ── 2 · timeline ───────────────────────────────────────────────────── */}
      <div hidden={step !== 1} className="space-y-3">
        <p className="label">{t('timelineLabel')}</p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {([...Object.keys(TIMELINES), 'custom'] as Timeline[]).map((key) => (
            <label
              key={key}
              className={`flex cursor-pointer gap-2 rounded-lg border p-3 text-sm ${
                timeline === key
                  ? 'border-teal-700 bg-teal-50'
                  : 'border-slate-300 bg-white hover:border-teal-300'
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
          </div>
        ) : null}
      </div>

      {/* ── 3 · money and approval ─────────────────────────────────────────── */}
      <div hidden={step !== 2} className="space-y-4">
        {!customPlan ? (
          <fieldset className="space-y-3 rounded-lg border border-slate-200 p-3">
            <legend className="px-1 text-sm font-semibold text-slate-900">{t('planTitle')}</legend>
            <p className="text-xs text-slate-700">
              {asBeneficiary ? t('planOwnSimpleBody') : t('planSimpleBody')}
            </p>
            {asBeneficiary ? (
              <TextField
                label={t('planOwnKeep')}
                value={keepPercent}
                onChange={setKeepPercent}
                inputMode="decimal"
                hint={t('planOwnKeepHint')}
              />
            ) : null}
            {!asBeneficiary || kept < 100 ? (
              <SupplierPicker
                suppliers={activeSuppliers.map((one) => one.address)}
                value={supplier}
                onChange={setSupplier}
                loading={suppliers.isLoading}
              />
            ) : null}
            {asBeneficiary ? null : (
              <TextField
                label={t('planKeep')}
                value={keepPercent}
                onChange={setKeepPercent}
                inputMode="decimal"
                hint={t('planKeepHint', { max: bpsPercent(MAX_NGO_SHARE_BPS) })}
              />
            )}
            <button
              type="button"
              className="text-xs text-slate-600 underline"
              onClick={() => setCustomPlan(derivedPlan)}
            >
              {t('planCustomise')}
            </button>
          </fieldset>
        ) : (
          <>
            <PaymentPlanEditor
              rows={customPlan.map((row) => ({
                ...row,
                shares: Array.from({ length: trancheBps.length }, (_, index) => row.shares[index] ?? ''),
              }))}
              onChange={setCustomPlan}
              trancheBps={trancheBps}
              check={planCheck}
              asBeneficiary={asBeneficiary}
            />
            <button
              type="button"
              className="text-xs text-slate-600 underline"
              onClick={() => setCustomPlan(null)}
            >
              {t('planSimplify')}
            </button>
          </>
        )}

        {policies.length > 0 ? (
          <fieldset className="space-y-2 rounded-lg border border-slate-200 p-3">
            <legend className="px-1 text-sm font-semibold text-slate-900">{t('policyLabel')}</legend>
            <p className="text-xs text-slate-700">{t('policyHint')}</p>
            <div className="grid gap-2 sm:grid-cols-3">
              {policies.map((option) => (
                <label
                  key={option.address}
                  className={`flex cursor-pointer gap-2 rounded-lg border p-3 text-sm ${
                    policyAddress === option.address
                      ? 'border-teal-700 bg-teal-50'
                      : 'border-slate-300 bg-white hover:border-teal-300'
                  }`}
                >
                  <input
                    type="radio"
                    name="release-policy"
                    value={option.address}
                    checked={policyAddress === option.address}
                    onChange={() => setPolicyAddress(option.address)}
                  />
                  <span className="font-semibold">{tPolicy(`name.${option.kind}`)}</span>
                </label>
              ))}
            </div>
            {policy ? (
              <ReleasePolicyNote
                policy={policy}
                verifiers={Number(verificationsRequired) || 1}
                compact
                ownerIsBeneficiary={asBeneficiary}
              />
            ) : null}
          </fieldset>
        ) : null}
      </div>

      {/* ── 4 · review ─────────────────────────────────────────────────────── */}
      <div hidden={step !== 3} className="space-y-4">
        <TextArea
          label={t('dossier')}
          value={dossierText}
          onChange={setDossierText}
          rows={3}
          hint={t('dossierSimpleHint')}
        />

        {/* what donors will be shown, in plain words */}
        <section
          className="rounded-lg border border-teal-200 bg-teal-50 p-4 text-sm text-slate-900"
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
              {asBeneficiary
                ? t('summaryPlanOwn', {
                    own: customPlan ? bpsPercent(planCheck.ngoShareBps) : bpsPercent(keepBps ?? 0),
                    payee: supplier && !customPlan ? shorten(supplier) : t('summaryPlanCustom'),
                    paysSupplier: String(customPlan ? planCheck.ngoShareBps < 10_000 : kept < 100),
                  })
                : t('summaryPlan', {
                    payee: supplier && !customPlan ? shorten(supplier) : t('summaryPlanCustom'),
                    ngo: customPlan ? bpsPercent(planCheck.ngoShareBps) : bpsPercent(keepBps ?? 0),
                  })}
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
            {policy ? <li>{t('summaryPolicy', { name: tPolicy(`name.${policy.kind}`) })}</li> : null}
            <li>{costBps ? t('summaryCosts', { percent: bpsPercent(costBps) }) : t('summaryNoCosts')}</li>
            <li>{t('summaryOutcome', { hash: shorten(outcomeHash, 10, 6) })}</li>
          </ul>
        </section>

        {/* everything an NGO should not have to decide */}
        <Advanced title={t('advancedTitle')} hint={t('advancedHint')}>
          {venueApproved ? (
            <label className="flex items-start gap-2 rounded-md border border-slate-200 p-3 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={earnWhileWaiting}
                onChange={(event) => setEarnWhileWaiting(event.target.checked)}
              />
              <span>
                <span className="font-medium">{t('idleTitle')}</span>
                <span className="mt-0.5 block text-xs text-slate-600">{t('idleHint')}</span>
              </span>
            </label>
          ) : null}

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
            {vaultEnabled ? (
              <button type="button" className="btn-secondary mt-2 text-xs" onClick={store}>
                {t('dossierStore')}
              </button>
            ) : null}
            <FormError message={serviceError} />
          </div>
        </Advanced>
      </div>

      <FormError message={error} />

      {/* ── back, continue, create ─────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
        <p className="text-xs text-slate-600">
          {t('stepCounter', { current: step + 1, total: WIZARD_STEPS.length })}
        </p>
        <div className="flex flex-wrap gap-2">
          {step > 0 ? (
            <button type="button" className="btn-secondary" onClick={() => goTo(step - 1)}>
              ← {t('stepBack')}
            </button>
          ) : null}
          {last ? (
            <button type="button" className="btn-primary" disabled={busy} onClick={submit}>
              {asBeneficiary ? t('beneficiaryCreateNeed') : t('createNeed')}
            </button>
          ) : (
            <button type="button" className="btn-primary" onClick={advance}>
              {t('stepNext')} →
            </button>
          )}
        </div>
      </div>
      <TxStatus state={tx} />
      <TxStatus state={optIn} />
      {createdId ? (
        <Notice tone="success" title={t('createdNeed', { id: createdId })}>
          <Link href={asBeneficiary ? `/beneficiary?need=${createdId}` : `/ngo/manage?need=${createdId}`}>
            {t('createdNeedManage')}
          </Link>
        </Notice>
      ) : null}
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
