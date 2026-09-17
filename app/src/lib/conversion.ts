import {
  type Deployment,
  donationForwarderAbi,
  forwarderDomain,
  forwarderRefundTypes,
  forwarderVaultRefundTypes,
  NATIVE_TOKEN,
} from '@poa/shared'
import type { Address, Hex, PublicClient } from 'viem'

/**
 * Pure helpers for the v3 conversion contracts, shared by the browser and the relay routes (the React side is in
 * `conversionHooks.ts`): the configured slippage bound, the conversion floor, and the EIP-712 payload a refund key
 * signs, including the deposit address's replay nonce.
 */

/** The bound the deployment was configured with, for when the live read is unavailable. */
export const configuredSlippageBps = (deployment: Deployment, tokenIn: Address): number | null =>
  tokenIn === NATIVE_TOKEN
    ? (deployment.params.ethMaxSlippageBps ?? null)
    : (deployment.params.maxSlippageBps ?? null)

/** The least a conversion may return before it reverts: fair value minus the slippage bound. */
export const minimumOut = (fairValue: bigint, slippageBps: number): bigint =>
  (fairValue * (10_000n - BigInt(slippageBps))) / 10_000n

// ─── refund signatures ─────────────────────────────────────────────────────────

/** The deposit address's current refund nonce. Read right before signing: every use moves it. */
export const readRefundNonce = (
  client: Pick<PublicClient, 'readContract'>,
  depositAddress: Address,
): Promise<bigint> =>
  client.readContract({ address: depositAddress, abi: donationForwarderAbi, functionName: 'nonce' })

export type RefundKind = 'leftover' | 'vault'

export interface RefundRequest {
  chainId: number
  depositAddress: Address
  kind: RefundKind
  /** `leftover` only; the zero address for ETH. */
  token: Address
  to: Address
  deadline: bigint
  nonce: bigint
}

/** The EIP-712 payload a refund key signs, and the relay route recovers, for one refund. */
export const refundTypedData = ({
  chainId,
  depositAddress,
  kind,
  token,
  to,
  deadline,
  nonce,
}: RefundRequest) => {
  const domain = forwarderDomain(chainId, depositAddress)
  return kind === 'leftover'
    ? ({
        domain,
        types: forwarderRefundTypes,
        primaryType: 'Refund',
        message: { token, to, nonce, deadline },
      } as const)
    : ({
        domain,
        types: forwarderVaultRefundTypes,
        primaryType: 'VaultRefund',
        message: { to, nonce, deadline },
      } as const)
}

/** Signature bytes as the relay route accepts them. */
export const isSignature = (value: string): value is Hex => /^0x[0-9a-fA-F]{130}$/.test(value)
