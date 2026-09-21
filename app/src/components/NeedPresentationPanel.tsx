'use client'

import { easAbi } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import type { Address } from 'viem'
import { FormError, Panel, TextArea, TextField } from '@/components/form'
import { TxStatus } from '@/components/TxStatus'
import { deployment } from '@/lib/config'
import { communityAttestationRequest, hasCommunitySchema } from '@/lib/eas'
import { imageSrc } from '@/lib/format'
import { useTx } from '@/lib/hooks'

const MAX_TAGS = 5
const MAX_GALLERY = 12

/**
 * How a need looks to a donor: a cover image, a sentence, a few tags, more images. It is an attestation the
 * NGO signs, so it is attributable and dated — and it is deliberately separate from the need's terms, which
 * were fixed and verified at creation. Publishing again replaces it, so a presentation can be improved without
 * touching a single number donors were promised.
 */
export function NeedPresentationPanel() {
  const t = useTranslations('ngo')
  const tx = useTx()
  const [needId, setNeedId] = useState('')
  const [cover, setCover] = useState('')
  const [summary, setSummary] = useState('')
  const [tags, setTags] = useState('')
  const [gallery, setGallery] = useState('')
  const [error, setError] = useState<string | null>(null)

  if (!hasCommunitySchema('NeedPresentation')) return null

  const isImage = (url: string) => /^(https:\/\/|ipfs:\/\/)/i.test(url)
  const galleryUrls = gallery
    .split(/[\s,]+/)
    .map((url) => url.trim())
    .filter(Boolean)
  const tagList = tags
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)

  const publish = async () => {
    if (!/^\d+$/.test(needId)) return setError(t('photosErrorNeed'))
    if (cover.trim() && !isImage(cover.trim())) return setError(t('photosErrorUrls'))
    if (galleryUrls.some((url) => !isImage(url))) return setError(t('photosErrorUrls'))
    if (galleryUrls.length > MAX_GALLERY) return setError(t('photosErrorCount', { max: MAX_GALLERY }))
    if (tagList.length > MAX_TAGS) return setError(t('presentationErrorTags', { max: MAX_TAGS }))
    setError(null)
    await tx.run({
      address: deployment?.external.EAS as Address,
      abi: easAbi,
      functionName: 'attest',
      args: [
        communityAttestationRequest('NeedPresentation', [
          BigInt(needId),
          cover.trim(),
          galleryUrls,
          summary.trim(),
          tagList,
        ]),
      ],
    })
  }

  return (
    <Panel title={t('presentationTitle')} description={t('presentationBody')}>
      <TextField label={t('needId')} value={needId} onChange={setNeedId} inputMode="numeric" />
      <TextField
        label={t('presentationCover')}
        value={cover}
        onChange={setCover}
        placeholder="https://…"
        hint={t('presentationCoverHint')}
      />
      {cover.trim() && isImage(cover.trim()) ? (
        // biome-ignore lint/performance/noImgElement: a preview of a link the NGO just typed
        <img
          src={imageSrc(cover.trim())}
          alt=""
          className="h-40 w-full rounded-md border border-slate-200 object-cover"
          referrerPolicy="no-referrer"
        />
      ) : null}
      <TextArea
        label={t('presentationSummary')}
        value={summary}
        onChange={setSummary}
        rows={3}
        hint={t('presentationSummaryHint')}
      />
      <TextField
        label={t('presentationTags')}
        value={tags}
        onChange={setTags}
        placeholder={t('presentationTagsPlaceholder')}
        hint={t('presentationTagsHint', { max: MAX_TAGS })}
      />
      <TextArea
        label={t('presentationGallery')}
        value={gallery}
        onChange={setGallery}
        rows={2}
        hint={t('presentationGalleryHint')}
      />

      <FormError message={error} />
      <button
        type="button"
        className="btn-primary"
        disabled={tx.phase === 'signing' || tx.phase === 'pending'}
        onClick={publish}
      >
        {t('presentationPublish')}
      </button>
      <TxStatus state={tx} />
      <p className="hint">{t('presentationReplaces')}</p>
    </Panel>
  )
}
