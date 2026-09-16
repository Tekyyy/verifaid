import type { Hex } from 'viem'
import { shorten } from '@/lib/format'
import { addressUrl, attestationUrl, txUrl } from '@/lib/links'

type Kind = 'tx' | 'address' | 'attestation'

const resolve: Record<Kind, (value: string) => string | null> = {
  tx: (value) => txUrl(value as Hex),
  address: (value) => addressUrl(value),
  attestation: (value) => attestationUrl(value as Hex),
}

/**
 * Renders a link to the block explorer or the EAS explorer, degrading to plain monospace text on a network
 * that has no explorer (anvil) rather than producing a dead link.
 */
export function ExplorerLink({
  kind,
  value,
  label,
  className = '',
}: {
  kind: Kind
  value: string | null | undefined
  label?: string
  className?: string
}) {
  if (!value) return <span className="text-slate-500">—</span>
  const href = resolve[kind](value)
  const text = label ?? shorten(value, 10, 6)

  if (!href) {
    return (
      <span className={`font-mono text-xs text-slate-600 ${className}`} title={value}>
        {text}
      </span>
    )
  }

  return (
    <a
      className={`link font-mono text-xs ${className}`}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      title={value}
    >
      {text}
    </a>
  )
}
