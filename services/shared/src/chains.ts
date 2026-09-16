import { type Chain, defineChain, type Hex } from 'viem'
import { base, baseSepolia } from 'viem/chains'
import type { NetworkName } from './types.js'

/** Local development chain (anvil). */
export const anvil = defineChain({
  id: 31_337,
  name: 'Anvil',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
})

export const CHAINS: Record<NetworkName, Chain> = {
  'base-sepolia': baseSepolia,
  base,
  anvil,
}

export const NETWORK_BY_CHAIN_ID: Record<number, NetworkName> = {
  84532: 'base-sepolia',
  8453: 'base',
  31337: 'anvil',
}

export const chainFor = (network: NetworkName): Chain => CHAINS[network]

export const networkFor = (chainId: number): NetworkName => {
  const network = NETWORK_BY_CHAIN_ID[chainId]
  if (!network) throw new Error(`Unsupported chain id ${chainId}`)
  return network
}

const BLOCK_EXPLORERS: Record<NetworkName, string | null> = {
  'base-sepolia': 'https://sepolia.basescan.org',
  base: 'https://basescan.org',
  anvil: null,
}

const EAS_EXPLORERS: Record<NetworkName, string | null> = {
  'base-sepolia': 'https://base-sepolia.easscan.org',
  base: 'https://base.easscan.org',
  anvil: null,
}

/** Block explorer link for a transaction, or null on a local chain that has no explorer. */
export const explorerTxUrl = (network: NetworkName, hash: Hex): string | null => {
  const base_ = BLOCK_EXPLORERS[network]
  return base_ ? `${base_}/tx/${hash}` : null
}

export const explorerAddressUrl = (network: NetworkName, address: string): string | null => {
  const base_ = BLOCK_EXPLORERS[network]
  return base_ ? `${base_}/address/${address}` : null
}

/** EAS explorer link for an attestation, where the evidence chain can be followed through refUIDs. */
export const easAttestationUrl = (network: NetworkName, uid: Hex): string | null => {
  const base_ = EAS_EXPLORERS[network]
  return base_ ? `${base_}/attestation/view/${uid}` : null
}

export const easSchemaUrl = (network: NetworkName, uid: Hex): string | null => {
  const base_ = EAS_EXPLORERS[network]
  return base_ ? `${base_}/schema/view/${uid}` : null
}
