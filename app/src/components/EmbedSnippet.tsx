'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import { useMounted } from '@/lib/mounted'

/** The copy-paste iframe for the chrome-less tracking widget, pointing at this deployment's own origin. */
export function EmbedSnippet({ trackingRef }: { trackingRef: string }) {
  const t = useTranslations('track')
  const locale = useLocale()
  const mounted = useMounted()
  const id = useId()
  const [copied, setCopied] = useState(false)

  const origin = mounted ? window.location.origin : ''
  const src = `${origin}/${locale}/embed/track/${encodeURIComponent(trackingRef)}`
  const snippet = `<iframe src="${src}" width="360" height="420" style="border:0" loading="lazy" title="Donation tracker"></iframe>`

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="space-y-2">
      <label className="label" htmlFor={id}>
        {t('embedSnippet')}
      </label>
      <textarea id={id} className="input font-mono text-xs" rows={4} readOnly value={snippet} />
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn-secondary text-xs" onClick={copy} aria-live="polite">
          {copied ? t('snippetCopied') : t('copySnippet')}
        </button>
        <a className="link text-xs" href={src} target="_blank" rel="noreferrer noopener">
          {t('previewWidget')}
        </a>
      </div>
    </div>
  )
}
