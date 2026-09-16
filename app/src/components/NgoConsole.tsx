'use client'

import { aidVaultAbi, beneficiaryGroupsAbi, CUSTODY_MODE, easAbi, needsRegistryAbi } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { type Address, type Hex, keccak256, toHex } from 'viem'
import { useReadContract } from 'wagmi'
import { CreateNeedPanel } from '@/components/CreateNeedPanel'
import { FormError, Panel, TextArea, TextField } from '@/components/form'
import { MissingDeployment, Notice } from '@/components/Notice'
import { SettlementPanel } from '@/components/SettlementPanel'
import { TxStatus } from '@/components/TxStatus'
import { deployment } from '@/lib/config'
import { attestationRequest, schemaRecipient } from '@/lib/eas'
import { amount, bpsPercent, isBytes32, isZeroHash, ZERO_BYTES32 } from '@/lib/format'
import { useLedger, useTx } from '@/lib/hooks'

export function NgoConsole() {
  if (!deployment) return <MissingDeployment />

  return (
    <div className="space-y-6">
      <CreateProgram />
      <AddMembers />
      <CreateNeedPanel />
      <CloseFunding />
      <ReleaseTranche />
      <SettlementPanel />
      <PublishImpactReport />
    </div>
  )
}

function CreateProgram() {
  const t = useTranslations('ngo')
  const tx = useTx()
  const [policy, setPolicy] = useState('')
  const [uri, setUri] = useState('')
  const hash = policy ? keccak256(toHex(policy)) : ZERO_BYTES32

  return (
    <Panel title={t('programTitle')} description={t('programBody')}>
      <TextArea label={t('policyText')} value={policy} onChange={setPolicy} rows={3} />
      <p className="hint">
        {t('policyHash')}: <span className="mono">{hash}</span>
      </p>
      <TextField label={t('metadataUri')} value={uri} onChange={setUri} placeholder="ipfs://…" />
      <button
        type="button"
        className="btn-primary"
        disabled={tx.phase === 'signing' || tx.phase === 'pending'}
        onClick={() =>
          tx.run({
            address: deployment?.contracts.BeneficiaryGroups as Address,
            abi: beneficiaryGroupsAbi,
            functionName: 'createProgram',
            args: [hash, uri],
          })
        }
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
      <TextField label={t('programId')} value={programId} onChange={setProgramId} inputMode="numeric" />
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

/** Whether the need's money is held on chain; `undefined` while unknown. */
function useCustody(needId: string) {
  const enabled = /^\d+$/.test(needId)
  const { data } = useReadContract({
    address: deployment?.contracts.NeedsRegistry as Address,
    abi: needsRegistryAbi,
    functionName: 'custodyModeOf',
    args: enabled ? [BigInt(needId)] : undefined,
    query: { enabled },
  })
  return data === undefined ? undefined : CUSTODY_MODE[data]
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

function ReleaseTranche() {
  const t = useTranslations('ngo')
  const tx = useTx()
  const [needId, setNeedId] = useState('')
  const [index, setIndex] = useState('0')
  const vault = useLedger(needId)
  const offChain = useCustody(needId) === 'OffChain'

  return (
    <Panel title={t('releaseTitle')} description={t('releaseBody')}>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label={t('needId')} value={needId} onChange={setNeedId} inputMode="numeric" />
        <TextField label={t('trancheIndex')} value={index} onChange={setIndex} inputMode="numeric" />
      </div>
      <p className="hint mono">{vault ?? '—'}</p>
      {offChain ? <Notice tone="info" title={t('releaseOffChain')} /> : null}
      <button
        type="button"
        className="btn-primary"
        disabled={
          !vault || offChain || !/^\d+$/.test(index) || tx.phase === 'signing' || tx.phase === 'pending'
        }
        onClick={() =>
          vault &&
          tx.run({
            address: vault,
            abi: aidVaultAbi,
            functionName: 'releaseTranche',
            args: [BigInt(index)],
          })
        }
      >
        {t('releaseTranche')}
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
