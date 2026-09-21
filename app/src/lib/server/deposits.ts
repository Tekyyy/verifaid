import {
  type Deployment,
  type DonationTokenSymbol,
  donationForwarderFactoryAbi,
  donationTokens,
  type ForwarderIntent,
  NATIVE_TOKEN,
  vaultCurrency,
} from '@poa/shared'
import { type Address, getAddress, isAddress, isHex, zeroAddress } from 'viem'
import { conversionsEnabled, deployment } from '../config'
import { publicClient } from './chain'
import { isNeedId } from './proxy'

/**
 * Server-side pieces of the deposit-address flow shared by `/api/deposits/*`: intent validation, the factory
 * membership check and the tokens an address may hold.
 */

export interface ForwarderContext {
  deployment: Deployment
  factory: Address
}

/** The deployment and its forwarder factory, or null on a build without v3 conversions. */
export const forwarderContext = (): ForwarderContext | null => {
  const factory = deployment?.contracts.DonationForwarderFactory
  return deployment && conversionsEnabled && factory ? { deployment, factory } : null
}

const isAddressString = (value: unknown): value is string =>
  typeof value === 'string' && isAddress(value, { strict: false })

/**
 * Parses the intent a browser built. The refund signer is required here even though the contract would accept a
 * refund address alone: this app always gives the donor a refund key, and without one an exchange withdrawal with
 * no refund address could never be sent back.
 */
export const parseIntent = (value: unknown): ForwarderIntent | null => {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  if (!isNeedId(raw.needId)) return null
  if (!isAddressString(raw.receiptTo) || !isAddressString(raw.refundTo)) return null
  if (!isAddressString(raw.refundSigner) || /^0x0{40}$/i.test(raw.refundSigner)) return null
  if (typeof raw.salt !== 'string' || !isHex(raw.salt) || raw.salt.length !== 66) return null
  return {
    needId: BigInt(raw.needId),
    receiptTo: getAddress(raw.receiptTo),
    refundTo: getAddress(raw.refundTo),
    refundSigner: getAddress(raw.refundSigner),
    salt: raw.salt.toLowerCase() as `0x${string}`,
  }
}

/** Route parameter → checksummed address, or null. */
export const parseDepositAddress = (value: string): Address | null =>
  /^0x[0-9a-fA-F]{40}$/.test(value) && value.toLowerCase() !== zeroAddress ? getAddress(value) : null

/** True only for clones this factory deployed: nothing else is swept or relayed for. */
export const isFactoryForwarder = (context: ForwarderContext, address: Address): Promise<boolean> =>
  publicClient.readContract({
    address: context.factory,
    abi: donationForwarderFactoryAbi,
    functionName: 'isForwarder',
    args: [address],
  })

/** Sweeping is limited to the intent's own addresses and keepers the factory admin registered. */
export const isKeeper = (context: ForwarderContext, address: Address): Promise<boolean> =>
  publicClient.readContract({
    address: context.factory,
    abi: donationForwarderFactoryAbi,
    functionName: 'isKeeper',
    args: [address],
  })

export interface DepositToken {
  symbol: DonationTokenSymbol
  address: Address
}

/**
 * What a deposit address may hold, in sweep order: the tokens that have to be converted first, the vault's own
 * currency last, because sweeping that one is a pass-through that cannot fail on a price.
 */
export const depositTokens = (context: ForwarderContext): DepositToken[] => {
  const vault = vaultCurrency(context.deployment)
  const converted = donationTokens(context.deployment).filter((token) => token.converted && !token.native)
  return [
    ...converted.map(({ symbol, address }) => ({ symbol, address })),
    // ETH is always listed: an exchange withdrawal can land here even where the deployment does not advertise it.
    { symbol: 'ETH', address: NATIVE_TOKEN },
    { symbol: vault.symbol, address: vault.address },
  ]
}

/** Reverts that describe the state of a deposit address rather than a fault: reported, never a 5xx. */
export const EXPECTED_REVERTS = new Set([
  'NothingToSweep',
  'NotAccepting',
  'NothingToRefund',
  'NotRefundable',
  'Unauthorized',
  'SignatureExpired',
  'InvalidSignature',
])
