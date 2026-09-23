import type { DonationTrack } from '@poa/shared'
import { amount, timestamp } from '@/lib/format'
import { PdfReport } from '@/lib/pdf'
import {
  assessDonation,
  type DeductionAssessment,
  parseJurisdiction,
  sgDeductionRate,
} from '@/lib/taxEligibility'

/**
 * The document a donor gives their accountant, built in the browser so the donor's own name and address
 * never reach a server or a chain. What it says about deductibility comes from `assessDonation`: which regime
 * the organisation is verified under (US 501(c)(3) or Singapore IPC), how the money was given, and whether the
 * gift is complete yet.
 *
 * For a US donor it is a *contemporaneous written acknowledgment* in the §170(f)(8) sense only when the donee
 * has signed one on chain; this document quotes it. A Singapore donor needs no receipt at all: the IPC reports
 * the donation to IRAS against the donor's NRIC/FIN, so this is a record, not a claim form.
 *
 * What this is not: advice that a contribution is deductible for this donor. The document says so.
 */

/** What the organisation signs, and what this document quotes back. Kept identical on both sides. */
export const acknowledgmentStatement = (input: {
  legalName: string
  taxId: string
  amount: string
  unit: string
  date: string
  txHash: string
}): string =>
  `${input.legalName} acknowledges receiving a contribution of ${input.amount} ${input.unit} on ${input.date}, ` +
  `transferred on-chain in transaction ${input.txHash}. No goods or services were provided in exchange for ` +
  `this contribution. Tax identification number: ${input.taxId}.`

export interface TaxReceiptInput {
  track: DonationTrack
  unit: string
  /** Typed by the donor in their own browser, for this document only. */
  donorName: string
  donorAddress: string
  /** Where the dashboard lives, so an auditor can re-check every figure. */
  trackingUrl: string
  explorerTxUrl: string
  explorerAttestationUrl: string | null
  /**
   * The block explorer's own pages. A reviewer who trusts none of this document can start at `explorerNftUrl`:
   * it names the wallet holding the receipt token and renders the token's own on-chain metadata.
   */
  receiptContract: string | null
  explorerNftUrl: string | null
  explorerReceiptReadUrl: string | null
  explorerVaultReadUrl: string | null
}

const REGIME_NAME = { US_501C3: 'United States', SG_IPC: 'Singapore' } as const

/** One sentence per outcome, the same wording the tracking page shows. */
export const assessmentSentence = (assessment: DeductionAssessment, unit: string): string => {
  switch (assessment.kind) {
    case 'none':
      return (
        'This organisation is not a platform-verified US 501(c)(3) or Singapore Institution of a Public ' +
        'Character, so this document makes no statement that the donation is deductible.'
      )
    case 'channel':
      return (
        'Not deductible in Singapore: a donation of digital tokens is not a qualifying donation type under ' +
        'IRAS rules, and this platform takes no cash: a card payment buys USDC first, which is a digital token too.'
      )
    case 'revocable':
      return (
        'Not deductible yet. Funding for this need is still open and the donor can take this donation back, ' +
        'so it is not yet a completed gift. It becomes one when funding closes; download this receipt again ' +
        'after that date for the final version.'
      )
    case 'returned':
      return 'Not deductible: this donation was returned to the donor (withdrawn or refunded).'
    case 'deductible': {
      const where = REGIME_NAME[assessment.regime]
      const base =
        `Deductible in ${where}, subject to the donor's own circumstances: ${amount(assessment.amount)} ` +
        `${unit}, a completed gift since ${timestamp(assessment.since)}, when funding for this need closed and ` +
        'the donation could no longer be taken back.'
      return assessment.partial
        ? `${base} Only the part already paid out for the need counts; the rest is refunded to the donor.`
        : base
    }
  }
}

export const renderTaxReceipt = async (input: TaxReceiptInput): Promise<Uint8Array> => {
  const { track, unit, donorName, donorAddress } = input
  const tax = track.need.taxStatus
  const ack = track.acknowledgment
  const donation = track.donation
  const date = timestamp(donation.timestamp)
  const receiptId = donation.receiptId ?? track.ref
  const assessment = assessDonation(track)
  const regime = assessment.kind === 'none' ? null : assessment.regime
  const done = assessment.kind === 'deductible' ? assessment : null

  const report = await PdfReport.create({
    title: `Donation receipt - ${track.ref}`,
    subject: 'Charitable contribution acknowledgment',
  })

  report.title(
    'Donation receipt',
    tax
      ? `${tax.legalName}${tax.taxId ? ` - ${parseJurisdiction(tax.jurisdiction).country} tax id ${tax.taxId}` : ''}`
      : track.need.ngo,
  )

  report.keyValues([
    ['Donor', donorName || '(not stated)'],
    ['Donor address', donorAddress || '(not stated)'],
    ['Date of contribution', date],
    ['Amount', `${amount(donation.amount)} ${unit}`],
    ['Form of contribution', `${unit} (a digital asset), transferred on-chain`],
    ['Donor wallet (holds the receipt)', donation.donor ?? '-'],
    ['Transferred to', track.need.vault ?? '-'],
    ['Transaction', donation.txHash],
    ['Need', `#${track.need.id} - ${track.need.categoryLabel}, ${track.need.regionLabel}`],
    ...(donation.receiptId
      ? ([['Receipt token', `#${donation.receiptId} (soulbound; non-transferable, no market value)`]] as [
          string,
          string,
        ][])
      : []),
    ...(done || assessment.kind === 'revocable'
      ? ([['Completed gift on', done ? timestamp(done.since) : 'Not yet - see below']] as [string, string][])
      : []),
    ...(done && done.regime === 'US_501C3'
      ? ([['US tax year', String(done.taxYear)]] as [string, string][])
      : []),
    ...(done && done.regime === 'SG_IPC'
      ? ([['Singapore Year of Assessment', String(done.taxYear + 1)]] as [string, string][])
      : []),
    ...(done?.partial
      ? ([['Deductible amount', `${amount(done.amount)} ${unit}`]] as [string, string][])
      : []),
  ])

  report.heading('Deductibility')
  report.paragraph(assessmentSentence(assessment, unit))

  report.heading('Tax standing of the organisation')
  if (tax) {
    report.keyValues([
      ['Legal name', tax.legalName],
      [
        'Designation',
        regime === 'US_501C3'
          ? 'United States - 501(c)(3) public charity'
          : regime === 'SG_IPC'
            ? 'Singapore - Institution of a Public Character (IPC)'
            : `${tax.jurisdiction} - not a designation this platform treats as deductible`,
      ],
      [regime === 'SG_IPC' ? 'UEN' : 'Tax identification number', tax.taxId],
      ['Stated source', tax.source],
      [
        'Checked by the platform',
        tax.verified
          ? `Yes - ${tax.verifiedSource ?? ''} (${tax.verifiedAt ? timestamp(tax.verifiedAt) : ''})`
          : 'No - this is the organisation own statement, not checked by anyone here',
      ],
    ])
  } else {
    report.paragraph('This organisation has published no tax standing.')
  }

  if (regime === 'SG_IPC') {
    renderSingapore(report, assessment, donation.timestamp, ack, input.explorerAttestationUrl)
  } else {
    renderUnitedStates(report, { regime, ack, explorerAttestationUrl: input.explorerAttestationUrl })
  }

  report.heading('How to verify every figure above')
  report.paragraph(
    'Every number in this document comes from public blockchain events, not from this organisation or from ' +
      'the platform. Nothing below has to be taken on trust: a block explorer is an independent third party, ' +
      'and the links open the records themselves.',
  )
  if (input.explorerNftUrl) {
    report.paragraph(
      `The receipt is token #${receiptId} of the contract at ${input.receiptContract}. Opening it in the ` +
        'explorer shows the wallet that holds it, the transaction that minted it, and the metadata the ' +
        'token carries itself, which states the need it belongs to and the amount: ' +
        `${amount(donation.amount)} ${unit}. ` +
        'The token is soulbound - it implements ERC-5192, and every transfer other than the mint reverts - so ' +
        'the holder cannot have bought it from anyone. The wallet holding it is the wallet that paid.',
    )
  }
  report.keyValues([
    ...(input.explorerNftUrl
      ? ([['Receipt token, in the explorer', input.explorerNftUrl]] as [string, string][])
      : []),
    ['Tracking page', input.trackingUrl],
    ['Transaction', input.explorerTxUrl],
  ])
  const walletRows = Boolean(donation.receiptId && input.explorerReceiptReadUrl)
  const vaultRows = Boolean(donation.donor && input.explorerVaultReadUrl)
  if (walletRows || vaultRows) {
    report.paragraph(
      'An explorer renders token metadata from a cached copy, so read the contracts directly for the figure ' +
        'of record. On the "Read Contract" tab of each address below, anyone can call these without a wallet, ' +
        'an account or any permission:',
    )
    report.keyValues([
      ...(walletRows
        ? ([
            ['Receipt contract', input.explorerReceiptReadUrl],
            [`  ownerOf(${receiptId})`, 'the wallet holding this receipt today'],
            [
              `  receiptOf(${receiptId})`,
              'the need id, the amount still standing behind this receipt, and the donor',
            ],
            [`  locked(${receiptId})`, 'true - the token cannot be transferred or sold'],
          ] as [string, string][])
        : []),
      ...(vaultRows
        ? ([
            ['Vault holding the money', input.explorerVaultReadUrl],
            [
              '  donatedBy(donor wallet)',
              `called with ${donation.donor ?? 'the donor wallet'}: everything this wallet has given to this ` +
                'need, net of anything it took back',
            ],
            ['  totalDonated()', 'what the need has raised in total, which this contribution is part of'],
          ] as [string, string][])
        : []),
    ])
    report.paragraph(
      'Amounts are in base units: divide by 1,000,000 to read them, because this token has six decimals. If ' +
        'part of the contribution was taken back before the need closed, the receipt was reduced rather than ' +
        'burned, and these functions return the reduced figure - which is the deductible one.',
    )
  }

  report.paragraph(
    'This document is a record of a transaction and of what the donee signed. It is not tax advice, and ' +
      'whether this contribution is deductible for you depends on your own circumstances. Speak to a tax ' +
      'professional.',
  )

  return report.finish('VerifAid - every figure in this document is verifiable on-chain')
}

const renderUnitedStates = (
  report: PdfReport,
  input: {
    regime: 'US_501C3' | null
    ack: DonationTrack['acknowledgment']
    explorerAttestationUrl: string | null
  },
): void => {
  const { ack } = input
  report.heading('Acknowledgment by the donee')
  if (ack) {
    report.paragraph(ack.statement)
    report.keyValues([
      ['Signed by', ack.ngo],
      ['Signed at', timestamp(ack.timestamp)],
      ['Attestation', ack.uid],
      ['Document hash', ack.documentHash],
      ...(input.explorerAttestationUrl
        ? [['Verify at', input.explorerAttestationUrl] as [string, string]]
        : []),
    ])
  } else {
    report.paragraph(
      'This organisation has not signed an acknowledgment for this contribution yet. For a contribution of ' +
        '$250 or more, US donors are required to hold a contemporaneous written acknowledgment from the donee, ' +
        'obtained before they file. Ask the organisation to sign one; it will then appear here and on the ' +
        'public tracking page.',
    )
  }

  if (!input.regime) return

  report.heading('What your accountant will ask (United States)')
  report.paragraph(
    'A donation of a digital asset is a non-cash contribution of property, including when the asset was bought ' +
      'by card moments before: the card bought USDC, and the USDC was given. Above 500 US dollars it is ' +
      'reported on Form 8283, Section A. Above 5,000 US dollars the IRS has required a qualified appraisal ' +
      'and a donee signature on Form 8283, Section B; an exchange price is not a substitute for one. The ' +
      'deductible amount depends on how long you held the asset and on your basis in it, neither of which is ' +
      'recorded here; USDC bought just before giving was held briefly, and its basis is what you paid for it. ' +
      'A non-cash contribution is not covered by the deduction for donors who do not itemize.',
  )
}

const renderSingapore = (
  report: PdfReport,
  assessment: DeductionAssessment,
  donatedAt: number,
  ack: DonationTrack['acknowledgment'],
  explorerAttestationUrl: string | null,
): void => {
  report.heading('How the deduction works in Singapore')
  if (assessment.kind === 'channel') {
    report.paragraph(
      'IRAS grants a deduction for specific donation types: cash (including card, bank transfer and ' +
        'PayNow), shares listed in Singapore, and a few others. Digital payment tokens are not among them, so ' +
        'this donation is a record of giving, not a deductible donation. Paying by card on this platform does ' +
        'not change that: the card buys USDC before anything is given. To give deductibly, give to the ' +
        'organisation directly, outside this platform.',
    )
    return
  }
  const rate = sgDeductionRate(donatedAt)
  report.paragraph(
    rate
      ? `A qualifying cash donation to an IPC is deducted at ${rate}% of its amount from your assessable ` +
          'income, for donations made up to 31 December 2026.'
      : 'A qualifying cash donation to an IPC is deductible; check the rate that applies with IRAS.',
  )
  report.paragraph(
    'You do not claim it yourself and do not need to send this document to anyone. The organisation reports ' +
      'the donation to IRAS against your NRIC, FIN or UEN, and IRAS includes it in your assessment for the ' +
      'following Year of Assessment. That only happens if the organisation has your number: give it to them ' +
      'directly. This platform never collects it. If the deduction is missing from your assessment, ask the ' +
      'organisation to report it.',
  )
  report.paragraph('No deduction is allowed if you received a benefit in return for the donation.')
  if (ack) {
    report.paragraph(`The organisation signed, on chain: ${ack.statement}`)
    report.keyValues([
      ['Attestation', ack.uid],
      ...(explorerAttestationUrl ? [['Verify at', explorerAttestationUrl] as [string, string]] : []),
    ])
  }
}
