import type { DonationKind, DonationView } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { ConversionNote } from '@/components/ConversionNote'
import { ExplorerLink } from '@/components/ExplorerLink'
import { Link } from '@/i18n/navigation'
import { amount, timestamp } from '@/lib/format'

/** Message key (namespace `need`) of each donation kind's label. */
export const KIND_KEY: Record<DonationKind, string> = {
  DIRECT: 'donationDirect',
  FIAT: 'donationFiat',
  OFFCHAIN: 'donationOffchain',
  CONVERTED: 'donationConvertedKind',
}

/**
 * The tracking reference a donor was given: the receipt id for wallets, the payment reference for card and bank
 * payments, and the deposit address for money that came through one without crediting a wallet.
 */
const trackingRef = (donation: DonationView): string | null =>
  donation.receiptId ??
  donation.paymentRefHash ??
  (donation.conversion?.viaDepositAddress ? donation.conversion.via : null)

export function DonationList({ donations }: { donations: DonationView[] }) {
  const t = useTranslations('need')
  const tCommon = useTranslations('common')

  if (donations.length === 0) return <p className="mt-2 text-sm text-slate-600">{t('noDonations')}</p>

  return (
    <ul className="mt-3 space-y-2">
      {donations.map((donation) => {
        const ref = trackingRef(donation)
        return (
          <li key={donation.id} className="rounded-md border border-slate-200 px-3 py-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold tabular-nums">
                {amount(donation.amount)} {tCommon('amountUnit')}
              </span>
              <span className="text-slate-600">{t(KIND_KEY[donation.kind])}</span>
            </div>
            {donation.conversion ? <ConversionNote conversion={donation.conversion} /> : null}
            {donation.gross !== null ? (
              <p className="mt-1 text-slate-700 tabular-nums">
                {t('donationPaid', {
                  gross: amount(donation.gross),
                  fee: amount(donation.fee ?? '0'),
                  currency: donation.currency ?? tCommon('amountUnit'),
                })}
              </p>
            ) : null}
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
              <ExplorerLink kind="tx" value={donation.txHash} />
              {donation.attestationUID ? (
                <ExplorerLink kind="attestation" value={donation.attestationUID} />
              ) : null}
              <span className="text-slate-500">{timestamp(donation.timestamp)}</span>
              {ref ? (
                <Link className="link" href={`/track/${ref}`}>
                  {t('trackDonation')}
                </Link>
              ) : null}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
