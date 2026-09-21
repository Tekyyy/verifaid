'use client'

import { aidVaultAbi, type DonationView, type NeedDetail } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { type Address, isAddressEqual } from 'viem'
import { useAccount } from 'wagmi'
import { FormError } from '@/components/form'
import { TxStatus } from '@/components/TxStatus'
import { amount as formatAmount, parseAmount, timestamp } from '@/lib/format'
import { useMounted, useTx, useWrongChain } from '@/lib/hooks'

/** Mirrors `AidVault.WITHDRAW_LOCK_PERIOD`: withdrawals stop this long before the funding deadline. */
const LOCK_PERIOD_SECONDS = 2 * 24 * 60 * 60

/**
 * Taking a donation back while the need is still raising. Nothing has been committed to a supplier yet, so the
 * money is still the donor's — the contract allows it until funding closes, and stops it two days before the
 * funding deadline so the NGO decides whether to go ahead on a settled number.
 *
 * Shown only to the wallet that holds the receipt, and only for donations it can actually take back.
 */
export function WithdrawDonationPanel({ need }: { need: NeedDetail }) {
  const t = useTranslations('need')
  const tCommon = useTranslations('common')
  const tErrors = useTranslations('errors')
  const mounted = useMounted()
  const { address, isConnected } = useAccount()
  const wrongChain = useWrongChain()
  const tx = useTx()
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)

  const now = Math.floor(Date.now() / 1000)
  const locked = need.fundingDeadline !== null && now + LOCK_PERIOD_SECONDS > need.fundingDeadline
  const open = need.status === 'Funding' && need.custodyMode === 'OnChain'

  const mine = need.donations.filter(
    (donation) =>
      donation.receiptId !== null &&
      donation.donor !== null &&
      address !== undefined &&
      isAddressEqual(donation.donor as Address, address) &&
      BigInt(donation.amount) > 0n,
  )

  if (!mounted || !open || !isConnected || mine.length === 0 || need.vault === null) return null

  const withdraw = async (donation: DonationView) => {
    const typed = values[donation.id] ?? ''
    const parsed = typed.trim() ? parseAmount(typed) : BigInt(donation.amount)
    if (parsed === null || parsed <= 0n || parsed > BigInt(donation.amount)) {
      return setError(tErrors('invalidAmount'))
    }
    setError(null)
    await tx.run({
      address: need.vault as Address,
      abi: aidVaultAbi,
      functionName: 'withdrawDonation',
      args: [BigInt(donation.receiptId as string), parsed],
    })
  }

  return (
    <section className="card border-slate-300" aria-labelledby="withdraw">
      <h2 id="withdraw" className="section-title">
        {t('withdrawTitle')}
      </h2>
      <p className="mt-1 text-sm text-slate-800">{t('withdrawBody')}</p>
      {locked ? (
        <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">
          {t('withdrawLocked')}
        </p>
      ) : need.fundingDeadline !== null ? (
        <p className="mt-2 text-xs text-slate-600">
          {t('withdrawUntil', { date: timestamp(need.fundingDeadline - LOCK_PERIOD_SECONDS) })}
        </p>
      ) : null}

      <ul className="mt-3 space-y-3">
        {mine.map((donation) => (
          <li key={donation.id} className="flex flex-wrap items-end gap-2">
            <span className="text-sm">
              <span className="block font-semibold tabular-nums">
                {formatAmount(donation.amount)} {tCommon('amountUnit')}
              </span>
              <span className="text-xs text-slate-600">
                {t('withdrawReceipt', { id: donation.receiptId ?? '', date: timestamp(donation.timestamp) })}
              </span>
            </span>
            <input
              className="input w-28"
              inputMode="decimal"
              placeholder={formatAmount(donation.amount)}
              value={values[donation.id] ?? ''}
              onChange={(event) => setValues({ ...values, [donation.id]: event.target.value })}
              aria-label={t('withdrawAmount')}
            />
            <button
              type="button"
              className="btn-secondary"
              disabled={locked || wrongChain || tx.phase === 'signing' || tx.phase === 'pending'}
              onClick={() => withdraw(donation)}
            >
              {t('withdrawButton')}
            </button>
          </li>
        ))}
      </ul>

      <FormError message={error} />
      <TxStatus state={tx} />
    </section>
  )
}
