import type { CustodyMode } from '@poa/shared'
import { useTranslations } from 'next-intl'

const TONES: Record<CustodyMode, string> = {
  OnChain: 'bg-indigo-100 text-indigo-900',
  OffChain: 'bg-teal-100 text-teal-900',
}

/** "Model B · on-chain escrow" or "Model A · payment provider", optionally with its one-line explanation. */
export function CustodyBadge({ mode, explain = false }: { mode: CustodyMode; explain?: boolean }) {
  const t = useTranslations('custody')
  const badge = <span className={`badge ${TONES[mode]}`}>{t(mode)}</span>
  if (!explain) return badge
  return (
    <div>
      {badge}
      <p className="hint">{t(`${mode}Body`)}</p>
    </div>
  )
}
