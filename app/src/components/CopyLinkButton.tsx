'use client'

import { useTranslations } from 'next-intl'
import { useState } from 'react'

/** Copies the page URL (without any fragment) so a donor can share or bookmark their tracking link. */
export function CopyLinkButton({ className = 'btn-secondary text-xs' }: { className?: string }) {
  const t = useTranslations('track')
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      const url = new URL(window.location.href)
      url.hash = ''
      await navigator.clipboard.writeText(url.toString())
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <button type="button" className={className} onClick={copy} aria-live="polite">
      {copied ? t('linkCopied') : t('copyLink')}
    </button>
  )
}
