/**
 * Money arithmetic for the provider, kept free of I/O so it can be tested exhaustively.
 *
 * Amounts on-chain are 6-decimal stablecoin base units; the provider's inputs are euro cents. Fees are capped by
 * the need's binding cost disclosure, which the resolver checks cumulatively after every attestation:
 *
 *   (fundingFees + settlementFees) * 10000 <= (ledger.totalDonated + fundingFees) * thirdPartyCostBps
 *
 * The provider never produces a fee that would make that check fail: whatever it charged above the cap it absorbs.
 */

export const BPS_DENOMINATOR = 10_000n

/** EUR cents → 6-decimal stablecoin base units. */
export const CENTS_TO_BASE_UNITS = 10_000n

export const centsToBaseUnits = (cents: number | bigint): bigint => BigInt(cents) * CENTS_TO_BASE_UNITS

/** Largest amount accepted from a person or a file: 999,999,999.99 EUR, far inside the registry's uint96 target. */
export const MAX_AMOUNT_CENTS = 99_999_999_999

const DECIMAL_EUR = /^(\d{1,9})(?:\.(\d{1,2}))?$/

/** "25", "25.5" or "25.00" → 2500 cents; null for anything else (signs, exponents, commas, a third decimal). */
export const parseEurAmount = (value: string): number | null => {
  const match = DECIMAL_EUR.exec(value.trim())
  if (!match) return null
  const units = Number(match[1])
  const fraction = Number((match[2] ?? '').padEnd(2, '0'))
  return units * 100 + fraction
}

/** Base units → "25.00", for messages a person reads. */
export const formatEur = (baseUnits: bigint): string => {
  const cents = baseUnits / CENTS_TO_BASE_UNITS
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`
}

/** Mock PSP card pricing: `bps` of the amount, rounded half-up to the cent, plus a fixed fee. */
export const cardFeeCents = (amountCents: number, bps: number, fixedCents: number): number =>
  Math.floor((amountCents * bps + 5_000) / 10_000) + fixedCents

export interface FeeState {
  /** `ledger.totalDonated()`: net amounts only. */
  totalDonated: bigint
  /** `resolver.fundingFeesOf(needId)`. */
  fundingFees: bigint
  /** `resolver.settlementFeesOf(needId)`. */
  settlementFees: bigint
}

const clampToZero = (value: bigint): bigint => (value < 0n ? 0n : value)

/**
 * Largest fee a new `FundingRecorded` for `gross` can carry, computed *before* the net amount reaches the ledger.
 * After the attestation both sides grow by the same `gross` (net into totalDonated, fee into fundingFees), so:
 *   fee <= floor((totalDonated + fundingFees + gross) * bps / 10000) - fundingFees - settlementFees
 */
export const maxFundingFee = (state: FeeState, costCapBps: number, gross: bigint): bigint =>
  clampToZero(
    ((state.totalDonated + state.fundingFees + gross) * BigInt(costCapBps)) / BPS_DENOMINATOR -
      state.fundingFees -
      state.settlementFees,
  )

/**
 * The same cap when the net amount is *already* counted in `totalDonated` (an on-chain deposit landed and the run
 * is resuming at the attestation). Only the fee is still free: fee * (10000 - bps) <= (D + F) * bps - (F + S) * 10000.
 */
export const maxFundingFeeAfterDeposit = (state: FeeState, costCapBps: number): bigint => {
  const bps = BigInt(costCapBps)
  const room =
    (state.totalDonated + state.fundingFees) * bps -
    (state.fundingFees + state.settlementFees) * BPS_DENOMINATOR
  if (room <= 0n) return 0n
  // The registry caps the disclosure at 20%, so the divisor is always positive; guard anyway.
  const divisor = BPS_DENOMINATOR - bps
  return divisor <= 0n ? room : room / divisor
}

/**
 * Largest fee a `Settlement` can carry. A payout moves nothing into totalDonated, so:
 *   fee <= floor((totalDonated + fundingFees) * bps / 10000) - fundingFees - settlementFees
 */
export const maxSettlementFee = (state: FeeState, costCapBps: number): bigint =>
  clampToZero(
    ((state.totalDonated + state.fundingFees) * BigInt(costCapBps)) / BPS_DENOMINATOR -
      state.fundingFees -
      state.settlementFees,
  )

/** The resolver's own check, for tests and for a last sanity check before sending a transaction. */
export const withinCostCap = (state: FeeState, costCapBps: number): boolean =>
  (state.fundingFees + state.settlementFees) * BPS_DENOMINATOR <=
  (state.totalDonated + state.fundingFees) * BigInt(costCapBps)

export const minBigInt = (...values: bigint[]): bigint =>
  values.reduce((low, value) => (value < low ? value : low))
