'use client'

import type { NeedDetail } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { type Address, isAddressEqual } from 'viem'
import { useAccount } from 'wagmi'
import { amount as formatAmount } from '@/lib/format'
import { useMounted } from '@/lib/hooks'

/**
 * A donor reading this list is the one person who needs to know the money is still theirs while the need is
 * raising. The panel that takes it back sits at the top of this column, so this says how much is at stake and
 * points straight at it — otherwise it is a long scroll away from where a donor is looking.
 */
export function YourDonationsNote({ need }: { need: NeedDetail }) {
  const t = useTranslations('need')
  const tCommon = useTranslations('common')
  const mounted = useMounted()
  const { address } = useAccount()

  const mine = need.donations.filter(
    (donation) =>
      donation.donor !== null && address !== undefined && isAddressEqual(donation.donor as Address, address),
  )
  const total = mine.reduce((sum, donation) => sum + BigInt(donation.amount), 0n)
  const withdrawable = mine.reduce(
    (sum, donation) => (donation.receiptId !== null ? sum + BigInt(donation.amount) : sum),
    0n,
  )
  const open = need.status === 'Funding' && need.vault !== null

  if (!mounted || total === 0n) return null

  return (
    <p className="mt-2 rounded-md bg-slate-100 px-3 py-2 text-xs text-slate-700">
      {t('yourStake', { amount: formatAmount(total), unit: tCommon('amountUnit') })}
      {open && withdrawable > 0n ? (
        <>
          {' '}
          <a className="link" href="#withdraw">
            {t('yourStakeWithdraw')}
          </a>
        </>
      ) : null}
    </p>
  )
}
