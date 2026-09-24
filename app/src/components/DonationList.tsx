import type { DonationKind, DonationView } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { ConversionNote } from '@/components/ConversionNote'
import { ExplorerLink } from '@/components/ExplorerLink'
import { Link } from '@/i18n/navigation'
import { basketName } from '@/lib/baskets'
import { amount, shorten, timestamp } from '@/lib/format'

/** Message key (namespace `need`) of each donation kind's label. */
export const KIND_KEY: Record<DonationKind, string> = {
  DIRECT: 'donationDirect',
  CONVERTED: 'donationConvertedKind',
  BASKET: 'donationBasketKind',
  REWARD: 'donationRewardKind',
}

/** Where a basket part or a reward came from, in one line; nothing for a plain donation. */
export function DonationOrigin({ donation }: { donation: DonationView }) {
  const t = useTranslations('need')
  const tBaskets = useTranslations('baskets')
  if (donation.kind === 'REWARD' && donation.rewardFrom) {
    return (
      <p className="mt-1 text-slate-600">
        {t('donationRewardFrom', { wallet: shorten(donation.rewardFrom) })}
        {donation.basketLabel
          ? ` ${t('donationThroughBasket', { basket: basketName(tBaskets, donation.basketLabel) })}.`
          : ''}
      </p>
    )
  }
  if (donation.kind !== 'BASKET') return null
  return (
    <p className="mt-1 text-slate-600">
      {donation.basketLabel ? (
        <Link className="link" href={`/baskets/${donation.basketLabel.toLowerCase()}`}>
          {t('donationThroughBasket', { basket: basketName(tBaskets, donation.basketLabel) })}
        </Link>
      ) : (
        t('donationSplitGift')
      )}
    </p>
  )
}

/**
 * The tracking reference a donor was given: the receipt id for a wallet (a card donor has one too), and the
 * deposit address for money that came through one without crediting a wallet.
 */
const trackingRef = (donation: DonationView): string | null =>
  donation.receiptId ?? (donation.conversion?.viaDepositAddress ? donation.conversion.via : null)

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
                {BigInt(donation.withdrawn) > 0n ? (
                  <span className="ml-2 text-xs font-normal text-slate-600">
                    {t('withdrawnNote', { amount: amount(donation.withdrawn) })}
                  </span>
                ) : null}
              </span>
              <span className="text-slate-600">{t(KIND_KEY[donation.kind])}</span>
            </div>
            {donation.conversion ? <ConversionNote conversion={donation.conversion} /> : null}
            <DonationOrigin donation={donation} />
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
              <ExplorerLink kind="tx" value={donation.txHash} />
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
