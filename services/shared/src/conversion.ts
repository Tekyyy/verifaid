import { type Address, getAddress, type Hex, pad, zeroAddress } from 'viem'
import type { Deployment } from './types.js'

/**
 * v3 conversions: what a donor can give, and the pieces of the deposit-address protocol that the app, the relayer
 * and the indexer must agree on byte for byte with `DonationForwarder`.
 */

/** `ConversionRouter.NATIVE()`: ETH is passed as the zero address. */
export const NATIVE_TOKEN: Address = zeroAddress

export type DonationTokenSymbol = 'USDC' | 'EURC' | 'ETH'

export interface DonationToken {
  symbol: DonationTokenSymbol
  address: Address
  decimals: number
  native: boolean
  /** False for the vault token itself (donated directly); true when the factory swaps it on the way in. */
  converted: boolean
}

const same = (a: string | undefined, b: string | undefined): boolean =>
  Boolean(a && b && a.toLowerCase() === b.toLowerCase())

/**
 * The currency this deployment holds: vaults, tranches and every published figure are denominated in it.
 * Deployments are USD by default; a euro deployment holds EURC instead.
 */
export const vaultCurrency = (deployment: Deployment): DonationToken => ({
  symbol: same(deployment.external.Token, deployment.external.EURC) ? 'EURC' : 'USDC',
  address: deployment.external.Token,
  decimals: 6,
  native: false,
  converted: false,
})

/**
 * Tokens this deployment accepts, the vault currency first. The others are converted on the way in, so they are
 * only offered when the deployment has a forwarder to convert them.
 */
export const donationTokens = (deployment: Deployment): DonationToken[] => {
  const vault = vaultCurrency(deployment)
  const tokens: DonationToken[] = [vault]
  if (!deployment.contracts.DonationForwarderFactory) return tokens
  const convertible: [DonationTokenSymbol, Address | undefined][] = [
    ['USDC', deployment.external.USDC],
    ['EURC', deployment.external.EURC],
  ]
  for (const [symbol, address] of convertible) {
    if (address && !same(address, vault.address)) {
      tokens.push({ symbol, address, decimals: 6, native: false, converted: true })
    }
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
  if (same(address, deployment.external.WETH)) return 'ETH'
  if (same(address, deployment.external.USDC)) return 'USDC'
  if (same(address, deployment.external.EURC)) return 'EURC'
  if (same(address, deployment.external.Token)) return vaultCurrency(deployment).symbol
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

/**
 * Refund authorizations signed with the donor's refund key. `nonce` is `DonationForwarder.nonce()` at signing time:
 * each signature works once, so it cannot be replayed on money that arrives later.
 */
export const forwarderRefundTypes = {
  Refund: [
    { name: 'token', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

export const forwarderVaultRefundTypes = {
  VaultRefund: [
    { name: 'to', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const
