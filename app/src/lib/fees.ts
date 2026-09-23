import { TOKEN_DECIMALS } from './config'

const UNIT = 10n ** BigInt(TOKEN_DECIMALS)

/**
 * Parses a euro amount typed by a donor (at most two decimals) into base units; null when invalid. The card
 * on-ramp is priced in euros: the donor pays Coinbase in euros and the need receives the USDC it buys.
 */
export const parseEuro = (input: string): { decimal: string; units: bigint } | null => {
  const trimmed = input.trim().replace(',', '.')
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(trimmed)) return null
  const [whole = '0', fraction = ''] = trimmed.split('.')
  const units = BigInt(whole) * UNIT + BigInt(fraction.padEnd(TOKEN_DECIMALS, '0'))
  if (units <= 0n) return null
  return { decimal: `${BigInt(whole).toString()}.${fraction.padEnd(2, '0')}`, units }
}
