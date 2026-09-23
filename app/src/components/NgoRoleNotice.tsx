'use client'

import { roleRegistryAbi } from '@poa/shared'
import { useTranslations } from 'next-intl'
import type { Address } from 'viem'
import { useAccount, useReadContract } from 'wagmi'
import { Notice } from '@/components/Notice'
import { deployment } from '@/lib/config'
import { useMounted } from '@/lib/hooks'

/**
 * Every NGO action is refused on chain unless the platform admin registered the signing wallet as an active NGO.
 * Without this, the only sign of it is a wallet warning that the transaction "is likely to fail", with no reason.
 */
export function NgoRoleNotice() {
  const t = useTranslations('ngo')
  const mounted = useMounted()
  const { address } = useAccount()
  const roles = deployment?.contracts.RoleRegistry as Address | undefined

  const { data: active } = useReadContract({
    address: roles,
    abi: roleRegistryAbi,
    functionName: 'isActiveNgo',
    args: address ? [address] : undefined,
    query: { enabled: Boolean(roles && address) },
  })

  if (!mounted || !address || active !== false) return null

  return (
    <Notice tone="warning" title={t('notNgoTitle')}>
      <p>{t('notNgoBody', { address })}</p>
    </Notice>
  )
}
