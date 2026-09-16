import { formatAmount } from '@poa/shared'
import { TOKEN_DECIMALS } from './config'

/** Token base units → "1,234.56". */
export const amount = (value: bigint | string | null | undefined): string =>
  value === null || value === undefined ? '0.00' : formatAmount(value, TOKEN_DECIMALS)

/** Parses a user-typed decimal amount into base units; returns null when it is not a valid amount. */
export const parseAmount = (input: string): bigint | null => {
  const trimmed = input.trim().replace(',', '.')
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) return null
  const [whole = '0', fraction = ''] = trimmed.split('.')
  return BigInt(whole) * 10n ** BigInt(TOKEN_DECIMALS) + BigInt(fraction.padEnd(TOKEN_DECIMALS, '0'))
}

export const percent = (numerator: bigint | string, denominator: bigint | string): number => {
  const bottom = BigInt(denominator)
  if (bottom === 0n) return 0
  const top = BigInt(numerator)
  return Math.min(100, Number((top * 10_000n) / bottom) / 100)
}

export const ratioPercent = (ratio: number): number => Math.min(100, Math.max(0, Math.round(ratio * 100)))

/**
 * Deterministic UTC timestamp. Server and client render the identical string, so there is no hydration
 * mismatch and an auditor reading the page always sees the same instant regardless of their machine.
 */
export const timestamp = (seconds: number | null | undefined): string => {
  if (!seconds) return '—'
  const date = new Date(seconds * 1000)
  const pad = (value: number) => String(value).padStart(2, '0')
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  )
}

export const shorten = (value: string, head = 6, tail = 4): string =>
  value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`
