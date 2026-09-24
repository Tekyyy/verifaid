'use client'

import { needsRegistryAbi } from '@poa/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import type { Address } from 'viem'
import { Panel } from '@/components/form'
import { TxStatus } from '@/components/TxStatus'
import { deployment } from '@/lib/config'
import { useTx } from '@/lib/hooks'

/**
 * Withdrawing a need before its funding closes: its NGO may, and on a need a beneficiary posted, so may the
 * beneficiary. Anything already given can then be claimed back in full. After funding closes only the platform
 * admin can cancel, as a dispute decision, so the dashboard stops offering this.
 */
export function CancelNeedPanel({ needId }: { needId: string }) {
  const t = useTranslations('manage')
  const tx = useTx()
  const queryClient = useQueryClient()

  const cancel = async () => {
    const result = await tx.run({
      address: deployment?.contracts.NeedsRegistry as Address,
      abi: needsRegistryAbi,
      functionName: 'cancelNeed',
      args: [BigInt(needId)],
    })
    if (result) await queryClient.invalidateQueries({ queryKey: ['ngo-need', needId] })
  }

  return (
    <Panel title={t('cancelTitle')} description={t('cancelBody')}>
      <button
        type="button"
        className="btn-secondary"
        disabled={tx.phase === 'signing' || tx.phase === 'pending' || tx.phase === 'success'}
        onClick={cancel}
      >
        {t('cancel')}
      </button>
      <TxStatus state={tx} />
    </Panel>
  )
}
