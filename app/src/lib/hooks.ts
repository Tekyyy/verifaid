'use client'

import { needsRegistryAbi } from '@poa/shared'
import { useCallback, useState } from 'react'
import type { Abi, Address, ContractFunctionArgs, ContractFunctionName, Hex, Log } from 'viem'
import {
  useAccount,
  useCapabilities,
  useConfig,
  usePublicClient,
  useReadContract,
  useSendCalls,
  useWriteContract,
} from 'wagmi'
import { waitForCallsStatus } from 'wagmi/actions'
import { chain, deployment, paymasterUrl } from './config'
import { useMounted } from './mounted'

/** Wallet state is client-only; gate anything that depends on it so SSR and hydration agree. */
export { useMounted }

export type TxPhase = 'idle' | 'signing' | 'pending' | 'success' | 'failed'

export interface TxState {
  phase: TxPhase
  hash: Hex | null
  error: string | null
  /** The write went through the paymaster: the user paid no gas. */
  sponsored: boolean
}

/** What a successful write leaves behind, so callers can read the events it emitted (e.g. a receipt id). */
export interface TxResult {
  hash: Hex
  logs: Log[]
}

const INITIAL: TxState = { phase: 'idle', hash: null, error: null, sponsored: false }

type WriteMutability = 'nonpayable' | 'payable'

/** One contract call, typed against its ABI so every call site keeps argument-level checking. */
export interface WriteRequest<
  abi extends Abi = Abi,
  functionName extends ContractFunctionName<abi, WriteMutability> = ContractFunctionName<
    abi,
    WriteMutability
  >,
> {
  address: Address
  abi: abi
  functionName: functionName
  args: ContractFunctionArgs<abi, WriteMutability, functionName>
}

const CALLS_TIMEOUT_MS = 180_000

const firstLine = (error: unknown): string =>
  (error instanceof Error ? error.message.split('\n')[0] : String(error)) || 'failed'

/**
 * True when writes can be gas-sponsored: a paymaster is configured and the connected wallet (Coinbase Smart
 * Wallet, typically) reports the ERC-7677 `paymasterService` capability for this chain. Any other wallet, or a
 * wallet that does not implement `wallet_getCapabilities`, falls back to a normal transaction.
 */
export const useSponsoredGas = (): boolean => {
  const { isConnected } = useAccount()
  const { data } = useCapabilities({
    chainId: chain.id,
    query: { enabled: Boolean(paymasterUrl) && isConnected, retry: false },
  })
  return Boolean(paymasterUrl) && data?.paymasterService?.supported === true
}

/**
 * Runs one contract write and tracks it through sign → mined, so every on-chain action in the app can show
 * the same three states plus an explorer link. When gas can be sponsored the call goes out as an EIP-5792
 * batch with a paymaster capability instead, and the batch status is awaited the same way.
 */
export const useTx = () => {
  const { writeContractAsync } = useWriteContract()
  const { sendCallsAsync } = useSendCalls()
  const config = useConfig()
  const publicClient = usePublicClient()
  const sponsored = useSponsoredGas()
  const [state, setState] = useState<TxState>(INITIAL)

  const reset = useCallback(() => setState(INITIAL), [])

  const runSponsored = useCallback(
    async (request: WriteRequest): Promise<TxResult | null> => {
      const { id } = await sendCallsAsync({
        calls: [
          { to: request.address, abi: request.abi, functionName: request.functionName, args: request.args },
        ],
        capabilities: { paymasterService: { url: paymasterUrl as string } },
      } as never)
      setState({ phase: 'pending', hash: null, error: null, sponsored: true })
      const status = await waitForCallsStatus(config, { id, timeout: CALLS_TIMEOUT_MS })
      const receipt = status.receipts?.[0]
      const hash = receipt?.transactionHash ?? null
      if (status.status !== 'success' || !receipt || receipt.status !== 'success' || !hash) {
        setState({ phase: 'failed', hash, error: 'reverted', sponsored: true })
        return null
      }
      setState({ phase: 'success', hash, error: null, sponsored: true })
      return { hash, logs: receipt.logs as unknown as Log[] }
    },
    [config, sendCallsAsync],
  )

  const run = useCallback(
    async <const abi extends Abi, functionName extends ContractFunctionName<abi, WriteMutability>>(
      request: WriteRequest<abi, functionName>,
    ): Promise<TxResult | null> => {
      setState({ phase: 'signing', hash: null, error: null, sponsored })
      try {
        if (sponsored) return await runSponsored(request as unknown as WriteRequest)

        const hash = await writeContractAsync(request as never)
        setState({ phase: 'pending', hash, error: null, sponsored: false })
        const receipt = await publicClient?.waitForTransactionReceipt({ hash })
        if (receipt && receipt.status === 'reverted') {
          setState({ phase: 'failed', hash, error: 'reverted', sponsored: false })
          return null
        }
        setState({ phase: 'success', hash, error: null, sponsored: false })
        return { hash, logs: receipt?.logs ?? [] }
      } catch (error) {
        setState((previous) => ({ ...previous, phase: 'failed', error: firstLine(error) }))
        return null
      }
    },
    [publicClient, runSponsored, sponsored, writeContractAsync],
  )

  return { ...state, run, reset }
}

/** True when a wallet is connected but pointed at a different chain than this build is locked to. */
export const useWrongChain = (): boolean => {
  const { isConnected, chainId: walletChainId } = useAccount()
  const mounted = useMounted()
  return mounted && isConnected && walletChainId !== undefined && walletChainId !== chain.id
}

/**
 * Resolves a need id to its ledger: the AidVault (on-chain custody) or the NonCustodialLedger (off-chain
 * custody). Funding, tranche and ledger-recipient attestations all target this address, never the registry.
 */
export const useLedger = (needId: string): Address | undefined => {
  const enabled = /^\d+$/.test(needId) && Boolean(deployment)
  const { data } = useReadContract({
    address: deployment?.contracts.NeedsRegistry as Address,
    abi: needsRegistryAbi,
    functionName: 'vaultOf',
    args: enabled ? [BigInt(needId)] : undefined,
    query: { enabled },
  })
  return data && !/^0x0{40}$/i.test(data) ? data : undefined
}
