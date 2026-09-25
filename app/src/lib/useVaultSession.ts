'use client'

import { useCallback } from 'react'
import type { Address } from 'viem'
import { useAccount, useSignMessage } from 'wagmi'
import { piiVaultUrl } from './config'
import { isFresh, type VaultResult, type VaultSession, vaultSignIn } from './vault'

/**
 * Tokens live in memory only, per wallet: a reload asks for one signature again, and nothing a script on the page
 * could read survives the tab.
 */
const sessions = new Map<string, VaultSession>()

/** The vault token for the connected wallet: this tab's if it is still fresh, otherwise one new signature. */
export const useVaultSession = () => {
  const { address } = useAccount()
  const { signMessageAsync } = useSignMessage()

  const getToken = useCallback(async (): Promise<VaultResult<string>> => {
    if (!address) return { ok: false, error: 'Connect a wallet first.' }
    const cached = sessions.get(address.toLowerCase())
    if (isFresh(cached)) return { ok: true, data: cached.token }
    const session = await vaultSignIn({ baseUrl: piiVaultUrl }, address as Address, (message) =>
      signMessageAsync({ message }),
    )
    if (!session.ok) return session
    sessions.set(address.toLowerCase(), session.data)
    return { ok: true, data: session.data.token }
  }, [address, signMessageAsync])

  return { address, getToken }
}
