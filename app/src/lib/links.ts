import { easAttestationUrl, explorerAddressUrl, explorerTxUrl } from '@poa/shared'
import type { Hex } from 'viem'
import { network } from './config'

/**
 * Explorer links for the configured network. All of these return `null` on anvil, which has no explorer —
 * callers fall back to rendering the raw hash so a local demo never shows a dead link.
 */
export const txUrl = (hash: Hex): string | null => explorerTxUrl(network, hash)
export const addressUrl = (address: string): string | null => explorerAddressUrl(network, address)
export const attestationUrl = (uid: Hex): string | null => easAttestationUrl(network, uid)

export const isZeroUid = (uid: string | null | undefined): boolean => !uid || /^0x0{64}$/i.test(uid)
