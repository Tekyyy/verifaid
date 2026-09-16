'use client'

import {
  aidVaultAbi,
  beneficiaryGroupsAbi,
  CATEGORIES,
  categoryHash,
  easAbi,
  needsRegistryAbi,
} from '@poa/shared'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { type Address, type Hex, keccak256, stringToHex, toHex } from 'viem'
import { useReadContract } from 'wagmi'
import { FormError, Panel, SelectField, TextArea, TextField } from '@/components/form'
import { MissingDeployment } from '@/components/Notice'
import { TxStatus } from '@/components/TxStatus'
import { deployment } from '@/lib/config'
import { attestationRequest } from '@/lib/eas'
import { parseAmount } from '@/lib/format'
import { useTx } from '@/lib/hooks'
import { storeDossier } from '@/lib/services'

const ZERO_BYTES32 = `0x${'00'.repeat(32)}` as Hex
const isBytes32 = (value: string): value is Hex => /^0x[0-9a-fA-F]{64}$/.test(value)

/** bytes32 from a short ASCII code, right-padded — the same encoding the contracts use for region codes. */
const toBytes32String = (value: string): Hex => stringToHex(value, { size: 32 })

export function NgoConsole() {
  if (!deployment) return <MissingDeployment />

  return (
    <div className="space-y-6">
      <CreateProgram />
      <AddMembers />
      <CreateNeed />
      <CloseFunding />
      <ReleaseTranche />
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

function CreateNeed() {
  const t = useTranslations('ngo')
  const tCommon = useTranslations('common')
  const tErrors = useTranslations('errors')
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
  const [serviceError, setServiceError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const parts = tranches
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  const sum = parts.reduce((total, part) => total + (Number(part) || 0), 0)

  const store = async () => {
    setServiceError(null)
    const result = await storeDossier(dossierText)
    if (result.ok) setDossierHash(result.data.hash)
    else setServiceError(tErrors('serviceUnavailable', { detail: result.error }))
  }

  const submit = async () => {
    const amount = parseAmount(target)
    if (!/^\d+$/.test(programId) || !amount || !region) return setError(tErrors('required'))
    if (parts.length < 1 || parts.length > 5 || Math.round(sum) !== 100) {
      return setError(tErrors('invalidTranches'))
    }
    if (dossierHash && !isBytes32(dossierHash)) return setError(tErrors('required'))
    setError(null)

    // Percent in the form, basis points on chain.
    const bps = parts.map((part) => Math.round(Number(part) * 100))
    const drift = 10_000 - bps.reduce((total, value) => total + value, 0)
    if (drift !== 0 && bps.length > 0) bps[bps.length - 1] = (bps.at(-1) as number) + drift

    await tx.run({
      address: deployment?.contracts.NeedsRegistry as Address,
      abi: needsRegistryAbi,
      functionName: 'createNeed',
      args: [
        {
          programId: BigInt(programId),
          category: categoryHash(category),
          targetAmount: amount,
          regionCode: toBytes32String(region),
          dossierHash: (dossierHash || ZERO_BYTES32) as Hex,
          metadataURI: metadataUri,
          verificationsRequired: Number(verifications),
          trancheBps: bps,
        },
      ],
    })
  }

  return (
    <Panel title={t('needTitle')} description={t('needBody')}>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label={t('programId')} value={programId} onChange={setProgramId} inputMode="numeric" />
        <SelectField label={t('category')} value={category} onChange={setCategory} options={CATEGORIES} />
        <TextField
          label={t('targetAmount', { unit: tCommon('amountUnit') })}
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

/** Resolves a need id to its vault address, which is where funding and tranche calls actually go. */
function useVault(needId: string): Address | undefined {
  const enabled = /^\d+$/.test(needId)
  const { data } = useReadContract({
    address: deployment?.contracts.NeedsRegistry as Address,
    abi: needsRegistryAbi,
    functionName: 'vaultOf',
    args: enabled ? [BigInt(needId)] : undefined,
    query: { enabled },
  })
  return data as Address | undefined
}

function CloseFunding() {
  const t = useTranslations('ngo')
  const tx = useTx()
  const [needId, setNeedId] = useState('')
  const vault = useVault(needId)

  return (
    <Panel title={t('closeTitle')} description={t('closeBody')}>
      <TextField label={t('needId')} value={needId} onChange={setNeedId} inputMode="numeric" />
      <p className="hint mono">{vault ?? '—'}</p>
      <button
        type="button"
        className="btn-primary"
        disabled={!vault || tx.phase === 'signing' || tx.phase === 'pending'}
        onClick={() =>
          vault && tx.run({ address: vault, abi: aidVaultAbi, functionName: 'closeFunding', args: [] })
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
  const vault = useVault(needId)

  return (
    <Panel title={t('releaseTitle')} description={t('releaseBody')}>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label={t('needId')} value={needId} onChange={setNeedId} inputMode="numeric" />
        <TextField label={t('trancheIndex')} value={index} onChange={setIndex} inputMode="numeric" />
      </div>
      <p className="hint mono">{vault ?? '—'}</p>
      <button
        type="button"
        className="btn-primary"
        disabled={!vault || !/^\d+$/.test(index) || tx.phase === 'signing' || tx.phase === 'pending'}
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
  const vault = useVault(needId)

  const submit = async () => {
    if (!vault || !/^\d+$/.test(needId) || !/^\d+$/.test(served)) return setError(tErrors('required'))
    if (kpiHash && !isBytes32(kpiHash)) return setError(tErrors('required'))
    if (refUid && !isBytes32(refUid)) return setError(tErrors('required'))
    setError(null)

    await tx.run({
      address: deployment?.external.EAS as Address,
      abi: easAbi,
      functionName: 'attest',
      args: [
        attestationRequest({
          name: 'ImpactReport',
          recipient: vault,
          refUID: (refUid || undefined) as Hex | undefined,
          values: [BigInt(needId), Number(served), (kpiHash || ZERO_BYTES32) as Hex, reportCid],
        }),
      ],
    })
  }

  return (
    <Panel title={t('impactTitle')} description={t('impactBody')}>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label={t('needId')} value={needId} onChange={setNeedId} inputMode="numeric" />
        <TextField label={t('beneficiariesServed')} value={served} onChange={setServed} inputMode="numeric" />
        <TextField label={t('kpiHash')} value={kpiHash} onChange={setKpiHash} placeholder="0x…" />
        <TextField label={t('reportCid')} value={reportCid} onChange={setReportCid} placeholder="bafy…" />
      </div>
      <TextField label={t('lastVerifiedUid')} value={refUid} onChange={setRefUid} placeholder="0x…" />
      <FormError message={error} />
      <button
        type="button"
        className="btn-primary"
        disabled={!vault || tx.phase === 'signing' || tx.phase === 'pending'}
        onClick={submit}
      >
        {t('publishReport')}
      </button>
      <TxStatus state={tx} />
    </Panel>
  )
}
