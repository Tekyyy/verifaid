import { createHash } from 'node:crypto'
import { easAbi } from '@poa/shared'
import { type Abi, type Address, type Hex, parseEventLogs, type TransactionReceipt } from 'viem'
import type { DemoContext, RoleName } from './config.js'
import { fail } from './log.js'

export interface SendResult {
  hash: Hex
  receipt: TransactionReceipt
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Sends a transaction as `role` and waits for it, failing loudly on revert.
 *
 * Retries the simulation a few times on a public network: `sepolia.base.org` load-balances across nodes, so an
 * `eth_call` issued right after a mined transaction can land on one that has not caught up yet and revert with
 * something misleading like `NeedNotFound`. A genuine revert simply fails all the attempts.
 */
export const send = async (
  ctx: DemoContext,
  role: RoleName,
  params: { address: Address; abi: Abi; functionName: string; args: readonly unknown[]; value?: bigint },
): Promise<SendResult> => {
  const wallet = ctx.wallets[role]
  const account = ctx.accounts[role]
  const attempts = ctx.isLocal ? 1 : 4
  let lastError: unknown

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // Simulate first so a revert surfaces as a decoded custom error instead of an opaque failed receipt.
      const { request } = await ctx.publicClient.simulateContract({ ...params, account })
      const hash = await wallet.writeContract(request)
      const receipt = await ctx.publicClient.waitForTransactionReceipt({
        hash,
        confirmations: ctx.isLocal ? undefined : 2,
      })
      if (receipt.status !== 'success') fail(`${params.functionName} reverted on-chain (${hash})`)
      return { hash, receipt }
    } catch (error) {
      lastError = error
      if (attempt < attempts) await sleep(3000)
    }
  }

  const message = (lastError as Error).message ?? String(lastError)
  return fail(`${params.functionName} as ${role}: ${message.split('\n').slice(0, 4).join(' | ')}`)
}

export interface AttestParams {
  schema: Hex
  recipient: Address
  data: Hex
  revocable: boolean
  refUID?: Hex
}

const ZERO_UID = `0x${'00'.repeat(32)}` as Hex

/** Creates an EAS attestation and returns its UID, read back from the `Attested` event. */
export const attest = async (
  ctx: DemoContext,
  role: RoleName,
  params: AttestParams,
): Promise<{ uid: Hex; hash: Hex }> => {
  const { hash, receipt } = await send(ctx, role, {
    address: ctx.deployment.external.EAS,
    abi: easAbi as Abi,
    functionName: 'attest',
    args: [
      {
        schema: params.schema,
        data: {
          recipient: params.recipient,
          expirationTime: 0n,
          revocable: params.revocable,
          refUID: params.refUID ?? ZERO_UID,
          data: params.data,
          value: 0n,
        },
      },
    ],
  })

  const logs = parseEventLogs({ abi: easAbi, eventName: 'Attested', logs: receipt.logs })
  const uid = logs[0]?.args?.uid as Hex | undefined
  if (!uid) return fail('attestation succeeded but no Attested event was emitted')
  return { uid, hash }
}

/** Reads a single event argument out of a receipt. */
export const eventArg = <T>(receipt: TransactionReceipt, abi: Abi, eventName: string, argName: string): T => {
  const logs = parseEventLogs({ abi, eventName, logs: receipt.logs })
  const args = logs[0]?.args as Record<string, unknown> | undefined
  const value = args?.[argName]
  if (value === undefined) return fail(`event ${eventName}.${argName} not found in receipt`)
  return value as T
}

/**
 * Waits out the challenge period: instantly on anvil, in real time on a public testnet
 * (which is why the demo deployment uses a short CHALLENGE_PERIOD_SECONDS).
 */
export const waitChallengePeriod = async (ctx: DemoContext, seconds: number): Promise<void> => {
  if (ctx.isLocal) {
    await ctx.publicClient.request({ method: 'evm_increaseTime', params: [seconds + 1] } as never)
    await ctx.publicClient.request({ method: 'evm_mine', params: [] } as never)
    return
  }
  const deadline = Date.now() + (seconds + 5) * 1000
  while (Date.now() < deadline) {
    const remaining = Math.ceil((deadline - Date.now()) / 1000)
    process.stdout.write(`\r    waiting out the challenge window: ${remaining}s   `)
    await new Promise((r) => setTimeout(r, 5000))
  }
  process.stdout.write('\r                                                   \r')
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

/** RFC 4648 base32, lower case, unpadded — the encoding CIDv1 uses by default. */
const base32Encode = (bytes: Uint8Array): string => {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31]
  return output
}

/**
 * A real CIDv1 (raw codec, sha2-256) for a payload, so the demo can anchor evidence without a running IPFS
 * node. When the evidence service is up it returns the CID of the content it actually pinned instead.
 */
export const cidV1Raw = (bytes: Uint8Array): string => {
  const digest = createHash('sha256').update(bytes).digest()
  const prefix = Uint8Array.from([0x01, 0x55, 0x12, 0x20])
  const cid = new Uint8Array(prefix.length + digest.length)
  cid.set(prefix)
  cid.set(digest, prefix.length)
  return `b${base32Encode(cid)}`
}
