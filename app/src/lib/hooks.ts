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
  /** Set while a batch goes out as separate transactions, because the wallet cannot bundle them. */
  step: { current: number; total: number } | null
}

/** What a successful write leaves behind, so callers can read the events it emitted (e.g. a receipt id). */
export interface TxResult {
  hash: Hex
  /** Every log of every transaction the write took, in order. */
  logs: Log[]
}

const INITIAL: TxState = { phase: 'idle', hash: null, error: null, sponsored: false, step: null }

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
  /** Wei sent along with a payable call (an ETH donation). */
  value?: bigint
}

/** A call inside a batch. Batches mix ABIs (approve on a token, donate on the factory): build each with `batchCall`. */
export type BatchCall = WriteRequest

/** Checks one call against its own ABI, then widens it so calls to different contracts fit in one batch. */
export const batchCall = <
  const abi extends Abi,
  functionName extends ContractFunctionName<abi, WriteMutability>,
>(
  request: WriteRequest<abi, functionName>,
): BatchCall => request as unknown as BatchCall

const CALLS_TIMEOUT_MS = 180_000
/** How long a dependent call waits for the node to see the call before it: about fifteen blocks on Base. */
const SETTLE_ATTEMPTS = 10
const SETTLE_DELAY_MS = 1_500
/** Retries of a dependent call the wallet refused as failing, in case its own node was still behind. */
const RESEND_ATTEMPTS = 2

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const firstLine = (error: unknown): string =>
  (error instanceof Error ? error.message.split('\n')[0] : String(error)) || 'failed'

/** The donor said no in the wallet (EIP-1193 code 4001), as opposed to the wallet predicting a failure. */
const declinedByUser = (error: unknown): boolean => {
  let declined = false
  const visit = (e: unknown, depth = 0) => {
    if (!e || typeof e !== 'object' || depth > 5) return
    const { code, name, cause } = e as { code?: unknown; name?: unknown; cause?: unknown }
    if (code === 4001 || name === 'UserRejectedRequestError') declined = true
    visit(cause, depth + 1)
  }
  visit(error)
  return declined || /user (rejected|denied)|rejected the request/i.test(firstLine(error))
}

/** One `wallet_getCapabilities` query for the connected account on this chain, shared by the hooks below. */
const useWalletCapabilities = () => {
  const { isConnected } = useAccount()
  const { data } = useCapabilities({
    chainId: chain.id,
    query: { enabled: isConnected, retry: false },
  })
  return data
}

/**
 * True when writes can be gas-sponsored: a paymaster is configured and the connected wallet (Coinbase Smart
 * Wallet, typically) reports the ERC-7677 `paymasterService` capability for this chain. Any other wallet, or a
 * wallet that does not implement `wallet_getCapabilities`, falls back to a normal transaction.
 */
export const useSponsoredGas = (): boolean => {
  const data = useWalletCapabilities()
  return Boolean(paymasterUrl) && data?.paymasterService?.supported === true
}

/**
 * True when the wallet executes an EIP-5792 batch atomically: all of its calls or none. Wallets report it as
 * `atomic.status: 'supported'` (EIP-5792 v2) or, before that, `atomicBatch.supported`. `ready` is deliberately not
 * enough: it means the wallet would first ask to upgrade the account, which is not what a donor came to do.
 */
export const useAtomicBatch = (): boolean => {
  const data = useWalletCapabilities()
  return data?.atomic?.status === 'supported' || data?.atomicBatch?.supported === true
}

/**
 * Runs contract writes and tracks them through sign → mined, so every on-chain action in the app can show the
 * same three states plus an explorer link.
 *
 * `run` sends one call; `runBatch` sends calls that belong together (approve + donate). A batch goes out as one
 * EIP-5792 `wallet_sendCalls` when the wallet executes batches atomically, with the paymaster capability when gas
 * can be sponsored. Otherwise its calls are sent one after another, each signed separately, stopping at the first
 * failure. A single call also goes through `wallet_sendCalls` when it can be sponsored.
 */
export const useTx = () => {
  const { writeContractAsync } = useWriteContract()
  const { sendCallsAsync } = useSendCalls()
  const config = useConfig()
  const publicClient = usePublicClient()
  const sponsored = useSponsoredGas()
  const atomic = useAtomicBatch()
  const [state, setState] = useState<TxState>(INITIAL)
  const { address: account } = useAccount()

  const reset = useCallback(() => setState(INITIAL), [])

  /**
   * A call that depends on the one before it (a donation after its approval) waits until a node sees that call's
   * effect. The wallet checks every transaction against its own node before sending it, and that node can trail the
   * receipt by a block or two: it would report "exceeds allowance" for a donation that is fine, and send nothing.
   */
  const untilItWouldPass = useCallback(
    async (request: BatchCall) => {
      if (!publicClient || !account) return
      for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
        try {
          await publicClient.simulateContract({ ...request, account } as never)
          return
        } catch {
          await sleep(SETTLE_DELAY_MS)
        }
      }
    },
    [account, publicClient],
  )

  /** Sends a call; a later step the wallet refused as failing (not the donor declining) is tried again shortly. */
  const sendDependentStep = useCallback(
    async (request: BatchCall, index: number): Promise<Hex> => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await writeContractAsync(request as never)
        } catch (error) {
          if (index === 0 || attempt >= RESEND_ATTEMPTS || declinedByUser(error)) throw error
          await sleep(SETTLE_DELAY_MS)
        }
      }
    },
    [writeContractAsync],
  )

  const runCalls = useCallback(
    async (calls: readonly BatchCall[]): Promise<TxResult | null> => {
      const { id } = await sendCallsAsync({
        calls: calls.map((request) => ({
          to: request.address,
          abi: request.abi,
          functionName: request.functionName,
          args: request.args,
          value: request.value,
        })),
        capabilities: sponsored ? { paymasterService: { url: paymasterUrl as string } } : undefined,
        // Half a batch is worse than none: an approval without its donation leaves a dangling allowance.
        forceAtomic: calls.length > 1,
      } as never)
      setState({ phase: 'pending', hash: null, error: null, sponsored, step: null })
      const status = await waitForCallsStatus(config, { id, timeout: CALLS_TIMEOUT_MS })
      const receipts = status.receipts ?? []
      const hash = receipts.at(-1)?.transactionHash ?? null
      if (status.status !== 'success' || !hash || receipts.some((receipt) => receipt.status !== 'success')) {
        setState({ phase: 'failed', hash, error: 'reverted', sponsored, step: null })
        return null
      }
      setState({ phase: 'success', hash, error: null, sponsored, step: null })
      return { hash, logs: receipts.flatMap((receipt) => receipt.logs as unknown as Log[]) }
    },
    [config, sendCallsAsync, sponsored],
  )

  const runSequential = useCallback(
    async (calls: readonly BatchCall[]): Promise<TxResult | null> => {
      const logs: Log[] = []
      let hash: Hex | null = null
      for (const [index, request] of calls.entries()) {
        const step = calls.length > 1 ? { current: index + 1, total: calls.length } : null
        setState({ phase: 'signing', hash, error: null, sponsored: false, step })
        if (index > 0) await untilItWouldPass(request)
        hash = await sendDependentStep(request, index)
        setState({ phase: 'pending', hash, error: null, sponsored: false, step })
        const receipt = await publicClient?.waitForTransactionReceipt({ hash })
        if (receipt && receipt.status === 'reverted') {
          setState({ phase: 'failed', hash, error: 'reverted', sponsored: false, step })
          return null
        }
        logs.push(...(receipt?.logs ?? []))
      }
      if (!hash) return null
      setState({ phase: 'success', hash, error: null, sponsored: false, step: null })
      return { hash, logs }
    },
    [publicClient, sendDependentStep, untilItWouldPass],
  )

  const runBatch = useCallback(
    async (calls: readonly BatchCall[]): Promise<TxResult | null> => {
      if (calls.length === 0) return null
      const bundled = calls.length === 1 ? sponsored : atomic
      setState({ phase: 'signing', hash: null, error: null, sponsored: bundled && sponsored, step: null })
      try {
        return bundled ? await runCalls(calls) : await runSequential(calls)
      } catch (error) {
        setState((previous) => ({ ...previous, phase: 'failed', error: firstLine(error) }))
        return null
      }
    },
    [atomic, runCalls, runSequential, sponsored],
  )

  const run = useCallback(
    async <const abi extends Abi, functionName extends ContractFunctionName<abi, WriteMutability>>(
      request: WriteRequest<abi, functionName>,
    ): Promise<TxResult | null> => runBatch([batchCall(request)]),
    [runBatch],
  )

  return { ...state, run, runBatch, reset }
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
