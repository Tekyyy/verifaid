'use client'

import { useCallback, useEffect, useState } from 'react'
import type { Hex } from 'viem'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { chain } from './config'

/** Wallet state is client-only; gate anything that depends on it so SSR and hydration agree. */
export const useMounted = (): boolean => {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  return mounted
}

export type TxPhase = 'idle' | 'signing' | 'pending' | 'success' | 'failed'

export interface TxState {
  phase: TxPhase
  hash: Hex | null
  error: string | null
}

const INITIAL: TxState = { phase: 'idle', hash: null, error: null }

/** Exactly what `writeContractAsync` accepts, so call sites keep their ABI-level type checking. */
type WriteRequest = Parameters<ReturnType<typeof useWriteContract>['writeContractAsync']>[0]

/**
 * Runs one contract write and tracks it through sign → mined, so every on-chain action in the app can show
 * the same three states plus an explorer link.
 */
export const useTx = () => {
  const { writeContractAsync } = useWriteContract()
  const publicClient = usePublicClient()
  const [state, setState] = useState<TxState>(INITIAL)

  const reset = useCallback(() => setState(INITIAL), [])

  const run = useCallback(
    async (request: WriteRequest): Promise<Hex | null> => {
      setState({ phase: 'signing', hash: null, error: null })
      try {
        const hash = await writeContractAsync(request)
        setState({ phase: 'pending', hash, error: null })
        const receipt = await publicClient?.waitForTransactionReceipt({ hash })
        if (receipt && receipt.status === 'reverted') {
          setState({ phase: 'failed', hash, error: 'reverted' })
          return null
        }
        setState({ phase: 'success', hash, error: null })
        return hash
      } catch (error) {
        const message = error instanceof Error ? error.message.split('\n')[0] : String(error)
        setState((previous) => ({ phase: 'failed', hash: previous.hash, error: message ?? 'failed' }))
        return null
      }
    },
    [publicClient, writeContractAsync],
  )

  return { ...state, run, reset }
}

/** True when a wallet is connected but pointed at a different chain than this build is locked to. */
export const useWrongChain = (): boolean => {
  const { isConnected, chainId: walletChainId } = useAccount()
  const mounted = useMounted()
  return mounted && isConnected && walletChainId !== undefined && walletChainId !== chain.id
}
