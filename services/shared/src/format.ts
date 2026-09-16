import { encodeAbiParameters, formatUnits, type Hex, hexToString, keccak256, stringToHex } from 'viem'

/** Stablecoin base units → display string, e.g. 1234560000n → "1,234.56". */
export const formatAmount = (amount: bigint | string, decimals = 6, fractionDigits = 2): string => {
  const value = Number(formatUnits(BigInt(amount), decimals))
  return value.toLocaleString('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })
}

/** Category codes are keccak hashes on-chain; these are the ones the UI knows how to label. */
export const CATEGORIES = ['FOOD', 'SHELTER', 'MEDICAL', 'CASH', 'WATER', 'EDUCATION'] as const
export type CategoryLabel = (typeof CATEGORIES)[number]

export const categoryHash = (label: string): Hex => keccak256(stringToHex(label))

const CATEGORY_BY_HASH = new Map<string, string>(
  CATEGORIES.map((label) => [categoryHash(label).toLowerCase(), label]),
)

/** Reverses a category hash to its label, falling back to a short hash for unknown categories. */
export const categoryLabel = (hash: Hex): string =>
  CATEGORY_BY_HASH.get(hash.toLowerCase()) ?? `${hash.slice(0, 10)}…`

/**
 * Region codes are coarse ISO 3166-2 subdivisions packed into bytes32 (never GPS, never an address).
 * `bytes32("ES-CM")` round-trips back to "ES-CM".
 */
export const regionCode = (code: string): Hex => {
  if (code.length > 31) throw new Error('region code too long for bytes32')
  return `0x${Buffer.from(code, 'utf8').toString('hex').padEnd(64, '0')}` as Hex
}

export const regionLabel = (code: Hex): string => {
  try {
    return hexToString(code, { size: 32 }).replace(/\0+$/, '') || code
  } catch {
    return code
  }
}

/**
 * Salted hash for fiat references, byte-for-byte equal to Solidity's
 * `keccak256(abi.encode(bytes32 salt, string value))` — the raw reference never leaves the bank partner.
 */
export const saltedRefHash = (salt: Hex, value: string): Hex =>
  keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'string' }], [salt, value]))

export const shortAddress = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`

export const shortHex = (value: string, chars = 6): string =>
  `${value.slice(0, 2 + chars)}…${value.slice(-4)}`
