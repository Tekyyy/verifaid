import { AID_RECEIVED_MESSAGE, deliveryManagerAbi } from '@poa/shared'
import { type NextRequest, NextResponse } from 'next/server'
import { deployment } from '@/lib/config'
import { getRelayer, relayWrite } from '@/lib/server/relayer'

/**
 * Relays a beneficiary's receipt confirmation.
 *
 * Why a relayer at all: `confirmReceipt` is permissionless, so a beneficiary could send it themselves — but
 * then the transaction sender would be linked on chain to the delivery they confirmed, which is exactly the
 * link the zero-knowledge proof exists to break. The relayer pays the gas and appears as the sender; the
 * proof still guarantees the confirmation came from an enrolled member, once.
 *
 * This route deliberately never logs the nullifier. A nullifier plus a timestamp, an IP or a user agent would
 * re-create the correlation the design removes.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UINT256_MAX = (1n << 256n) - 1n

const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_PER_DELIVERY = 30

// Per-process only. A multi-instance deployment needs a shared store; the contract is the real guard —
// Semaphore rejects a reused nullifier and the confirmation count is capped at `expectedRecipients`.
const attempts = new Map<string, number[]>()

const rateLimited = (deliveryId: string): boolean => {
  const now = Date.now()
  const recent = (attempts.get(deliveryId) ?? []).filter((at) => now - at < RATE_LIMIT_WINDOW_MS)
  recent.push(now)
  attempts.set(deliveryId, recent)
  return recent.length > RATE_LIMIT_PER_DELIVERY
}

/**
 * Every field of a Semaphore proof is a `uint256` on chain. It is deliberately not narrowed to the scalar
 * field here: `message` carries `uint256(keccak256("AID_RECEIVED"))`, which is larger than the BN254 modulus,
 * and the proof's own coordinates live in the base field. Cryptographic validity is the verifier's job; this
 * check only rejects malformed input before it costs gas.
 */
const isUint256 = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{1,78}$/.test(value) && BigInt(value) <= UINT256_MAX

interface SemaphoreProofInput {
  merkleTreeDepth: number
  merkleTreeRoot: string
  nullifier: string
  message: string
  scope: string
  points: string[]
}

const parseProof = (value: unknown): SemaphoreProofInput | null => {
  if (typeof value !== 'object' || value === null) return null
  const proof = value as Record<string, unknown>
  const depth = Number(proof.merkleTreeDepth)
  if (!Number.isInteger(depth) || depth < 1 || depth > 32) return null
  if (!isUint256(proof.merkleTreeRoot)) return null
  if (!isUint256(proof.nullifier)) return null
  if (!isUint256(proof.message)) return null
  if (!isUint256(proof.scope)) return null
  if (!Array.isArray(proof.points) || proof.points.length !== 8) return null
  if (!proof.points.every(isUint256)) return null

  return {
    merkleTreeDepth: depth,
    merkleTreeRoot: proof.merkleTreeRoot,
    nullifier: proof.nullifier,
    message: proof.message,
    scope: proof.scope,
    points: proof.points as string[],
  }
}

/**
 * A short, single-line reason. Semaphore's own custom errors (a reused nullifier, for instance) are not in
 * our ABI, so viem cannot name them; the raw selector still tells an operator what happened.
 */
const revertReason = (error: unknown): string => {
  if (!(error instanceof Error)) return 'rejected'
  const head = error.message.split('Contract Call:')[0] ?? error.message
  return head.replace(/\s+/g, ' ').trim().slice(0, 200) || 'rejected'
}

export async function POST(request: NextRequest) {
  const addresses = deployment
  if (!addresses) {
    return NextResponse.json({ error: 'no deployment for this network' }, { status: 503 })
  }

  // Shared with the deposit-address and sandbox on-ramp routes: one queue, so no two writes race for a nonce.
  const relayer = getRelayer()
  if (!relayer) {
    return NextResponse.json({ error: 'relayer not configured' }, { status: 503 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  }

  const { deliveryId, proof: rawProof } = (body ?? {}) as { deliveryId?: unknown; proof?: unknown }
  if (typeof deliveryId !== 'string' || !/^\d{1,20}$/.test(deliveryId)) {
    return NextResponse.json({ error: 'invalid deliveryId' }, { status: 400 })
  }

  const proof = parseProof(rawProof)
  if (!proof) {
    return NextResponse.json({ error: 'invalid proof' }, { status: 400 })
  }

  // The contract enforces both of these too; rejecting here avoids paying gas to learn it.
  if (BigInt(proof.scope) !== BigInt(deliveryId)) {
    return NextResponse.json({ error: 'scope must equal the delivery id' }, { status: 400 })
  }
  if (BigInt(proof.message) !== AID_RECEIVED_MESSAGE) {
    return NextResponse.json({ error: 'unexpected message' }, { status: 400 })
  }

  if (rateLimited(deliveryId)) {
    return NextResponse.json({ error: 'too many confirmations for this delivery' }, { status: 429 })
  }

  const args = [
    BigInt(deliveryId),
    {
      merkleTreeDepth: BigInt(proof.merkleTreeDepth),
      merkleTreeRoot: BigInt(proof.merkleTreeRoot),
      nullifier: BigInt(proof.nullifier),
      message: BigInt(proof.message),
      scope: BigInt(proof.scope),
      points: proof.points.map((point) => BigInt(point)) as unknown as readonly [
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
      ],
    },
  ] as const

  try {
    const hash = await relayWrite(relayer, {
      address: addresses.contracts.DeliveryManager,
      abi: deliveryManagerAbi,
      functionName: 'confirmReceipt',
      args,
    })
    return NextResponse.json({ txHash: hash })
  } catch (error) {
    // Only the reason is surfaced. The proof, and above all the nullifier, are never written to a log.
    return NextResponse.json({ error: revertReason(error) }, { status: 400 })
  }
}
