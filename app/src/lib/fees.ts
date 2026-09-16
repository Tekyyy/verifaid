import { TOKEN_DECIMALS } from './config'

/**
 * Fee estimate for the sandbox checkout. It mirrors the bank connector's mock pricing so a donor sees the same
 * split before paying that the payment provider later attests: card 1.4% + €0.25, SEPA transfer free.
 * The attested figures are authoritative; this is only what the form shows beforehand.
 */

export const PAYMENT_METHODS = ['card', 'bank'] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]

const UNIT = 10n ** BigInt(TOKEN_DECIMALS)

const CARD_PERCENT_BPS = 140n
const CARD_FIXED = UNIT / 4n

export const estimateFee = (method: PaymentMethod, gross: bigint): bigint => {
  if (method === 'bank' || gross <= 0n) return 0n
  const fee = (gross * CARD_PERCENT_BPS + 5_000n) / 10_000n + CARD_FIXED
  return fee > gross ? gross : fee
}

/** True when `fee` stays within the need's disclosed cap on third-party costs. */
export const feeWithinCap = (fee: bigint, gross: bigint, capBps: number): boolean =>
  fee * 10_000n <= gross * BigInt(capBps)

/** Parses a euro amount typed by a donor (at most two decimals) into base units; null when invalid. */
export const parseEuro = (input: string): { decimal: string; units: bigint } | null => {
  const trimmed = input.trim().replace(',', '.')
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(trimmed)) return null
  const [whole = '0', fraction = ''] = trimmed.split('.')
  const units = BigInt(whole) * UNIT + BigInt(fraction.padEnd(TOKEN_DECIMALS, '0'))
  if (units <= 0n) return null
  return { decimal: `${BigInt(whole).toString()}.${fraction.padEnd(2, '0')}`, units }
}
