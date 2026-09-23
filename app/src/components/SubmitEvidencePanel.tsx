'use client'

import {
  buildManifest,
  deliveryManagerAbi,
  EVIDENCE_KINDS,
  type EvidenceKind,
  MAX_EVIDENCE_FILES,
  MAX_MANIFEST_BYTES,
  MAX_NOTE_LENGTH,
  manifestBytes,
  type NeedDetail,
} from '@poa/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import type { Address } from 'viem'
import { FormError, Panel, TextArea } from '@/components/form'
import { TxStatus } from '@/components/TxStatus'
import { deployment } from '@/lib/config'
import { amount } from '@/lib/format'
import { useTx } from '@/lib/hooks'
import { getNeed } from '@/lib/indexer'
import { uploadEvidenceFiles } from '@/lib/services'

interface Picked {
  /** Stable across removals, so a row keeps its own kind when one above it goes. */
  id: string
  file: File
  kind: EvidenceKind
}

/** A first guess the NGO can change: photos are photos, a PDF named like a statement is one, the rest receipts. */
const guessKind = (file: File): EvidenceKind => {
  if (file.type.startsWith('image/')) return 'photo'
  if (/extracto|statement|bank|banco|cuenta/i.test(file.name)) return 'bank_statement'
  return 'receipt'
}

/** The tranche a new manifest would unlock: the first locked one whose predecessor has been paid. */
export const trancheToAccountFor = (need: NeedDetail) =>
  need.tranches.find(
    (tranche) =>
      tranche.index > 0 &&
      tranche.status === 'Locked' &&
      need.tranches[tranche.index - 1]?.status === 'Released',
  )

/**
 * The NGO accounts for a tranche it was paid: photos of the work, supplier receipts and bank statements, plus a
 * note. The files are stored by this app under their SHA-256; the manifest listing them is what the NGO signs, and
 * its hash is what the chain keeps. Donors who gave at least the approval threshold then unlock the next tranche.
 */
export function SubmitEvidencePanel({ need }: { need: NeedDetail }) {
  const t = useTranslations('evidence')
  const tCommon = useTranslations('common')
  const inputId = useId()
  const queryClient = useQueryClient()
  const tx = useTx()
  const [picked, setPicked] = useState<Picked[]>([])
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)

  const next = trancheToAccountFor(need)
  if (!next) return null
  const spent = need.tranches[next.index - 1]
  const open = need.deliveries.find(
    (delivery) => delivery.status === 'Open' && delivery.trancheIndex === next.index,
  )
  const unit = tCommon('amountUnit')
  const busy = uploading || tx.phase === 'signing' || tx.phase === 'pending'

  const add = (files: FileList | null) => {
    if (!files) return
    const room = MAX_EVIDENCE_FILES - picked.length
    setPicked([
      ...picked,
      ...[...files].slice(0, room).map((file) => ({ id: crypto.randomUUID(), file, kind: guessKind(file) })),
    ])
  }

  const submit = async () => {
    if (picked.length === 0) return setError(t('errorNoFiles'))
    if (!note.trim()) return setError(t('errorNoNote'))
    setError(null)
    setUploading(true)
    const uploaded = await uploadEvidenceFiles(picked.map((item) => item.file))
    setUploading(false)
    if (!uploaded.ok) return setError(t('errorUpload', { detail: uploaded.error }))

    const manifest = buildManifest(
      note,
      uploaded.data.map((file, i) => ({ ...file, kind: picked[i]?.kind ?? 'other' })),
    )
    if (manifestBytes(manifest) > MAX_MANIFEST_BYTES) return setError(t('errorTooLong'))

    const result = await tx.run({
      address: deployment?.contracts.DeliveryManager as Address,
      abi: deliveryManagerAbi,
      functionName: 'submitEvidence',
      args: [BigInt(need.id), manifest],
    })
    if (!result) return
    setPicked([])
    setNote('')
    // The indexer trails the receipt; refresh once it has the new evidence.
    const before = need.deliveries.length
    for (let attempt = 0; attempt < 20; attempt++) {
      const fresh = await getNeed(need.id)
      if (fresh.ok && fresh.data.deliveries.length > before) break
      await new Promise((resolve) => setTimeout(resolve, 1_500))
    }
    await queryClient.invalidateQueries({ queryKey: ['ngo-need', need.id] })
  }

  return (
    <Panel
      title={t('submitTitle', { spent: spent?.index ?? 0 })}
      description={t('submitBody', {
        spent: spent?.index ?? 0,
        amount: amount(spent?.amount ?? '0'),
        unit,
        next: next.index,
        threshold: (deployment?.params.donorApprovalBps ?? 3000) / 100,
      })}
    >
      <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">
        {t('publicWarning')}
      </p>

      {open ? (
        <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800">
          {t('underReview', {
            id: open.id,
            approved: amount(open.approvedAmount),
            required: amount(open.requiredAmount),
            unit,
          })}{' '}
          <span className="text-slate-600">{t('replaceHint')}</span>
        </p>
      ) : null}

      <div>
        <label className="label" htmlFor={inputId}>
          {t('filesLabel')}
        </label>
        <input
          id={inputId}
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp,application/pdf"
          className="mt-1 block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-teal-700 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white"
          onChange={(event) => {
            add(event.target.files)
            event.target.value = ''
          }}
          disabled={busy || picked.length >= MAX_EVIDENCE_FILES}
        />
        <p className="hint">{t('filesHint', { max: MAX_EVIDENCE_FILES })}</p>
      </div>

      {picked.length > 0 ? (
        <ul className="divide-y divide-slate-200 rounded-md border border-slate-200">
          {picked.map((item, index) => (
            <li key={item.id} className="flex flex-wrap items-center gap-2 p-2 text-sm">
              <span className="min-w-0 flex-1 truncate" title={item.file.name}>
                {item.file.name}
              </span>
              <select
                className="input mt-0 w-auto min-w-[10rem]"
                value={item.kind}
                aria-label={t('kindLabel', { name: item.file.name })}
                onChange={(event) =>
                  setPicked(
                    picked.map((other, i) =>
                      i === index ? { ...other, kind: event.target.value as EvidenceKind } : other,
                    ),
                  )
                }
              >
                {EVIDENCE_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {t(`kind.${kind}`)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn-secondary min-h-0 py-1.5 text-xs"
                onClick={() => setPicked(picked.filter((_, i) => i !== index))}
                disabled={busy}
              >
                {t('remove')}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <TextArea
        label={t('noteLabel')}
        value={note}
        onChange={(value) => setNote(value.slice(0, MAX_NOTE_LENGTH))}
        rows={3}
        placeholder={t('notePlaceholder')}
        hint={t('noteHint', { used: note.length, max: MAX_NOTE_LENGTH })}
      />

      <FormError message={error} />
      <button type="button" className="btn-primary" disabled={busy} onClick={submit}>
        {uploading ? t('uploading') : open ? t('replaceButton') : t('submitButton')}
      </button>
      <TxStatus state={tx} />
    </Panel>
  )
}
