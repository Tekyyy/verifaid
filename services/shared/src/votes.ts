import type { Address } from 'viem'

/**
 * The EIP-712 message behind `DeliveryManager.voteBySig`: a donor or verifier signs their vote for free and a
 * relayer pays to put it on chain. The contract rebuilds exactly this, so every signer (the browser, the demo) and
 * every checker (the relay route) must use this one definition.
 */

/** Mirrors the `EIP712("VerifAid Deliveries", "1")` domain of DeliveryManager. */
export const VOTE_DOMAIN_NAME = 'VerifAid Deliveries'
export const VOTE_DOMAIN_VERSION = '1'

export const VOTE_TYPES = {
  Vote: [
    { name: 'voter', type: 'address' },
    { name: 'deliveryId', type: 'uint256' },
    { name: 'approve', type: 'bool' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

/** How long a signed vote stays valid: long enough to relay, short enough that a stale one is useless. */
export const VOTE_SIGNATURE_TTL_SECONDS = 3600

export interface VoteMessage {
  voter: Address
  deliveryId: bigint
  approve: boolean
  deadline: bigint
}

export const voteTypedData = (options: { chainId: number; deliveryManager: Address } & VoteMessage) =>
  ({
    domain: {
      name: VOTE_DOMAIN_NAME,
      version: VOTE_DOMAIN_VERSION,
      chainId: options.chainId,
      verifyingContract: options.deliveryManager,
    },
    types: VOTE_TYPES,
    primaryType: 'Vote',
    message: {
      voter: options.voter,
      deliveryId: options.deliveryId,
      approve: options.approve,
      deadline: options.deadline,
    },
  }) as const
