'use client'

import { useTranslations } from 'next-intl'
import { ExplorerLink } from '@/components/ExplorerLink'
import type { TxState } from '@/lib/hooks'

const TONE: Record<TxState['phase'], string> = {
  idle: 'text-slate-500',
  signing: 'text-amber-800',
  pending: 'text-amber-800',
  success: 'text-emerald-800',
  failed: 'text-red-800',
}

/** Pending / success / error for one on-chain action, always with a link to the transaction. */
export function TxStatus({ state }: { state: TxState }) {
  const t = useTranslations('tx')
  if (state.phase === 'idle') return null

  return (
    <p className={`mt-2 flex flex-wrap items-center gap-2 text-xs ${TONE[state.phase]}`} aria-live="polite">
      <span className="font-semibold">{t(state.phase)}</span>
      {state.sponsored ? (
        <span className="badge bg-emerald-100 text-emerald-900" title={t('sponsoredHint')}>
          {t('sponsored')}
        </span>
      ) : null}
      {state.hash ? (
        <span className="flex items-center gap-1">
          <span>{t('hash')}</span>
          <ExplorerLink kind="tx" value={state.hash} />
        </span>
      ) : null}
      {state.error ? <span className="break-all">{state.error}</span> : null}
    </p>
  )
}
