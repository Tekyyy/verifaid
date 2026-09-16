'use client'

import { deliveryManagerAbi, easAbi } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { type Address, type Hex, stringToHex } from 'viem'
import { FormError, Panel, TextField } from '@/components/form'
import { MissingDeployment, Notice } from '@/components/Notice'
import { TxStatus } from '@/components/TxStatus'
import { deployment } from '@/lib/config'
import { attestationRequest } from '@/lib/eas'
import { useTx } from '@/lib/hooks'
import { uploadEvidence } from '@/lib/services'

const isBytes32 = (value: string): value is Hex => /^0x[0-9a-fA-F]{64}$/.test(value)
const toBytes32String = (value: string): Hex => stringToHex(value, { size: 32 })

export function FieldConsole() {
  const t = useTranslations('field')

  if (!deployment) return <MissingDeployment />

  return (
    <div className="space-y-6">
      <Notice tone="warning" title={t('privacyWarning')} />
      <OpenDelivery />
      <UploadEvidence />
    </div>
  )
}

function OpenDelivery() {
  const t = useTranslations('field')
  const tErrors = useTranslations('errors')
  const tx = useTx()
  const [needId, setNeedId] = useState('')
  const [trancheIndex, setTrancheIndex] = useState('1')
  const [expected, setExpected] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    if (![needId, trancheIndex, expected].every((value) => /^\d+$/.test(value))) {
      return setError(tErrors('required'))
    }
    setError(null)
    await tx.run({
      address: deployment?.contracts.DeliveryManager as Address,
      abi: deliveryManagerAbi,
      functionName: 'openDelivery',
      args: [BigInt(needId), BigInt(trancheIndex), Number(expected)],
    })
  }

  return (
    <Panel title={t('openTitle')} description={t('openBody')}>
      <div className="grid gap-3 sm:grid-cols-3">
        <TextField label={t('needId')} value={needId} onChange={setNeedId} inputMode="numeric" />
        <TextField
          label={t('trancheIndex')}
          value={trancheIndex}
          onChange={setTrancheIndex}
          inputMode="numeric"
        />
        <TextField
          label={t('expectedRecipients')}
          value={expected}
          onChange={setExpected}
          inputMode="numeric"
          hint={`≥ ${deployment?.params.minExpectedRecipients ?? 5}`}
        />
      </div>
      <FormError message={error} />
      <button
        type="button"
        className="btn-primary"
        disabled={tx.phase === 'signing' || tx.phase === 'pending'}
        onClick={submit}
      >
        {t('openDelivery')}
      </button>
      <TxStatus state={tx} />
    </Panel>
  )
}

/**
 * Upload then attest. They are separate steps on purpose: the hash that goes on chain is the one the evidence
 * service computed over the ciphertext it actually stored, and the field agent can see it before signing.
 */
function UploadEvidence() {
  const t = useTranslations('field')
  const tErrors = useTranslations('errors')
  const tx = useTx()

  const [deliveryId, setDeliveryId] = useState('')
  const [items, setItems] = useState('')
  const [region, setRegion] = useState('')
  const [note, setNote] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [evidenceHash, setEvidenceHash] = useState('')
  const [cid, setCid] = useState('')
  const [busy, setBusy] = useState(false)
  const [serviceError, setServiceError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const upload = async () => {
    if (!/^\d+$/.test(deliveryId) || files.length === 0) return setServiceError(tErrors('required'))
    setBusy(true)
    setServiceError(null)
    const result = await uploadEvidence(files, {
      deliveryId,
      itemsDelivered: Number(items) || 0,
      regionCode: region,
      note: note || undefined,
    })
    setBusy(false)
    if (result.ok) {
      setEvidenceHash(result.data.evidenceHash)
      setCid(result.data.cid)
    } else {
      setServiceError(tErrors('serviceUnavailable', { detail: result.error }))
    }
  }

  const attest = async () => {
    if (!/^\d+$/.test(deliveryId) || !isBytes32(evidenceHash) || !cid || !region || !/^\d+$/.test(items)) {
      return setError(tErrors('required'))
    }
    setError(null)
    await tx.run({
      address: deployment?.external.EAS as Address,
      abi: easAbi,
      functionName: 'attest',
      args: [
        attestationRequest({
          name: 'DeliveryEvidence',
          recipient: deployment?.contracts.DeliveryManager as Address,
          values: [BigInt(deliveryId), evidenceHash as Hex, cid, Number(items), toBytes32String(region)],
        }),
      ],
    })
  }

  return (
    <>
      <Panel title={t('uploadTitle')} description={t('uploadBody')}>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label={t('deliveryId')}
            value={deliveryId}
            onChange={setDeliveryId}
            inputMode="numeric"
          />
          <TextField label={t('itemsDelivered')} value={items} onChange={setItems} inputMode="numeric" />
          <TextField label={t('regionCode')} value={region} onChange={setRegion} placeholder="ES-CM" />
          <TextField label={t('note')} value={note} onChange={setNote} />
        </div>

        <div>
          <label className="label" htmlFor="evidence-files">
            {t('files')}
          </label>
          <input
            id="evidence-files"
            className="input"
            type="file"
            multiple
            accept="image/*,application/pdf"
            capture="environment"
            onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
          />
        </div>

        <FormError message={serviceError} />
        <button type="button" className="btn-secondary" disabled={busy} onClick={upload}>
          {t('upload')}
        </button>
        {evidenceHash ? <p className="hint mono">{t('uploadResult', { hash: evidenceHash, cid })}</p> : null}
      </Panel>

      <Panel title={t('attestTitle')} description={t('attestBody')}>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label={t('evidenceHash')}
            value={evidenceHash}
            onChange={setEvidenceHash}
            placeholder="0x…"
          />
          <TextField label={t('evidenceCid')} value={cid} onChange={setCid} placeholder="bafy…" />
        </div>
        <FormError message={error} />
        <button
          type="button"
          className="btn-primary"
          disabled={tx.phase === 'signing' || tx.phase === 'pending'}
          onClick={attest}
        >
          {t('attest')}
        </button>
        <TxStatus state={tx} />
      </Panel>
    </>
  )
}
