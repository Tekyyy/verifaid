'use client'

import { easAbi } from '@poa/shared'
import { useQuery } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { type Address, type Hex, keccak256, stringToHex } from 'viem'
import { FormError, Panel, TextField } from '@/components/form'
import { TxStatus } from '@/components/TxStatus'
import { deployment } from '@/lib/config'
import { communityAttestationRequest, hasCommunitySchema } from '@/lib/eas'
import { amount, shorten, timestamp } from '@/lib/format'
import { useTx } from '@/lib/hooks'
import { getNeed } from '@/lib/indexer'
import { acknowledgmentStatement } from '@/lib/taxReceipt'

/**
 * The donee signing for what it received. For a US donor a contribution of $250 or more needs a written
 * acknowledgment from the organisation stating the amount, the date, and whether anything was given in return
 * — this signs exactly that sentence, on chain, from the organisation's own wallet.
 *
 * It commits no donor's name: the acknowledgment is about the donation, and a donor adds their own details to
 * the document they download.
 */
export function AcknowledgeDonationsPanel() {
  const t = useTranslations('tax')
  const tCommon = useTranslations('common')
  const tx = useTx()
  const [needId, setNeedId] = useState('')
  const [error, setError] = useState<string | null>(null)

  const need = useQuery({
    queryKey: ['need-acknowledge', needId],
    queryFn: () => getNeed(needId),
    enabled: /^\d+$/.test(needId),
  })

  if (!hasCommunitySchema('DonationAcknowledged')) return null

  const data = need.data?.ok ? need.data.data : null
  const unit = tCommon('amountUnit')
  // Only wallet donations carry a receipt, and only a receipt can be acknowledged to a named donor.
  const donations = (data?.donations ?? []).filter(
    (donation) => donation.receiptId !== null && BigInt(donation.amount) > 0n,
  )
  const taxId = data?.taxStatus?.taxId ?? ''
  const legalName = data?.taxStatus?.legalName ?? ''

  const acknowledge = async (receiptId: string, value: string, at: number, txHash: string) => {
    const need = data
    if (!need) return
    if (!legalName || !taxId) return setError(t('errorNoStatus'))
    setError(null)
    const statement = acknowledgmentStatement({
      legalName,
      taxId,
      amount: amount(value),
      unit,
      date: timestamp(at),
      txHash,
    })
    await tx.run({
      address: deployment?.external.EAS as Address,
      abi: easAbi,
      functionName: 'attest',
      args: [
        communityAttestationRequest('DonationAcknowledged', [
          BigInt(receiptId),
          BigInt(need.id),
          keccak256(stringToHex(statement)) as Hex,
          statement,
        ]),
      ],
    })
  }

  return (
    <Panel title={t('ackTitle')} description={t('ackBody')}>
      <TextField label={t('ackNeedId')} value={needId} onChange={setNeedId} inputMode="numeric" />
      {data && !data.taxStatus ? <p className="hint">{t('errorNoStatus')}</p> : null}
      {data && donations.length === 0 ? <p className="hint">{t('ackNone')}</p> : null}

      <ul className="space-y-2">
        {donations.map((donation) => (
          <li key={donation.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>
              <span className="font-semibold tabular-nums">
                {amount(donation.amount)} {unit}
              </span>
              <span className="ml-2 text-xs text-slate-600">
                {t('ackReceipt', {
                  id: donation.receiptId ?? '',
                  donor: donation.donor ? shorten(donation.donor) : '—',
                  date: timestamp(donation.timestamp),
                })}
              </span>
            </span>
            <button
              type="button"
              className="btn-secondary text-xs"
              disabled={!data?.taxStatus || tx.phase === 'signing' || tx.phase === 'pending'}
              onClick={() =>
                void acknowledge(
                  donation.receiptId as string,
                  donation.amount,
                  donation.timestamp,
                  donation.txHash,
                )
              }
            >
              {t('ackSign')}
            </button>
          </li>
        ))}
      </ul>

      <FormError message={error} />
      <TxStatus state={tx} />
      <p className="hint">{t('ackHint')}</p>
    </Panel>
  )
}
