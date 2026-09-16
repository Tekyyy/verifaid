'use client'

import { aidVaultAbi } from '@poa/shared'
import { useTranslations } from 'next-intl'
import type { Address } from 'viem'
import { useAccount } from 'wagmi'
import { TxStatus } from '@/components/TxStatus'
import { useMounted, useTx, useWrongChain } from '@/lib/hooks'

/**
 * Refund guidance for an on-chain need that was cancelled or expired. Wallet donors pull their pro-rata share
 * of the unreleased balance themselves; card and bank donors are refunded by the provider that deposited
 * their money, which the contract lets it do even after it loses its role.
 */
export function RefundPanel({ vault }: { vault: Address | null }) {
  const t = useTranslations('need')
  const tErrors = useTranslations('errors')
  const mounted = useMounted()
  const { isConnected } = useAccount()
  const wrongChain = useWrongChain()
  const tx = useTx()

  return (
    <section className="card border-orange-300 bg-orange-50" aria-labelledby="refunds">
      <h2 id="refunds" className="section-title">
        {t('refundTitle')}
      </h2>
      <p className="mt-1 text-sm text-slate-800">{t('refundWallet')}</p>
      <p className="mt-2 text-sm text-slate-800">{t('refundFiat')}</p>
      {vault ? (
        mounted && !isConnected ? (
          <p className="mt-3 text-sm text-slate-700">{tErrors('connectFirst')}</p>
        ) : (
          <button
            type="button"
            className="btn-secondary mt-3"
            disabled={!mounted || wrongChain || tx.phase === 'signing' || tx.phase === 'pending'}
            onClick={() =>
              tx.run({ address: vault, abi: aidVaultAbi, functionName: 'claimRefund', args: [] })
            }
          >
            {t('refundButton')}
          </button>
        )
      ) : null}
      <TxStatus state={tx} />
    </section>
  )
}
