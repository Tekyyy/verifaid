'use client'

import { needsRegistryAbi } from '@poa/shared'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { Address } from 'viem'
import { useAccount } from 'wagmi'
import { TxStatus } from '@/components/TxStatus'
import { deployment } from '@/lib/config'
import { useMounted, useTx, useWrongChain } from '@/lib/hooks'

/**
 * `NeedsRegistry.expire` is permissionless once a deadline has passed: anyone may apply the terms the NGO
 * committed to (close on partial funding, or expire and open refunds). The page only offers it when a deadline
 * is behind us; the contract still decides, e.g. it waits out the grace period while a tranche is releasable.
 */
export function ExpireButton({ needId }: { needId: string }) {
  const t = useTranslations('need')
  const tErrors = useTranslations('errors')
  const router = useRouter()
  const mounted = useMounted()
  const { isConnected } = useAccount()
  const wrongChain = useWrongChain()
  const tx = useTx()

  if (!deployment) return null

  const apply = async () => {
    const result = await tx.run({
      address: deployment?.contracts.NeedsRegistry as Address,
      abi: needsRegistryAbi,
      functionName: 'expire',
      args: [BigInt(needId)],
    })
    if (result) router.refresh()
  }

  return (
    <section className="card border-amber-300 bg-amber-50" aria-labelledby="expire">
      <h2 id="expire" className="section-title">
        {t('expireTitle')}
      </h2>
      <p className="mt-1 text-sm text-slate-800">{t('expireBody')}</p>
      {mounted && !isConnected ? (
        <p className="mt-3 text-sm text-slate-700">{tErrors('connectFirst')}</p>
      ) : (
        <button
          type="button"
          className="btn-primary mt-3"
          disabled={!mounted || wrongChain || tx.phase === 'signing' || tx.phase === 'pending'}
          onClick={apply}
        >
          {t('expireButton')}
        </button>
      )}
      <TxStatus state={tx} />
    </section>
  )
}
