import { deliveryManagerAbi, VOTE_SIGNATURE_TTL_SECONDS, voteTypedData } from '@poa/shared'
import { type NextRequest, NextResponse } from 'next/server'
import { type Address, getAddress, type Hex, isAddress, isHex } from 'viem'
import { chainId, deployment } from '@/lib/config'
import { publicClient } from '@/lib/server/chain'
import { badRequest, readJson } from '@/lib/server/proxy'
import { clientIp, createRateLimiter } from '@/lib/server/rateLimit'
import { getRelayer, relayWrite, revertOf, waitForReceipt, withChainErrors } from '@/lib/server/relayer'

/**
 * Relays a vote on a delivery that a donor or verifier signed in their browser (`DeliveryManager.voteBySig`), so
 * voting never costs gas. The route checks the signature before spending any — against the voter's address, so a
 * smart wallet's ERC-1271 signature counts as well as a plain key's — and simulates the call, so a vote the
 * contract would refuse (no say, already voted, already decided) comes back as its reason instead of a failed
 * transaction. The contract checks everything again: the relayer can pay for a vote, never cast one.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Refusals that are the voter's situation, not the server's: answered 409 with the contract's reason. */
const EXPECTED_REVERTS = new Set([
  'AlreadyVoted',
  'NoSay',
  'InvalidDeliveryStatus',
  'InvalidNeedStatus',
  'DeliveryNotFound',
  'SignatureExpired',
  'InvalidSignature',
  'SystemPaused',
])

/** Smart-wallet signatures (WebAuthn, ERC-6492) run to a few kilobytes; nothing legitimate is longer. */
const MAX_SIGNATURE_BYTES = 4096

const perVoter = createRateLimiter({ windowMs: 10 * 60_000, max: 10 })
const perIp = createRateLimiter({ windowMs: 10 * 60_000, max: 30 })

async function handle(request: NextRequest) {
  const manager = deployment?.contracts.DeliveryManager as Address | undefined
  if (!manager) {
    return NextResponse.json({ error: 'unavailable', message: 'No deployment.' }, { status: 503 })
  }
  const relayer = getRelayer()
  if (!relayer) {
    return NextResponse.json({ error: 'unavailable', message: 'relayer not configured' }, { status: 503 })
  }

  const body = await readJson(request)
  if (!body) return badRequest('Body must be a JSON object.')
  const { deliveryId, voter, approve, deadline, signature } = body
  if (typeof deliveryId !== 'string' || !/^\d{1,20}$/.test(deliveryId)) {
    return badRequest('deliveryId must be a decimal string.')
  }
  if (typeof voter !== 'string' || !isAddress(voter, { strict: false }))
    return badRequest('voter must be a 0x address.')
  if (typeof approve !== 'boolean') return badRequest('approve must be true or false.')
  if (typeof deadline !== 'string' || !/^\d{1,12}$/.test(deadline)) {
    return badRequest('deadline must be unix seconds as a decimal string.')
  }
  // The contract judges the deadline by block time, so this does too: the two clocks are not always the same.
  const now = Number((await publicClient.getBlock()).timestamp)
  if (Number(deadline) <= now || Number(deadline) > now + VOTE_SIGNATURE_TTL_SECONDS + 300) {
    return badRequest('deadline must be in the future and at most an hour ahead.')
  }
  if (typeof signature !== 'string' || !isHex(signature) || signature.length > 2 + 2 * MAX_SIGNATURE_BYTES) {
    return badRequest('signature must be 0x hex.')
  }

  const account = getAddress(voter)
  if (perVoter(account.toLowerCase()) || perIp(clientIp(request))) {
    return NextResponse.json(
      { error: 'rate_limited', message: 'Too many votes; try again later.' },
      { status: 429 },
    )
  }

  const message = { voter: account, deliveryId: BigInt(deliveryId), approve, deadline: BigInt(deadline) }
  const valid = await publicClient
    .verifyTypedData({
      address: account,
      ...voteTypedData({ chainId, deliveryManager: manager, ...message }),
      signature: signature as Hex,
    })
    .catch(() => false)
  if (!valid) {
    return NextResponse.json(
      { error: 'invalid_signature', message: 'The signature is not this voter’s vote.' },
      { status: 401 },
    )
  }

  try {
    const txHash = await relayWrite(relayer, {
      address: manager,
      abi: deliveryManagerAbi,
      functionName: 'voteBySig',
      args: [message.deliveryId, account, approve, message.deadline, signature as Hex],
    })
    const receipt = await waitForReceipt(txHash)
    if (receipt.status !== 'success') {
      return NextResponse.json({ error: 'vote_failed', message: 'reverted', txHash }, { status: 502 })
    }
    return NextResponse.json({ txHash })
  } catch (error) {
    const reason = revertOf(error)
    const expected = reason.name !== null && EXPECTED_REVERTS.has(reason.name)
    return NextResponse.json(
      { error: 'vote_failed', reason: reason.name, message: reason.message },
      { status: expected ? 409 : 502 },
    )
  }
}

export const POST = withChainErrors(handle)
