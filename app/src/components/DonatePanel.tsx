'use client'

import { aidVaultAbi, mockEURCAbi } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { type Address, parseEventLogs } from 'viem'
import { useAccount } from 'wagmi'
import { TxStatus } from '@/components/TxStatus'
import { Link } from '@/i18n/navigation'
import { deployment } from '@/lib/config'
import { amount as formatAmountValue, parseAmount } from '@/lib/format'
import { useTx, useWrongChain } from '@/lib/hooks'

/**
 * ERC-20 approve followed by `AidVault.donate`. Two separate transactions, each with its own status, because
 * that is what the donor's wallet will actually ask them to sign.
 */
export function DonatePanel({
  vault,
  fundingOpen,
  targetAmount,
  totalDonated,
}: {
  vault: Address | null
  /** Status is Funding and no deadline has passed, as computed by the page. */
  fundingOpen: boolean
  targetAmount: string
  totalDonated: string
}) {
  const t = useTranslations('need')
  const tCommon = useTranslations('common')
  const tErrors = useTranslations('errors')
  const { isConnected } = useAccount()
  const wrongChain = useWrongChain()
  const approve = useTx()
  const donate = useTx()
  const [value, setValue] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [receiptId, setReceiptId] = useState<string | null>(null)

  const token = deployment?.external.Token
  const open = fundingOpen && vault !== null
  const remaining = BigInt(targetAmount) - BigInt(totalDonated)

  const parsed = parseAmount(value)

  const runApprove = async () => {
    if (!parsed || !token || !vault) return setFormError(tErrors('invalidAmount'))
    setFormError(null)
    await approve.run({
      address: token,
      abi: mockEURCAbi,
      functionName: 'approve',
      args: [vault, parsed],
    })
  }

  const runDonate = async () => {
    if (!parsed || !vault) return setFormError(tErrors('invalidAmount'))
    setFormError(null)
    setReceiptId(null)
    const result = await donate.run({
      address: vault,
      abi: aidVaultAbi,
      functionName: 'donate',
      args: [parsed],
    })
    if (!result) return
    // The receipt id is the donor's tracking reference; read it from the event rather than guessing it.
    const [donated] = parseEventLogs({ abi: aidVaultAbi, eventName: 'Donated', logs: result.logs })
    if (donated) setReceiptId(donated.args.receiptId.toString())
  }

  return (
    <section className="card" aria-labelledby="donate">
      <h2 id="donate" className="section-title">
        {t('donateTitle')}
      </h2>
      <p className="mt-1 text-sm text-slate-700">{t('donateBody', { unit: tCommon('amountUnit') })}</p>

      {!open ? (
        <p className="mt-3 text-sm font-medium text-slate-700">{t('donateClosed')}</p>
      ) : (
        <>
          <p className="mt-3 text-xs text-slate-600">
            {t('donateRemaining', {
              amount: formatAmountValue(remaining > 0n ? remaining : 0n),
              unit: tCommon('amountUnit'),
            })}
          </p>

          <div className="mt-3">
            <label className="label" htmlFor="donate-amount">
              {t('donateAmount', { unit: tCommon('amountUnit') })}
            </label>
            <input
              id="donate-amount"
              className="input"
              inputMode="decimal"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="100.00"
            />
          </div>

          {formError ? (
            <p className="mt-2 text-xs text-red-800" role="alert">
              {formError}
            </p>
          ) : null}

          {!isConnected ? (
            <p className="mt-3 text-sm text-slate-700">{tErrors('connectFirst')}</p>
          ) : (
            <div className="mt-4 space-y-3">
              <div>
                <button
                  type="button"
                  className="btn-secondary w-full sm:w-auto"
                  onClick={runApprove}
                  disabled={wrongChain || approve.phase === 'signing' || approve.phase === 'pending'}
                >
                  {t('donateApprove')}
                </button>
                <TxStatus state={approve} />
              </div>
              <div>
                <button
                  type="button"
                  className="btn-primary w-full sm:w-auto"
                  onClick={runDonate}
                  disabled={wrongChain || donate.phase === 'signing' || donate.phase === 'pending'}
                >
                  {t('donateSend')}
                </button>
                <TxStatus state={donate} />
              </div>
              {donate.phase === 'success' ? (
                <div className="space-y-2">
                  <p className="text-sm font-medium text-emerald-800">{t('donateSuccess')}</p>
                  {receiptId ? (
                    <Link className="btn-secondary" href={`/track/${receiptId}`}>
                      {t('trackThisDonation', { id: receiptId })}
                    </Link>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
        </>
      )}
    </section>
  )
}
