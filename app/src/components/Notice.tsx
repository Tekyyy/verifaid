import { useTranslations } from 'next-intl'
import type { ReactNode } from 'react'
import { chainId, indexerUrl, network } from '@/lib/config'
import type { IndexerError } from '@/lib/indexer'

export function Notice({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'warning' | 'error' | 'success'
  title: string
  children?: ReactNode
}) {
  const tones = {
    info: 'border-slate-300 bg-slate-100 text-slate-800',
    warning: 'border-amber-400 bg-amber-50 text-amber-900',
    error: 'border-red-400 bg-red-50 text-red-900',
    success: 'border-emerald-400 bg-emerald-50 text-emerald-900',
  } as const

  return (
    <div className={`rounded-md border p-4 ${tones[tone]}`} role={tone === 'error' ? 'alert' : undefined}>
      <p className="font-semibold">{title}</p>
      {children ? <div className="mt-1 text-sm">{children}</div> : null}
    </div>
  )
}

/** Shown wherever the indexer could not answer, so a reader never mistakes "offline" for "zero". */
export function IndexerNotice({ error }: { error: IndexerError }) {
  const t = useTranslations('errors')
  return (
    <Notice tone="warning" title={t('indexerTitle')}>
      <p>{t('indexerBody', { url: indexerUrl })}</p>
      <p className="mt-1 text-xs opacity-80">{t('indexerDetail', { detail: error.detail })}</p>
    </Notice>
  )
}

/** Shown when the build is locked to a network that has no bundled addresses. */
export function MissingDeployment() {
  const t = useTranslations('errors')
  return (
    <Notice tone="error" title={t('noDeploymentTitle')}>
      {t('noDeploymentBody', { chainId, network })}
    </Notice>
  )
}

export function EmptyState({ title, body }: { title: string; body?: string }) {
  return (
    <div className="card text-center">
      <p className="font-semibold text-slate-800">{title}</p>
      {body ? <p className="mt-1 text-sm text-slate-600">{body}</p> : null}
    </div>
  )
}
