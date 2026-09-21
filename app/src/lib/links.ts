import {
  easAttestationUrl,
  explorerAddressUrl,
  explorerNftUrl,
  explorerReadContractUrl,
  explorerTxUrl,
} from '@poa/shared'
import type { Hex } from 'viem'
import { network } from './config'

/**
 * Explorer links for the configured network. All of these return `null` on anvil, which has no explorer —
 * callers fall back to rendering the raw hash so a local demo never shows a dead link.
 */
export const txUrl = (hash: Hex): string | null => explorerTxUrl(network, hash)
export const addressUrl = (address: string): string | null => explorerAddressUrl(network, address)
export const attestationUrl = (uid: Hex): string | null => easAttestationUrl(network, uid)
export const nftUrl = (contract: string, tokenId: string | number | bigint): string | null =>
  explorerNftUrl(network, contract, tokenId)
export const readContractUrl = (address: string): string | null => explorerReadContractUrl(network, address)

export const isZeroUid = (uid: string | null | undefined): boolean => !uid || /^0x0{64}$/i.test(uid)
