'use client'

import { conversionRouterAbi, mockEURCAbi, NATIVE_TOKEN } from '@poa/shared'
import { useTranslations } from 'next-intl'
import { useCallback } from 'react'
import { type Address, BaseError, ContractFunctionRevertedError } from 'viem'
import { useAccount, usePublicClient, useReadContract } from 'wagmi'
import { factoryCallAbi, REVERT_MESSAGES } from './abiErrors'
import { deployment } from './config'
import { configuredSlippageBps, minimumOut } from './conversion'

export type Preflight = { ok: true } | { ok: false; reason: string }

const classify = (error: unknown): Preflight => {
  if (error instanceof BaseError) {
    const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError)
    if (reverted instanceof ContractFunctionRevertedError) {
      return { ok: false, reason: reverted.data?.errorName ?? reverted.shortMessage }
    }
  }
  // Not a revert (transport, rate limit, an RPC without the method): nothing learned, so nothing is blocked.
  return { ok: true }
}

/**
 * Simulates a converted wallet donation before the wallet is asked to sign, so a revert the donor can understand —
 * above all the need's disclosed cost cap (`FeeExceedsDisclosure`: conversion costs count against it) — becomes a
 * message instead of a failed transaction.
 *
 * - ETH, or USDC that is already approved: an `eth_call` of `factory.donate`.
 * - USDC not approved yet: approve and donate together through `eth_simulateV1`, because donate alone would only
 *   report the missing allowance. An RPC without it skips the check; the wallet and the contracts still guard.
 */
export const useDonationPreflight = () => {
  const publicClient = usePublicClient()
  const { address } = useAccount()

  return useCallback(
    async ({
      needId,
      token,
      amount,
    }: {
      needId: string
      token: Address
      amount: bigint
    }): Promise<Preflight> => {
      const factory = deployment?.contracts.DonationForwarderFactory
      if (!publicClient || !address || !factory) return { ok: true }
      const native = token === NATIVE_TOKEN
      const args = [BigInt(needId), token, amount] as const

      try {
        const allowance = native
          ? amount
          : await publicClient.readContract({
              address: token,
              abi: mockEURCAbi,
              functionName: 'allowance',
              args: [address, factory],
            })
        if (allowance >= amount) {
          await publicClient.simulateContract({
            account: address,
            address: factory,
            abi: factoryCallAbi,
            functionName: 'donate',
            args,
            value: native ? amount : undefined,
          })
          return { ok: true }
        }
      } catch (error) {
        return classify(error)
      }

      try {
        const { results } = await publicClient.simulateCalls({
          account: address,
          calls: [
            { to: token, abi: mockEURCAbi, functionName: 'approve', args: [factory, amount] },
            { to: factory, abi: factoryCallAbi, functionName: 'donate', args },
          ],
        })
        const failed = results.find((result) => result.status === 'failure')
        return failed ? classify(failed.error) : { ok: true }
      } catch {
        return { ok: true }
      }
    },
    [address, publicClient],
  )
}

/** Turns a preflight revert into the sentence a donor reads (namespace `conversion`). */
export const useRevertMessage = () => {
  const t = useTranslations('conversion')
  return useCallback(
    (reason: string): string => {
      const key = REVERT_MESSAGES[reason]
      return key ? t(key) : t('revertOther', { reason })
    },
    [t],
  )
}

export interface ConversionQuote {
  /** The part of the input the donation converts: all of it, or just what fills the need. */
  used: bigint | undefined
  /** Input beyond what the need can still take; `factory.donate` hands it back unconverted. */
  returned: bigint
  /** What `used` is worth in the vault token at Chainlink prices. */
  fairValue: bigint | undefined
  /** The least the conversion may return before it reverts. */
  minimum: bigint | undefined
  slippageBps: number | null
  /** The router cannot price it right now (stale feed, no route): the donation would revert. */
  unavailable: boolean
}

/**
 * Live quote for donating `amount` of `tokenIn` to a need that still takes `remaining` of the vault token, refreshed
 * every 30 seconds: how much of the input will be used, what that is worth, and the floor the swap must clear.
 */
export const useConversionQuote = (
  tokenIn: Address | undefined,
  amount: bigint | null,
  remaining: bigint,
): ConversionQuote => {
  const router = deployment?.contracts.ConversionRouter
  const vaultToken = deployment?.external.Token
  const routeKnown = Boolean(router && vaultToken && tokenIn !== undefined)
  const enabled = routeKnown && amount !== null && amount > 0n && remaining > 0n
  const refresh = { refetchInterval: 30_000, retry: false } as const

  const maxInput = useReadContract({
    address: router,
    abi: conversionRouterAbi,
    functionName: 'maxInputFor',
    args: enabled ? [tokenIn as Address, vaultToken as Address, remaining] : undefined,
    query: { ...refresh, enabled },
  })
  const cap = enabled ? maxInput.data : undefined
  const used = enabled && amount !== null ? (cap !== undefined && amount > cap ? cap : amount) : undefined

  const quote = useReadContract({
    address: router,
    abi: conversionRouterAbi,
    functionName: 'quote',
    args: enabled && used !== undefined ? [tokenIn as Address, used, vaultToken as Address] : undefined,
    query: { ...refresh, enabled: enabled && used !== undefined },
  })
  const slippage = useReadContract({
    address: router,
    abi: conversionRouterAbi,
    functionName: 'maxSlippageBpsOf',
    args: routeKnown ? [tokenIn as Address, vaultToken as Address] : undefined,
    query: { enabled: routeKnown, retry: false },
  })

  const slippageBps =
    slippage.data ?? (deployment && tokenIn !== undefined ? configuredSlippageBps(deployment, tokenIn) : null)
  const fairValue = enabled ? quote.data : undefined
  return {
    used,
    returned: amount !== null && used !== undefined && amount > used ? amount - used : 0n,
    fairValue,
    minimum: fairValue !== undefined && slippageBps !== null ? minimumOut(fairValue, slippageBps) : undefined,
    slippageBps,
    unavailable: enabled && (quote.isError || maxInput.isError),
  }
}
