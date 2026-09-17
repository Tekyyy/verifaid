import type { ForwarderIntent } from '@poa/shared'
import { type Address, getAddress, type Hex, isAddress, isAddressEqual, isHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { IntentJson } from './appApi'

/**
 * The refund-key file a donor downloads before they see their deposit address. It holds everything needed to get
 * money back out of that address without this website: the intent the address commits to, the chain, and the
 * private key whose address is the intent's `refundSigner`.
 *
 * The key is generated in the browser, written only into this file and never sent anywhere. Refunds are signed
 * locally from it; only the signature goes to the relayer.
 */

export const REFUND_KEY_FORMAT = 'proof-of-aid/deposit-refund-key'

export interface RefundKeyFile {
  format: typeof REFUND_KEY_FORMAT
  version: 1
  chainId: number
  network: string
  depositAddress: Address
  factory: Address
  intent: IntentJson
  refundKey: Hex
  /** Path of the public tracking page on the site that created the address. */
  trackingPath: string
  createdAt: string
  notice: string
}

export const intentToJson = (intent: ForwarderIntent): IntentJson => ({
  needId: intent.needId.toString(),
  receiptTo: intent.receiptTo,
  refundTo: intent.refundTo,
  refundSigner: intent.refundSigner,
  salt: intent.salt,
})

export const refundKeyFileName = (depositAddress: Address): string =>
  `proof-of-aid-refund-key-${depositAddress.slice(2, 10).toLowerCase()}.json`

export type RefundKeyProblem = 'malformed' | 'wrongChain' | 'wrongAddress' | 'keyMismatch'

/**
 * Validates a loaded file against the page it is used on. `keyMismatch` means the key does not belong to the
 * intent in the file (or to the refund signer the indexer knows for this address) — a corrupted or edited file.
 */
export const parseRefundKeyFile = (
  text: string,
  expected: { chainId: number; depositAddress: string; refundSigner?: string | null },
): { ok: true; file: RefundKeyFile } | { ok: false; problem: RefundKeyProblem } => {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text) as Record<string, unknown>
  } catch {
    return { ok: false, problem: 'malformed' }
  }
  const intent = raw?.intent as Record<string, unknown> | undefined
  if (
    raw?.format !== REFUND_KEY_FORMAT ||
    typeof raw.depositAddress !== 'string' ||
    !isAddress(raw.depositAddress, { strict: false }) ||
    typeof raw.refundKey !== 'string' ||
    !isHex(raw.refundKey) ||
    raw.refundKey.length !== 66 ||
    typeof intent?.refundSigner !== 'string' ||
    !isAddress(intent.refundSigner, { strict: false })
  ) {
    return { ok: false, problem: 'malformed' }
  }
  if (raw.chainId !== expected.chainId) return { ok: false, problem: 'wrongChain' }
  if (!isAddress(expected.depositAddress, { strict: false })) return { ok: false, problem: 'wrongAddress' }
  if (!isAddressEqual(getAddress(raw.depositAddress), getAddress(expected.depositAddress))) {
    return { ok: false, problem: 'wrongAddress' }
  }
  const signer = privateKeyToAccount(raw.refundKey).address
  if (!isAddressEqual(signer, getAddress(intent.refundSigner))) return { ok: false, problem: 'keyMismatch' }
  if (expected.refundSigner && !isAddressEqual(signer, getAddress(expected.refundSigner))) {
    return { ok: false, problem: 'keyMismatch' }
  }
  return { ok: true, file: raw as unknown as RefundKeyFile }
}

/** Offers `data` as a JSON file download; false when the browser refused. */
export const downloadJson = (fileName: string, data: unknown): boolean => {
  try {
    const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    link.rel = 'noopener'
    document.body.appendChild(link)
    link.click()
    link.remove()
    // Revoked later, not now: some browsers start the download asynchronously.
    setTimeout(() => URL.revokeObjectURL(url), 1_000)
    return true
  } catch {
    return false
  }
}
