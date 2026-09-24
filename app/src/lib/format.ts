import { formatAmount } from '@poa/shared'
import { TOKEN_DECIMALS } from './config'

/** Token base units → "1,234.56". */
export const amount = (value: bigint | string | null | undefined): string =>
  value === null || value === undefined ? '0.00' : formatAmount(value, TOKEN_DECIMALS)

/** Parses a user-typed decimal amount into base units; returns null when it is not a valid amount. */
export const parseAmount = (input: string): bigint | null => parseTokenAmount(input, TOKEN_DECIMALS)

/** `parseAmount` for a token with any number of decimals (ETH has 18). */
export const parseTokenAmount = (input: string, decimals: number): bigint | null => {
  const trimmed = input.trim().replace(',', '.')
  if (!new RegExp(`^\\d{1,30}(\\.\\d{1,${decimals}})?$`).test(trimmed)) return null
  const [whole = '0', fraction = ''] = trimmed.split('.')
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0'))
}

/** Base units of any token → display string; ETH keeps six fraction digits, where two would round small gifts to 0. */
export const tokenAmount = (value: bigint | string | null | undefined, decimals: number): string =>
  value === null || value === undefined
    ? '0.00'
    : formatAmount(value, decimals, decimals > TOKEN_DECIMALS ? 6 : 2)

/** Decimals of a token by the symbol the indexer reports: ETH has 18, every stablecoin here has 6. */
export const decimalsOfSymbol = (symbol: string): number => (symbol === 'ETH' ? 18 : TOKEN_DECIMALS)

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

/** ipfs:// is not a browser scheme, so a public gateway is how a page shows one. */
const IPFS_GATEWAY = 'https://ipfs.io/ipfs/'

export const imageSrc = (url: string): string =>
  url.startsWith('ipfs://') ? `${IPFS_GATEWAY}${url.slice('ipfs://'.length)}` : url

export const shorten = (value: string, head = 6, tail = 4): string =>
  value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`

/** Basis points → a compact percentage string: 10000 → "100", 250 → "2.5". */
export const bpsPercent = (bps: number | bigint): string => String(Number((Number(bps) / 100).toFixed(2)))

/** Share of `part` in `whole`, in basis points (0 when `whole` is zero). */
export const bpsOf = (part: bigint | string, whole: bigint | string): number => {
  const bottom = BigInt(whole)
  return bottom === 0n ? 0 : Number((BigInt(part) * 10_000n) / bottom)
}

const CATEGORY_ICONS: Record<string, string> = {
  FOOD: '🥫',
  SHELTER: '🏠',
  MEDICAL: '🩺',
  CASH: '💶',
  WATER: '💧',
  EDUCATION: '📚',
}

/** A small picture for a need category ("FOOD" → 🥫), so a list of needs can be scanned before it is read. */
export const categoryIcon = (category: string): string => CATEGORY_ICONS[category.toUpperCase()] ?? '📦'

/** ISO 3166-1 alpha-2 code → flag emoji ("ES" → 🇪🇸); empty for anything that is not two ASCII letters. */
export const flagEmoji = (country: string): string =>
  /^[A-Za-z]{2}$/.test(country)
    ? String.fromCodePoint(...[...country.toUpperCase()].map((letter) => 0x1f1e6 + letter.charCodeAt(0) - 65))
    : ''

/**
 * A `<input type="date">` value → unix seconds at the end of that day in UTC, so "the deadline is the 30th"
 * means the whole of the 30th everywhere. Empty input is "no deadline" (0).
 */
export const dateInputToUnix = (value: string): number | null => {
  if (!value) return 0
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const millis = Date.parse(`${value}T23:59:59Z`)
  return Number.isNaN(millis) ? null : Math.floor(millis / 1000)
}

export const isBytes32 = (value: string): boolean => /^0x[0-9a-fA-F]{64}$/.test(value)

export const ZERO_BYTES32 = `0x${'00'.repeat(32)}` as const

export const isZeroHash = (value: string | null | undefined): boolean => !value || /^0x0{64}$/i.test(value)
