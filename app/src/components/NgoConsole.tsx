'use client'

import { aidVaultAbi, beneficiaryGroupsAbi, easAbi, needsRegistryAbi } from '@poa/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { type Address, type Hex, keccak256, parseEventLogs, toHex } from 'viem'
import { useAccount, useReadContract } from 'wagmi'
import { AcknowledgeDonationsPanel } from '@/components/AcknowledgeDonationsPanel'
import { CreateNeedPanel } from '@/components/CreateNeedPanel'
import { Advanced, FormError, Panel, TextArea, TextField } from '@/components/form'
import { IdleCapitalPanel } from '@/components/IdleCapitalPanel'
import { NeedPresentationPanel } from '@/components/NeedPresentationPanel'
import { MissingDeployment } from '@/components/Notice'
import { ProposePayeeChangePanel } from '@/components/PayeeChangePanel'
import { ProgramPicker } from '@/components/ProgramPicker'
import { PublishPhotosPanel } from '@/components/PublishPhotosPanel'
import { ReleaseTranchePanel } from '@/components/ReleaseTranchePanel'
import { SettlementPanel } from '@/components/SettlementPanel'
import { TaxStatusPanel } from '@/components/TaxStatusPanel'
import { TxStatus } from '@/components/TxStatus'
import { deployment } from '@/lib/config'
import { attestationRequest, schemaRecipient } from '@/lib/eas'
import { amount, bpsPercent, isBytes32, isZeroHash, ZERO_BYTES32 } from '@/lib/format'
import { useLedger, useTx } from '@/lib/hooks'
import { getPrograms } from '@/lib/indexer'
import { rememberProgramPolicy } from '@/lib/programNames'

export function NgoConsole() {
  if (!deployment) return <MissingDeployment />

  return (
    <div className="space-y-6">
      <CreateProgram />
      <AddMembers />
      <CreateNeedPanel />
      <NeedPresentationPanel />
      <CloseFunding />
      <ReleaseTranchePanel />
      <IdleCapitalPanel />
      <ProposePayeeChangePanel />
      <SettlementPanel />
      <PublishPhotosPanel />
      <TaxStatusPanel />
      <AcknowledgeDonationsPanel />
      <PublishImpactReport />
    </div>
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
      address: deployment?.contracts.BeneficiaryGroups as Address,
      abi: beneficiaryGroupsAbi,
      functionName: 'createProgram',
      args: [hash, uri],
    })
    if (!result) return
    rememberProgramPolicy(hash, policy)
    // The need form picks its programme from this list, so it must not need a reload to see a new one. The
    // indexer trails the receipt by a block or two; refreshing before it has the programme would cache "none".
    const [event] = parseEventLogs({
      abi: beneficiaryGroupsAbi,
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

function AddMembers() {
  const t = useTranslations('ngo')
  const tErrors = useTranslations('errors')
  const tx = useTx()
  const [programId, setProgramId] = useState('')
  const [raw, setRaw] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    const commitments = raw
      .split(/\s+/)
      .map((line) => line.trim())
      .filter(Boolean)
    if (!/^\d+$/.test(programId) || commitments.length === 0 || !commitments.every((c) => /^\d+$/.test(c))) {
      setError(tErrors('required'))
      return
    }
    setError(null)
    await tx.run({
      address: deployment?.contracts.BeneficiaryGroups as Address,
      abi: beneficiaryGroupsAbi,
      functionName: 'addMembers',
      args: [BigInt(programId), commitments.map((c) => BigInt(c))],
    })
  }

  return (
    <Panel title={t('membersTitle')} description={t('membersBody')}>
      <ProgramPicker value={programId} onChange={setProgramId} />
      <TextArea label={t('commitments')} value={raw} onChange={setRaw} rows={5} />
      <FormError message={error} />
      <button
        type="button"
        className="btn-primary"
        disabled={tx.phase === 'signing' || tx.phase === 'pending'}
        onClick={submit}
      >
        {t('addMembers')}
      </button>
      <TxStatus state={tx} />
    </Panel>
  )
}

/**
 * Closing early must respect the terms donors were shown: the ledger reverts below `minFundingBps` of the
 * target, so the panel reads both numbers and explains the threshold instead of letting the NGO hit a revert.
 */
function CloseFunding() {
  const t = useTranslations('ngo')
  const tCommon = useTranslations('common')
  const tx = useTx()
  const [needId, setNeedId] = useState('')
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
      <TextField label={t('needId')} value={needId} onChange={setNeedId} inputMode="numeric" />
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

function PublishImpactReport() {
  const t = useTranslations('ngo')
  const tErrors = useTranslations('errors')
  const tx = useTx()
  const [needId, setNeedId] = useState('')
  const [served, setServed] = useState('')
  const [kpiHash, setKpiHash] = useState('')
  const [reportCid, setReportCid] = useState('')
  const [refUid, setRefUid] = useState('')
  const [error, setError] = useState<string | null>(null)
  const ledger = useLedger(needId)
  const minimum = deployment?.params.minExpectedRecipients ?? 5

  const submit = async () => {
    if (!ledger || !/^\d+$/.test(needId) || !/^\d+$/.test(served) || !reportCid.trim()) {
      return setError(tErrors('required'))
    }
    // The resolver rejects a zero KPI hash and small counts (a k-anonymity floor), so say so up front.
    if (!isBytes32(kpiHash) || isZeroHash(kpiHash)) return setError(t('errorKpiHash'))
    if (Number(served) < minimum) return setError(t('errorServed', { minimum }))
    if (refUid && !isBytes32(refUid)) return setError(tErrors('required'))
    setError(null)

    await tx.run({
      address: deployment?.external.EAS as Address,
      abi: easAbi,
      functionName: 'attest',
      args: [
        attestationRequest({
          name: 'ImpactReport',
          recipient: schemaRecipient('ImpactReport', ledger) as Address,
          refUID: (refUid || undefined) as Hex | undefined,
          values: [BigInt(needId), Number(served), kpiHash as Hex, reportCid.trim()],
        }),
      ],
    })
  }

  return (
    <Panel title={t('impactTitle')} description={t('impactBody')}>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label={t('needId')} value={needId} onChange={setNeedId} inputMode="numeric" />
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
      <TextField label={t('lastVerifiedUid')} value={refUid} onChange={setRefUid} placeholder="0x…" />
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
