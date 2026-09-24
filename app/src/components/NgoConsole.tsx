'use client'

import { aidVaultAbi, easAbi, needsRegistryAbi, programRegistryAbi, roleRegistryAbi } from '@poa/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { type Address, type Hex, keccak256, parseEventLogs, toHex } from 'viem'
import { useAccount, useReadContract } from 'wagmi'
import { CertifyBeneficiaryPanel, RevokeCertificationPanel } from '@/components/CertifyBeneficiaryPanel'
import { CreateNeedPanel } from '@/components/CreateNeedPanel'
import { ExplorerLink } from '@/components/ExplorerLink'
import { Advanced, FormError, Panel, TextArea, TextField } from '@/components/form'
import { ImagePlaceholder } from '@/components/ImagePlaceholder'
import { NgoCampaignDashboard } from '@/components/NgoCampaignDashboard'
import { MissingDeployment } from '@/components/Notice'
import { type TabSpec, Tabs, useTabParam } from '@/components/Tabs'
import { TaxStatusPanel } from '@/components/TaxStatusPanel'
import { TxStatus } from '@/components/TxStatus'
import { Link } from '@/i18n/navigation'
import { deployment } from '@/lib/config'
import { attestationRequest, schemaRecipient } from '@/lib/eas'
import { amount, bpsPercent, isBytes32, isZeroHash, timestamp, ZERO_BYTES32 } from '@/lib/format'
import { useLedger, useMounted, useTx } from '@/lib/hooks'
import { getPrograms } from '@/lib/indexer'
import { programPolicyLabel, rememberProgramPolicy } from '@/lib/programNames'

const TAB_KEYS = ['overview', 'newNeed', 'beneficiaries', 'programmes', 'organisation'] as const
type ConsoleTab = (typeof TAB_KEYS)[number]

/**
 * The NGO console, one job per tab: an overview of its campaigns, registering a need, certifying beneficiaries,
 * its programmes, and its organisation's standing. Everything done to one need in particular — evidence, releases,
 * photos, reports — lives in that need's own dashboard (Need management), already pointed at it.
 */
export function NgoConsole() {
  if (!deployment) return <MissingDeployment />
  return <ConsoleTabs />
}

function ConsoleTabs() {
  const t = useTranslations('ngo')
  const [tab, setTab] = useTabParam(TAB_KEYS, 'overview')
  const beneficiariesEnabled = Boolean(deployment?.contracts.BeneficiaryRegistry)

  const tabs: TabSpec<ConsoleTab>[] = [
    { key: 'overview', label: t('tabOverview'), content: <Overview onGo={setTab} /> },
    { key: 'newNeed', label: t('tabNewNeed'), content: <CreateNeedPanel /> },
    ...(beneficiariesEnabled
      ? [
          {
            key: 'beneficiaries' as const,
            label: t('tabBeneficiaries'),
            content: (
              <>
                <CertifyBeneficiaryPanel />
                <RevokeCertificationPanel />
              </>
            ),
          },
        ]
      : []),
    {
      key: 'programmes',
      label: t('tabProgrammes'),
      content: (
        <>
          <ProgramList />
          <CreateProgram />
        </>
      ),
    },
    { key: 'organisation', label: t('tabOrganisation'), content: <TaxStatusPanel /> },
  ]

  return (
    <div className="space-y-6">
      <ConsoleHeader onNewNeed={() => setTab('newNeed')} />
      <Tabs tabs={tabs} active={tab} onSelect={setTab} label={t('tabsLabel')} />
    </div>
  )
}

/** Who is signed in, whether the platform knows it as an NGO, and the two things an NGO comes here to do. */
function ConsoleHeader({ onNewNeed }: { onNewNeed: () => void }) {
  const t = useTranslations('ngo')
  const tUi = useTranslations('ui')
  const mounted = useMounted()
  const { address } = useAccount()
  const { data: active } = useReadContract({
    address: deployment?.contracts.RoleRegistry as Address | undefined,
    abi: roleRegistryAbi,
    functionName: 'isActiveNgo',
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address && deployment) },
  })

  return (
    <section className="card flex flex-col gap-4 sm:flex-row sm:items-center">
      <ImagePlaceholder shape="circle" label={tUi('ngoLogo')} className="h-16 w-16 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="eyebrow">{t('consoleEyebrow')}</p>
        <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
        {mounted && address ? (
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-700">
            <ExplorerLink kind="address" value={address} />
            {active === true ? (
              <span className="chip bg-emerald-100 text-emerald-900">{t('activeNgo')}</span>
            ) : active === false ? (
              <span className="chip bg-amber-100 text-amber-900">{t('notRegisteredNgo')}</span>
            ) : null}
          </p>
        ) : (
          <p className="mt-1 text-sm text-slate-700">{t('subtitle')}</p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-primary" onClick={onNewNeed}>
          + {t('quickNewNeed')}
        </button>
        <Link href="/ngo/manage" className="btn-secondary no-underline">
          {t('manageButton')}
        </Link>
      </div>
    </section>
  )
}

/** The shortcuts, then every campaign still raising or delivering. */
function Overview({ onGo }: { onGo: (tab: ConsoleTab) => void }) {
  const t = useTranslations('ngo')
  const beneficiariesEnabled = Boolean(deployment?.contracts.BeneficiaryRegistry)
  const tiles: { icon: string; title: string; body: string; go: ConsoleTab | 'manage' }[] = [
    { icon: '📝', title: t('quick.newNeed'), body: t('quick.newNeedBody'), go: 'newNeed' },
    { icon: '📊', title: t('quick.manage'), body: t('quick.manageBody'), go: 'manage' },
    ...(beneficiariesEnabled
      ? [
          {
            icon: '🤝',
            title: t('quick.certify'),
            body: t('quick.certifyBody'),
            go: 'beneficiaries' as const,
          },
        ]
      : []),
    { icon: '🗂️', title: t('quick.programmes'), body: t('quick.programmesBody'), go: 'programmes' },
  ]
  const tileClass =
    'card flex h-full gap-3 text-left no-underline transition-shadow hover:border-teal-300 hover:shadow-md'
  const inner = (tile: (typeof tiles)[number]) => (
    <>
      <span className="text-2xl" aria-hidden="true">
        {tile.icon}
      </span>
      <span>
        <span className="block font-semibold text-slate-900">{tile.title}</span>
        <span className="mt-0.5 block text-sm text-slate-600">{tile.body}</span>
      </span>
    </>
  )

  return (
    <>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((tile) => (
          <li key={tile.go}>
            {tile.go === 'manage' ? (
              <Link href="/ngo/manage" className={tileClass}>
                {inner(tile)}
              </Link>
            ) : (
              <button
                type="button"
                className={`${tileClass} w-full`}
                onClick={() => onGo(tile.go as ConsoleTab)}
              >
                {inner(tile)}
              </button>
            )}
          </li>
        ))}
      </ul>
      <NgoCampaignDashboard />
    </>
  )
}

/** The connected NGO's programmes: the ones needs and certificates can point to. */
function ProgramList() {
  const t = useTranslations('ngo')
  const tCommon = useTranslations('common')
  const mounted = useMounted()
  const { address } = useAccount()
  const query = useQuery({
    queryKey: ['programs', address],
    queryFn: () => getPrograms(address as string),
    enabled: Boolean(address),
  })
  const programs = query.data?.ok ? query.data.data : []

  return (
    <Panel title={t('programmesTitle')} description={t('programmesBody')}>
      {!mounted || !address ? <p className="hint">{t('programConnect')}</p> : null}
      {query.isLoading ? <p className="hint">{tCommon('loading')}</p> : null}
      {mounted && address && query.data?.ok && programs.length === 0 ? (
        <p className="text-sm text-slate-700">{t('programmesEmpty')}</p>
      ) : null}
      {programs.length > 0 ? (
        <ul className="grid gap-3 sm:grid-cols-2">
          {programs.map((program) => (
            <li key={program.id} className="flex gap-3 rounded-lg border border-slate-200 p-3">
              <ImagePlaceholder shape="circle" label={t('programmeImage')} className="h-10 w-10 shrink-0" />
              <div className="min-w-0">
                <p className="font-semibold text-slate-900">
                  {programPolicyLabel(program.eligibilityHash)
                    ? t('programOptionNamed', {
                        id: program.id,
                        name: programPolicyLabel(program.eligibilityHash) ?? '',
                      })
                    : t('programOption', { id: program.id })}
                </p>
                <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-600">
                  <span className={`chip ${program.active ? 'bg-emerald-100 text-emerald-900' : ''}`}>
                    {program.active ? t('programmeActive') : t('programmeClosed')}
                  </span>
                  {timestamp(program.createdAt)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </Panel>
  )
}

function CreateProgram() {
  const t = useTranslations('ngo')
  const { address } = useAccount()
  const tx = useTx()
  const queryClient = useQueryClient()
  const [policy, setPolicy] = useState('')
  const [uri, setUri] = useState('')
  const hash = policy.trim() ? keccak256(toHex(policy)) : ZERO_BYTES32

  const create = async () => {
    const result = await tx.run({
      address: deployment?.contracts.ProgramRegistry as Address,
      abi: programRegistryAbi,
      functionName: 'createProgram',
      args: [hash, uri],
    })
    if (!result) return
    rememberProgramPolicy(hash, policy)
    // The need form picks its programme from this list, so it must not need a reload to see a new one. The
    // indexer trails the receipt by a block or two; refreshing before it has the programme would cache "none".
    const [event] = parseEventLogs({
      abi: programRegistryAbi,
      eventName: 'ProgramCreated',
      logs: result.logs,
    })
    if (event && address) {
      const created = event.args.programId.toString()
      for (let attempt = 0; attempt < 20; attempt++) {
        const programs = await getPrograms(address)
        if (programs.ok && programs.data.some((program) => program.id === created)) break
        await new Promise((resolve) => setTimeout(resolve, 1_500))
      }
    }
    await queryClient.invalidateQueries({ queryKey: ['programs'] })
  }

  return (
    <Panel title={t('programTitle')} description={t('programBody')}>
      <TextArea
        label={t('policySimple')}
        value={policy}
        onChange={setPolicy}
        rows={3}
        placeholder={t('policyPlaceholder')}
        hint={t('policySimpleHint')}
      />

      <Advanced title={t('programAdvanced')} hint={t('programAdvancedHint')}>
        <TextField
          label={t('metadataUri')}
          value={uri}
          onChange={setUri}
          placeholder="ipfs://…"
          hint={t('metadataUriHint')}
        />
        <p className="hint">
          {t('policyHash')}: <span className="mono">{hash}</span>
        </p>
      </Advanced>

      <button
        type="button"
        className="btn-primary"
        disabled={!policy.trim() || tx.phase === 'signing' || tx.phase === 'pending'}
        onClick={create}
      >
        {t('createProgram')}
      </button>
      <TxStatus state={tx} />
    </Panel>
  )
}

/**
 * Closing early must respect the terms donors were shown: the ledger reverts below `minFundingBps` of the
 * target, so the panel reads both numbers and explains the threshold instead of letting the NGO hit a revert.
 */
export function CloseFunding({ needId: fixedNeedId }: { needId?: string } = {}) {
  const t = useTranslations('ngo')
  const tCommon = useTranslations('common')
  const tx = useTx()
  const [typedNeedId, setNeedId] = useState('')
  // Fixed by the need dashboard; typed when the panel stands alone.
  const needId = fixedNeedId ?? typedNeedId
  const enabled = /^\d+$/.test(needId)
  const ledger = useLedger(needId)

  const { data: terms } = useReadContract({
    address: deployment?.contracts.NeedsRegistry as Address,
    abi: needsRegistryAbi,
    functionName: 'fundingTermsOf',
    args: enabled ? [BigInt(needId)] : undefined,
    query: { enabled },
  })
  const { data: raised } = useReadContract({
    address: ledger,
    abi: aidVaultAbi,
    functionName: 'totalDonated',
    query: { enabled: Boolean(ledger) },
  })

  const [, target, minFundingBps, open] = terms ?? [undefined, 0n, 0, false]
  const minimum = terms ? (target * BigInt(minFundingBps) + 9_999n) / 10_000n : 0n
  const belowMinimum =
    raised !== undefined && terms !== undefined && raised * 10_000n < target * BigInt(minFundingBps)
  const unit = tCommon('amountUnit')

  return (
    <Panel title={t('closeTitle')} description={t('closeBody')}>
      {fixedNeedId === undefined ? (
        <TextField label={t('needId')} value={typedNeedId} onChange={setNeedId} inputMode="numeric" />
      ) : null}
      <p className="hint mono">{ledger ?? '—'}</p>
      {terms && raised !== undefined ? (
        <div className="space-y-1 text-sm text-slate-800">
          <p>
            {t('closeProgress', { raised: amount(raised), target: amount(target), unit })}{' '}
            {t('closeMinimum', { minimum: amount(minimum), percent: bpsPercent(minFundingBps), unit })}
          </p>
          {!open ? <p className="text-amber-800">{t('closeNotOpen')}</p> : null}
          {open && belowMinimum ? <p className="text-amber-800">{t('closeBelowMinimum')}</p> : null}
        </div>
      ) : null}
      <button
        type="button"
        className="btn-primary"
        disabled={!ledger || !open || belowMinimum || tx.phase === 'signing' || tx.phase === 'pending'}
        onClick={() =>
          ledger && tx.run({ address: ledger, abi: aidVaultAbi, functionName: 'closeFunding', args: [] })
        }
      >
        {t('closeFunding')}
      </button>
      <TxStatus state={tx} />
    </Panel>
  )
}

export function PublishImpactReport({ needId: fixedNeedId }: { needId?: string } = {}) {
  const t = useTranslations('ngo')
  const tErrors = useTranslations('errors')
  const tx = useTx()
  const [typedNeedId, setNeedId] = useState('')
  // Fixed by the need dashboard; typed when the panel stands alone.
  const needId = fixedNeedId ?? typedNeedId
  const [served, setServed] = useState('')
  const [kpiHash, setKpiHash] = useState('')
  const [reportCid, setReportCid] = useState('')
  const [error, setError] = useState<string | null>(null)
  const ledger = useLedger(needId)
  const minimum = deployment?.params.minBeneficiariesServed ?? 5

  const submit = async () => {
    if (!ledger || !/^\d+$/.test(needId) || !/^\d+$/.test(served) || !reportCid.trim()) {
      return setError(tErrors('required'))
    }
    // The resolver rejects a zero KPI hash and small counts (a k-anonymity floor), so say so up front.
    if (!isBytes32(kpiHash) || isZeroHash(kpiHash)) return setError(t('errorKpiHash'))
    if (Number(served) < minimum) return setError(t('errorServed', { minimum }))
    setError(null)

    await tx.run({
      address: deployment?.external.EAS as Address,
      abi: easAbi,
      functionName: 'attest',
      args: [
        attestationRequest({
          name: 'ImpactReport',
          recipient: schemaRecipient('ImpactReport', ledger) as Address,
          values: [BigInt(needId), Number(served), kpiHash as Hex, reportCid.trim()],
        }),
      ],
    })
  }

  return (
    <Panel title={t('impactTitle')} description={t('impactBody')}>
      <div className="grid gap-3 sm:grid-cols-2">
        {fixedNeedId === undefined ? (
          <TextField label={t('needId')} value={typedNeedId} onChange={setNeedId} inputMode="numeric" />
        ) : null}
        <TextField
          label={t('beneficiariesServed')}
          value={served}
          onChange={setServed}
          inputMode="numeric"
          hint={`≥ ${minimum}`}
        />
        <TextField label={t('kpiHash')} value={kpiHash} onChange={setKpiHash} placeholder="0x…" />
        <TextField label={t('reportCid')} value={reportCid} onChange={setReportCid} placeholder="bafy…" />
      </div>
      <FormError message={error} />
      <button
        type="button"
        className="btn-primary"
        disabled={!ledger || tx.phase === 'signing' || tx.phase === 'pending'}
        onClick={submit}
      >
        {t('publishReport')}
      </button>
      <TxStatus state={tx} />
    </Panel>
  )
}
