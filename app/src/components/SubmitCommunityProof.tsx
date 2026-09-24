'use client'

import {
  buildManifest,
  communityProofsAbi,
  MAX_MANIFEST_BYTES,
  manifestBytes,
  type NeedStatus,
} from '@poa/shared'
import { useTranslations } from 'next-intl'
import { useEffect, useId, useState } from 'react'
import { type Address, isAddressEqual } from 'viem'
import { useAccount } from 'wagmi'
import { FormError } from '@/components/form'
import { TxStatus } from '@/components/TxStatus'
import { useRouter } from '@/i18n/navigation'
import { acceptsProof } from '@/lib/community'
import { deployment } from '@/lib/config'
import { useMounted, useTx } from '@/lib/hooks'
import { uploadEvidenceFiles } from '@/lib/services'

const MAX_PROOF_PHOTOS = 6
const PHOTO_TYPES = 'image/jpeg,image/png,image/webp'

/**
 * Filing proof about a need from any wallet: photos of goods, sites and deliveries, and a line saying what they
 * show. The photos go through the same upload as delivery evidence — location and camera data stripped, each file
 * committed by hash — and the manifest listing them is written on chain in the filer's name.
 */
export function SubmitCommunityProof({
  needId,
  status,
  ngo,
  beneficiary,
  rewardText,
}: {
  needId: string
  status: NeedStatus
  ngo: Address
  beneficiary: Address | null
  /** "5.00 USDC" when an open pot still pays for proof, so the filer knows what to expect. */
  rewardText: string | null
}) {
  const t = useTranslations('community')
  const mounted = useMounted()
  const { address } = useAccount()
  const contract = deployment?.contracts.CommunityProofs

  if (!contract) return null
  if (!acceptsProof(status)) return <p className="text-sm text-slate-600">{t('notYet')}</p>
  if (!mounted || !address) return <p className="text-sm text-slate-700">{t('connect')}</p>
  const runsIt = isAddressEqual(address, ngo) || Boolean(beneficiary && isAddressEqual(address, beneficiary))
  if (runsIt) return <p className="text-sm text-slate-700">{t('yours')}</p>

  // A form per wallet: one that switches wallets starts afresh instead of showing the last one's proof as filed.
  return <ProofForm key={address} needId={needId} contract={contract} rewardText={rewardText} />
}

function ProofForm({
  needId,
  contract,
  rewardText,
}: {
  needId: string
  contract: Address
  rewardText: string | null
}) {
  const t = useTranslations('community')
  const router = useRouter()
  const tx = useTx()
  const inputId = useId()
  const noteId = useId()
  const [photos, setPhotos] = useState<File[]>([])
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)

  // The page lists the proof from the server: ask for it again once the indexer has the new one.
  useEffect(() => {
    if (tx.phase !== 'success') return
    const timer = setTimeout(() => router.refresh(), 2_500)
    return () => clearTimeout(timer)
  }, [tx.phase, router])

  if (tx.phase === 'success') {
    return (
      <div
        className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900"
        role="status"
      >
        <p className="font-medium">{t('done')}</p>
        {rewardText ? <p className="mt-1">{t('doneReward', { reward: rewardText })}</p> : null}
      </div>
    )
  }

  const busy = uploading || tx.phase === 'signing' || tx.phase === 'pending'

  const submit = async () => {
    if (photos.length === 0) return setError(t('errorNoPhotos'))
    if (!note.trim()) return setError(t('errorNoNote'))
    setError(null)
    setUploading(true)
    const uploaded = await uploadEvidenceFiles(photos)
    setUploading(false)
    if (!uploaded.ok) return setError(t('errorUpload', { detail: uploaded.error }))
    const manifest = buildManifest(
      note,
      uploaded.data.map((file) => ({ ...file, kind: 'photo' as const })),
    )
    if (manifestBytes(manifest) > MAX_MANIFEST_BYTES) return setError(t('errorTooLong'))
    await tx.run({
      address: contract,
      abi: communityProofsAbi,
      functionName: 'submitProof',
      args: [BigInt(needId), manifest],
    })
  }

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
      <div>
        <h3 className="font-semibold text-slate-900">{t('formTitle')}</h3>
        <p className="mt-1 text-sm text-slate-700">{t('formBody')}</p>
      </div>
      <div>
        <label className="label" htmlFor={inputId}>
          {t('photosLabel')}
        </label>
        <input
          id={inputId}
          type="file"
          multiple
          accept={PHOTO_TYPES}
          disabled={busy || photos.length >= MAX_PROOF_PHOTOS}
          className="mt-1 block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-teal-700 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white"
          onChange={(event) => {
            const chosen = [...(event.target.files ?? [])].filter((file) => file.type.startsWith('image/'))
            setPhotos([...photos, ...chosen].slice(0, MAX_PROOF_PHOTOS))
            event.target.value = ''
          }}
        />
        <p className="hint">{t('photosHint', { max: MAX_PROOF_PHOTOS })}</p>
        {photos.length > 0 ? (
          <ul className="mt-2 flex flex-wrap gap-2 text-xs">
            {photos.map((photo, index) => (
              <li
                key={`${photo.name}-${photo.size}-${photo.lastModified}`}
                className="chip gap-1 bg-white ring-1 ring-slate-200"
              >
                {photo.name}
                <button
                  type="button"
                  className="text-slate-500 hover:text-red-700"
                  aria-label={t('remove', { name: photo.name })}
                  disabled={busy}
                  onClick={() => setPhotos(photos.filter((_, i) => i !== index))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div>
        <label className="label" htmlFor={noteId}>
          {t('noteLabel')}
        </label>
        <textarea
          id={noteId}
          className="input mt-1"
          rows={2}
          maxLength={500}
          value={note}
          placeholder={t('notePlaceholder')}
          onChange={(event) => setNote(event.target.value)}
        />
      </div>
      <FormError message={error} />
      <button type="button" className="btn-primary" disabled={busy} onClick={submit}>
        {uploading ? t('uploading') : t('submit')}
      </button>
      <TxStatus state={tx} />
    </div>
  )
}
