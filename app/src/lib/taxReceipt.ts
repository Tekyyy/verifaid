import type { DonationTrack } from '@poa/shared'
import { amount, timestamp } from '@/lib/format'
import { PdfReport } from '@/lib/pdf'

/**
 * The document a US donor gives their accountant, built in the browser so the donor's own name and address
 * never reach a server or a chain.
 *
 * It is a *contemporaneous written acknowledgment* in the IRS sense only when the donee organisation has
 * signed one on chain: that signature is what §170(f)(8) asks for, and this document quotes it, along with the
 * attestation that carries it. Everything else here is copied from events anyone can verify.
 *
 * What this is not: advice that a contribution is deductible. That depends on the organisation's standing and
 * on the donor — their holding period, their basis, their own return. The document says so, in those words.
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
}

export const renderTaxReceipt = async (input: TaxReceiptInput): Promise<Uint8Array> => {
  const { track, unit, donorName, donorAddress } = input
  const tax = track.need.taxStatus
  const ack = track.acknowledgment
  const donation = track.donation
  const date = timestamp(donation.timestamp)

  const report = await PdfReport.create({
    title: `Donation receipt - ${track.ref}`,
    subject: 'Charitable contribution acknowledgment',
  })

  report.title(
    'Donation receipt',
    tax ? `${tax.legalName}${tax.taxId ? ` - ${tax.jurisdiction} tax id ${tax.taxId}` : ''}` : track.need.ngo,
  )

  report.keyValues([
    ['Donor', donorName || '(not stated)'],
    ['Donor address', donorAddress || '(not stated)'],
    ['Date of contribution', date],
    ['Amount', `${amount(donation.amount)} ${unit}`],
    ['Form of contribution', `${unit} (a digital asset), transferred on-chain`],
    ['Transferred to', track.need.vault ?? '-'],
    ['Transaction', donation.txHash],
    ['Need', `#${track.need.id} - ${track.need.categoryLabel}, ${track.need.regionLabel}`],
    ['Receipt token', `#${track.ref} (soulbound; non-transferable, no market value)`],
  ])

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
        '$250 or more, US donors are required to hold a contemporaneous written acknowledgment from the donee. ' +
        'Ask the organisation to sign one; it will then appear here and on the public tracking page.',
    )
  }

  report.heading('Tax standing of the organisation')
  if (tax) {
    report.keyValues([
      ['Legal name', tax.legalName],
      ['Jurisdiction', tax.jurisdiction],
      ['Tax identification number', tax.taxId],
      ['Stated source', tax.source],
      [
        'Checked by the platform',
        tax.verified
          ? `Yes - ${tax.verifiedSource ?? ''} (${tax.verifiedAt ? timestamp(tax.verifiedAt) : ''})`
          : 'No - this is the organisation own statement, not checked by anyone here',
      ],
    ])
  } else {
    report.paragraph(
      'This organisation has published no tax standing. Contributions to it are unlikely to be deductible in ' +
        'the United States unless it is a qualified organisation under section 170(c).',
    )
  }

  report.heading('What your accountant will ask')
  report.paragraph(
    'A donation of a digital asset is a non-cash contribution. Above 500 US dollars it is reported on Form ' +
      '8283, Section A. Above 5,000 US dollars the IRS has required a qualified appraisal and a donee ' +
      'signature on Form 8283, Section B; an exchange price is not a substitute for one. The deductible ' +
      'amount depends on how long you held the asset and on your basis in it, neither of which is recorded ' +
      'here.',
  )

  report.heading('How to verify every figure above')
  report.paragraph(
    'Every number in this document comes from public blockchain events, not from this organisation or from ' +
      'the platform. The transaction, the receipt token and the acknowledgment attestation can each be opened ' +
      'in a block explorer, and the donation can be followed to the suppliers it paid at the tracking link ' +
      'below.',
  )
  report.keyValues([
    ['Tracking page', input.trackingUrl],
    ['Transaction', input.explorerTxUrl],
  ])

  report.paragraph(
    'This document is a record of a transaction and of what the donee signed. It is not tax advice, and ' +
      'nothing here states that your contribution is deductible: that depends on the organisation and on your ' +
      'own circumstances. Speak to a tax professional.',
  )

  return report.finish('Proof of Aid - every figure in this document is verifiable on-chain')
}
