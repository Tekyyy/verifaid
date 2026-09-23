import type { DonationTrack, OrgTaxStatusView, TrackingRefKind } from '@poa/shared'

/**
 * When a donation to a need can be deducted, and in which country. Two regimes are modelled, and only when the
 * platform admin has checked the organisation's claim against the public register:
 *
 * - **US_501C3** — a US public charity (IRC §170(c)(2)). Both digital assets and cash qualify; digital assets
 *   are non-cash property (Form 8283 above $500, qualified appraisal above $5,000).
 * - **SG_IPC** — a Singapore Institution of a Public Character. IRAS lists the donation types that qualify
 *   (cash, listed shares, and a few others); digital payment tokens are not among them, so only money given
 *   through the payment provider counts. The IPC reports it to IRAS against the donor's NRIC/FIN/UEN.
 *
 * The designation travels in the `jurisdiction` field of the `OrgTaxStatus` attestation as `COUNTRY:DESIGNATION`
 * (`US:501c3`, `SG:IPC`). A bare country code says where an organisation is registered, not that gifts to it
 * are deductible, so it never makes a need eligible.
 */

export type TaxRegime = 'US_501C3' | 'SG_IPC'

/** How the money reached the need: a digital asset (wallet, card on-ramp, exchange) or cash through a provider. */
export type DonationChannel = 'digital' | 'cash'

export const TAX_DESIGNATIONS: Record<TaxRegime, string> = { US_501C3: 'US:501c3', SG_IPC: 'SG:IPC' }

/**
 * The ways this platform takes money. Tokens only: a card goes through the Coinbase on-ramp, which buys USDC
 * into the donor's own wallet before anything is given, so even a card payment arrives as a digital asset. The
 * model above still knows about cash because the law does, and because a payment reference already on chain
 * is still a cash gift; nothing new can be given that way.
 */
export const OFFERED_CHANNELS: readonly DonationChannel[] = ['digital']

/** True when some way this platform takes money makes a gift to this organisation deductible. */
export const deductibleHere = (status: OrgTaxStatusView | null | undefined): boolean =>
  OFFERED_CHANNELS.some((channel) => isEligible(status, channel))

const REGIME_CHANNELS: Record<TaxRegime, readonly DonationChannel[]> = {
  US_501C3: ['digital', 'cash'],
  SG_IPC: ['cash'],
}

export const parseJurisdiction = (raw: string): { country: string; designation: string } => {
  const [country = '', designation = ''] = raw.trim().split(':')
  return { country: country.trim().toUpperCase(), designation: designation.trim() }
}

/** The regime a verified organisation falls under, or null when a gift to it is not known to be deductible. */
export const regimeOf = (status: OrgTaxStatusView | null | undefined): TaxRegime | null => {
  if (!status?.verified) return null
  const value = status.jurisdiction.trim().toUpperCase()
  for (const regime of Object.keys(TAX_DESIGNATIONS) as TaxRegime[]) {
    if (TAX_DESIGNATIONS[regime].toUpperCase() === value) return regime
  }
  return null
}

export const eligibleChannels = (regime: TaxRegime | null): readonly DonationChannel[] =>
  regime ? REGIME_CHANNELS[regime] : []

export const isEligible = (status: OrgTaxStatusView | null | undefined, channel: DonationChannel): boolean =>
  eligibleChannels(regimeOf(status)).includes(channel)

/** A payment reference is money a provider took by card or bank; receipts and deposit addresses are tokens. */
export const channelOfRef = (kind: TrackingRefKind): DonationChannel =>
  kind === 'payment' ? 'cash' : 'digital'

/** IRAS has allowed 250% on qualifying donations since 2016; the current extension ends on 31 Dec 2026. */
const SG_ENHANCED_UNTIL = Date.UTC(2027, 0, 1) / 1000

/** The Singapore deduction rate in percent for a donation made at `at`, or null when it is not known here. */
export const sgDeductionRate = (at: number): number | null => (at < SG_ENHANCED_UNTIL ? 250 : null)

export type DeductionAssessment =
  /** The organisation is not a verified 501(c)(3) or IPC. */
  | { kind: 'none' }
  /** The organisation is eligible, but not for money given this way (a token donation to an IPC). */
  | { kind: 'channel'; regime: TaxRegime; channel: DonationChannel }
  /** Funding is still open: the donor can take it back, so it is not yet a completed gift. */
  | { kind: 'revocable'; regime: TaxRegime; channel: DonationChannel }
  /** Nothing of it stayed with the organisation: withdrawn, refunded or refundable. */
  | { kind: 'returned'; regime: TaxRegime; channel: DonationChannel }
  | {
      kind: 'deductible'
      regime: TaxRegime
      channel: DonationChannel
      /** Base units that stayed with the organisation. */
      amount: bigint
      /** True when part of the donation was, or will be, given back. */
      partial: boolean
      /** When it became irrevocable: funding closed. */
      since: number
      /** Calendar year of `since` (UTC). Singapore assesses it in the following Year of Assessment. */
      taxYear: number
    }

type AssessInput = Pick<DonationTrack, 'refKind' | 'donation' | 'stages' | 'outcome' | 'releasedToNgo'> & {
  need: Pick<DonationTrack['need'], 'taxStatus'>
}

const RETURNING: readonly DonationTrack['outcome'][] = ['Refundable', 'Refunded', 'Expired', 'Cancelled']

/**
 * A gift the donor can still recall is conditional, and a conditional gift is not deductible until the
 * condition lapses. Here that is the moment funding closes; before it the donor may withdraw, and a need that
 * never reaches its minimum refunds everyone.
 */
export const assessDonation = (track: AssessInput): DeductionAssessment => {
  const regime = regimeOf(track.need.taxStatus)
  if (!regime) return { kind: 'none' }
  const channel = channelOfRef(track.refKind)
  if (!eligibleChannels(regime).includes(channel)) return { kind: 'channel', regime, channel }

  const funded = track.stages.find((stage) => stage.stage === 'Funded')
  const given = BigInt(track.donation.amount)

  if (RETURNING.includes(track.outcome)) {
    // Only what was already paid out for the need stays given; the rest comes back to the donor.
    const kept = BigInt(track.releasedToNgo)
    if (kept === 0n || !funded?.reached || funded.at === null) return { kind: 'returned', regime, channel }
    return deductible(regime, channel, kept < given ? kept : given, kept < given, funded.at)
  }
  if (given === 0n) return { kind: 'returned', regime, channel }
  if (!funded?.reached || funded.at === null) return { kind: 'revocable', regime, channel }
  return deductible(regime, channel, given, false, funded.at)
}

const deductible = (
  regime: TaxRegime,
  channel: DonationChannel,
  amount: bigint,
  partial: boolean,
  since: number,
): DeductionAssessment => ({
  kind: 'deductible',
  regime,
  channel,
  amount,
  partial,
  since,
  taxYear: new Date(since * 1000).getUTCFullYear(),
})
