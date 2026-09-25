import { donationForwarderAbi, NATIVE_TOKEN } from '@poa/shared'
import { type NextRequest, NextResponse } from 'next/server'
import {
  type Address,
  getAddress,
  type Hex,
  isAddress,
  isAddressEqual,
  parseEventLogs,
  recoverTypedDataAddress,
} from 'viem'
import { forwarderCallAbi } from '@/lib/abiErrors'
import { chainId } from '@/lib/config'
import { isSignature, readRefundNonce, refundTypedData } from '@/lib/conversion'
import { publicClient } from '@/lib/server/chain'
import {
  EXPECTED_REVERTS,
  forwarderContext,
  isFactoryForwarder,
  parseDepositAddress,
} from '@/lib/server/deposits'
import { badRequest, readJson } from '@/lib/server/proxy'
import { clientIp, createRateLimiter } from '@/lib/server/rateLimit'
import { getRelayer, relayWrite, revertOf, waitForReceipt, withChainErrors } from '@/lib/server/relayer'

/**
 * Relays a refund the donor signed in their browser with the refund key they downloaded:
 *
 * - `leftover`: `refundWithSignature(token, to, deadline, sig)` — whatever the deposit address still holds.
 * - `vault`: `claimVaultRefundWithSignature(to, deadline, sig)` — the address's share of a cancelled or expired
 *   need, when the donation was credited to the address itself rather than to a wallet.
 *
 * The route only ever receives a signature, never the key. It checks the signature against the address's refund
 * signer (and, where forwarders have one, their current replay nonce) before spending gas; the contract checks it
 * again, and the destination is whatever the key signed.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_DEADLINE_AHEAD_SECONDS = 24 * 3600

const perAddress = createRateLimiter({ name: 'deposit-refund:perAddress', windowMs: 10 * 60_000, max: 6 })
const perIp = createRateLimiter({ name: 'deposit-refund:perIp', windowMs: 10 * 60_000, max: 12 })

async function handle(request: NextRequest, props: { params: Promise<{ address: string }> }) {
  const params = await props.params
  const context = forwarderContext()
  if (!context) {
    return NextResponse.json(
      { error: 'unavailable', message: 'This deployment has no deposit addresses.' },
      { status: 503 },
    )
  }
  const relayer = getRelayer()
  if (!relayer) {
    return NextResponse.json({ error: 'unavailable', message: 'relayer not configured' }, { status: 503 })
  }

  const address = parseDepositAddress(params.address)
  if (!address) return badRequest('address must be a 0x-prefixed 20-byte address.')

  const body = await readJson(request)
  if (!body) return badRequest('Body must be a JSON object.')
  const { kind, token, to, deadline, signature } = body
  if (kind !== 'leftover' && kind !== 'vault') return badRequest('kind must be "leftover" or "vault".')
  if (kind === 'leftover' && (typeof token !== 'string' || !isAddress(token, { strict: false }))) {
    return badRequest('token must be a 0x address (the zero address for ETH).')
  }
  if (typeof to !== 'string' || !isAddress(to, { strict: false }) || /^0x0{40}$/i.test(to)) {
    return badRequest('to must be a non-zero 0x address.')
  }
  if (isAddressEqual(to as Address, address)) return badRequest('to cannot be the deposit address itself.')
  const now = Math.floor(Date.now() / 1000)
  if (typeof deadline !== 'string' || !/^\d{1,12}$/.test(deadline)) {
    return badRequest('deadline must be unix seconds as a decimal string.')
  }
  if (Number(deadline) <= now || Number(deadline) > now + MAX_DEADLINE_AHEAD_SECONDS) {
    return badRequest('deadline must be in the future and at most 24 hours ahead.')
  }
  if (typeof signature !== 'string' || !isSignature(signature)) {
    return badRequest('signature must be a 65-byte 0x hex string.')
  }

  if ((await perAddress(address.toLowerCase())) || (await perIp(clientIp(request)))) {
    return NextResponse.json({ error: 'rate_limited', message: 'Too many refund attempts.' }, { status: 429 })
  }
  if (!(await isFactoryForwarder(context, address))) {
    return NextResponse.json(
      { error: 'not_found', message: 'Not a deposit address of this deployment (or not deployed yet).' },
      { status: 404 },
    )
  }

  const recipient = getAddress(to)
  const sig = signature as Hex
  const expiry = BigInt(deadline)
  const refundToken = kind === 'leftover' ? getAddress(token as string) : NATIVE_TOKEN
  const [intent, nonce] = await Promise.all([
    publicClient.readContract({ address, abi: donationForwarderAbi, functionName: 'intent' }),
    readRefundNonce(publicClient, address),
  ])
  const typedData = refundTypedData({
    chainId,
    depositAddress: address,
    kind,
    token: refundToken,
    to: recipient,
    deadline: expiry,
    nonce,
  })
  const signer = await recoverTypedDataAddress({
    ...(typedData as unknown as Parameters<typeof recoverTypedDataAddress>[0]),
    signature: sig,
  }).catch(() => null)
  if (!signer || /^0x0{40}$/i.test(intent.refundSigner) || !isAddressEqual(signer, intent.refundSigner)) {
    return NextResponse.json(
      { error: 'invalid_signature', message: 'The signature is not from this deposit address’s refund key.' },
      { status: 401 },
    )
  }

  try {
    const txHash =
      kind === 'leftover'
        ? await relayWrite(relayer, {
            address,
            abi: forwarderCallAbi,
            functionName: 'refundWithSignature',
            args: [refundToken, recipient, expiry, sig],
          })
        : await relayWrite(relayer, {
            address,
            abi: forwarderCallAbi,
            functionName: 'claimVaultRefundWithSignature',
            args: [recipient, expiry, sig],
          })
    const receipt = await waitForReceipt(txHash)
    if (receipt.status !== 'success') {
      return NextResponse.json({ error: 'refund_failed', message: 'reverted', txHash }, { status: 502 })
    }
    const events = parseEventLogs({ abi: donationForwarderAbi, logs: receipt.logs })
    const amount = events
      .map((event) =>
        event.eventName === 'LeftoverRefunded' || event.eventName === 'VaultRefundClaimed'
          ? event.args.amount
          : 0n,
      )
      .reduce((sum, value) => sum + value, 0n)
    return NextResponse.json({ txHash, amount: amount.toString(), to: recipient })
  } catch (error) {
    const reason = revertOf(error)
    const expected = reason.name !== null && EXPECTED_REVERTS.has(reason.name)
    return NextResponse.json(
      { error: 'refund_failed', reason: reason.name, message: reason.message },
      { status: expected ? 409 : 502 },
    )
  }
}

export const POST = withChainErrors(handle)
