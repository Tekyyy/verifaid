import { type Address, getAddress, type Hex, pad, zeroAddress } from 'viem'
import type { Deployment } from './types.js'

/**
 * v3 conversions: what a donor can give, and the pieces of the deposit-address protocol that the app, the relayer
 * and the indexer must agree on byte for byte with `DonationForwarder`.
 */

/** `ConversionRouter.NATIVE()`: ETH is passed as the zero address. */
export const NATIVE_TOKEN: Address = zeroAddress

export type DonationTokenSymbol = 'EURC' | 'USDC' | 'ETH'

export interface DonationToken {
  symbol: DonationTokenSymbol
  address: Address
  decimals: number
  native: boolean
  /** False for the vault token itself (donated directly); true when the factory swaps it on the way in. */
  converted: boolean
}

/**
 * Tokens this deployment accepts, the vault token first. USDC and ETH appear only when the deployment has the
 * conversion contracts and (for ETH) a configured route.
 */
export const donationTokens = (deployment: Deployment): DonationToken[] => {
  const tokens: DonationToken[] = [
    { symbol: 'EURC', address: deployment.external.Token, decimals: 6, native: false, converted: false },
  ]
  if (!deployment.contracts.DonationForwarderFactory) return tokens
  if (deployment.external.USDC) {
    tokens.push({
      symbol: 'USDC',
      address: deployment.external.USDC,
      decimals: 6,
      native: false,
      converted: true,
    })
  }
  if (deployment.params.ethDonations) {
    tokens.push({ symbol: 'ETH', address: NATIVE_TOKEN, decimals: 18, native: true, converted: true })
  }
  return tokens
}

/** Symbol for a token address seen in an event; WETH reads as ETH because donors sent ETH. */
export const tokenSymbolOf = (deployment: Deployment, token: string): string => {
  const address = token.toLowerCase()
  if (address === NATIVE_TOKEN) return 'ETH'
  if (address === deployment.external.Token.toLowerCase()) return 'EURC'
  if (address === deployment.external.USDC?.toLowerCase()) return 'USDC'
  if (address === deployment.external.WETH?.toLowerCase()) return 'ETH'
  return getAddress(token)
}

export const tokenDecimalsOf = (deployment: Deployment, token: string): number =>
  tokenSymbolOf(deployment, token) === 'ETH' ? 18 : 6

/** The vault's refund key for money a deposit address donated: `bytes32(uint256(uint160(forwarder)))`. */
export const depositRefHash = (depositAddress: Address): Hex =>
  pad(depositAddress.toLowerCase() as Hex, { size: 32 })

/** `IDonationForwarder.Intent`: everything a deposit address commits to, in the order the contract encodes it. */
export interface ForwarderIntent {
  needId: bigint
  /** Wallet credited with the donation and its receipt; zero to credit the deposit address itself. */
  receiptTo: Address
  /** Where leftovers and refunds go without a signature; zero when only the refund key can direct them. */
  refundTo: Address
  /** EIP-712 signer that can direct refunds (the donor's downloaded refund key). */
  refundSigner: Address
  salt: Hex
}

export const forwarderIntentAbi = {
  type: 'tuple',
  components: [
    { name: 'needId', type: 'uint256' },
    { name: 'receiptTo', type: 'address' },
    { name: 'refundTo', type: 'address' },
    { name: 'refundSigner', type: 'address' },
    { name: 'salt', type: 'bytes32' },
  ],
} as const

/** EIP-712 domain of one deposit address (each clone is its own verifying contract). */
export const forwarderDomain = (chainId: number, depositAddress: Address) =>
  ({ name: 'ProofOfAidDonationForwarder', version: '1', chainId, verifyingContract: depositAddress }) as const

export const forwarderRefundTypes = {
  Refund: [
    { name: 'token', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

export const forwarderVaultRefundTypes = {
  VaultRefund: [
    { name: 'to', type: 'address' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const
