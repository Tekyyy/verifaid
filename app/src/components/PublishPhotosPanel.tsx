'use client'

import { easAbi } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import type { Address } from 'viem'
import { FormError, Panel, TextArea, TextField } from '@/components/form'
import { TxStatus } from '@/components/TxStatus'
import { deployment } from '@/lib/config'
import { communityAttestationRequest, hasCommunitySchema } from '@/lib/eas'
import { useTx } from '@/lib/hooks'

/** Same bound the indexer applies: a page shows a handful of photos, not a thousand. */
const MAX_PHOTOS = 12

/**
 * Publishing photos of finished work. It is an attestation the NGO signs, not an upload: the images stay
 * wherever the NGO already hosts them and only the links are committed, with the NGO's signature over them.
 * The indexer keeps photos only for needs that NGO owns, which is what makes the badge on a need's card mean
 * "published by the organisation accountable for it".
 */
export function PublishPhotosPanel() {
  const t = useTranslations('ngo')
  const tx = useTx()
  const [needId, setNeedId] = useState('')
  const [urls, setUrls] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  if (!hasCommunitySchema('WorkPhotos')) return null

  const photos = urls
    .split(/[\s,]+/)
    .map((url) => url.trim())
    .filter(Boolean)
  const usable = photos.filter((url) => /^(https:\/\/|ipfs:\/\/)/i.test(url))

  const publish = async () => {
    if (!/^\d+$/.test(needId)) return setError(t('photosErrorNeed'))
    if (usable.length === 0 || usable.length !== photos.length) return setError(t('photosErrorUrls'))
    if (usable.length > MAX_PHOTOS) return setError(t('photosErrorCount', { max: MAX_PHOTOS }))
    setError(null)
    await tx.run({
      address: deployment?.external.EAS as Address,
      abi: easAbi,
      functionName: 'attest',
      args: [communityAttestationRequest('WorkPhotos', [BigInt(needId), usable, note.trim()])],
    })
  }

  return (
    <Panel title={t('photosTitle')} description={t('photosBody')}>
      <TextField label={t('needId')} value={needId} onChange={setNeedId} inputMode="numeric" />
      <TextArea label={t('photosUrls')} value={urls} onChange={setUrls} rows={3} hint={t('photosUrlsHint')} />
      <TextField label={t('photosNote')} value={note} onChange={setNote} hint={t('photosNoteHint')} />
      <p className="hint">{t('photosCount', { count: usable.length })}</p>
      <FormError message={error} />
      <button
        type="button"
        className="btn-primary"
        disabled={tx.phase === 'signing' || tx.phase === 'pending'}
        onClick={publish}
      >
        {t('photosPublish')}
      </button>
      <TxStatus state={tx} />
    </Panel>
  )
}
