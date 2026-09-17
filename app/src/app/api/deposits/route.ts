import { donationForwarderFactoryAbi, needsRegistryAbi } from '@poa/shared'
import { type NextRequest, NextResponse } from 'next/server'
import { publicClient } from '@/lib/server/chain'
import { forwarderContext, isFactoryForwarder, parseIntent } from '@/lib/server/deposits'
import { badRequest, readJson } from '@/lib/server/proxy'
import { clientIp, createRateLimiter } from '@/lib/server/rateLimit'
import { getRelayer, relayWrite, revertOf, waitForReceipt, withChainErrors } from '@/lib/server/relayer'

/**
 * Deploys the deposit address for an intent the donor's browser built, so it exists on-chain (and in the indexer)
 * before any money is sent to it. Deploying only publishes the intent: the address is a pure function of it, the
 * relayer gains no control over anything sent there, and a repeat call for the same intent is a no-op.
 *
 * The refund key behind `refundSigner` never reaches this server; only its address does.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const perIp = createRateLimiter({ windowMs: 10 * 60_000, max: 5 })
const overall = createRateLimiter({ windowMs: 60 * 60_000, max: 120 })

const ON_CHAIN_CUSTODY = 0

async function handle(request: NextRequest) {
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

  const body = await readJson(request)
  if (!body) return badRequest('Body must be a JSON object.')
  const intent = parseIntent(body.intent)
  if (!intent) {
    return badRequest(
      'intent must be { needId, receiptTo, refundTo, refundSigner (non-zero), salt (bytes32) } with 0x addresses.',
    )
  }

  if (perIp(clientIp(request)) || overall('all')) {
    return NextResponse.json(
      { error: 'rate_limited', message: 'Too many deposit addresses created; try again later.' },
      { status: 429 },
    )
  }

  const registry = context.deployment.contracts.NeedsRegistry
  const needCount = await publicClient.readContract({
    address: registry,
    abi: needsRegistryAbi,
    functionName: 'needCount',
  })
  if (intent.needId > needCount) {
    return NextResponse.json({ error: 'not_found', message: 'No such need.' }, { status: 404 })
  }
  const [custody, [, , , open]] = await Promise.all([
    publicClient.readContract({
      address: registry,
      abi: needsRegistryAbi,
      functionName: 'custodyModeOf',
      args: [intent.needId],
    }),
    publicClient.readContract({
      address: registry,
      abi: needsRegistryAbi,
      functionName: 'fundingTermsOf',
      args: [intent.needId],
    }),
  ])
  // An address that could only ever refund would mislead the donor: create them for open on-chain needs only.
  if (custody !== ON_CHAIN_CUSTODY || !open) {
    return NextResponse.json(
      { error: 'not_accepting', message: 'This need is not accepting on-chain donations.' },
      { status: 409 },
    )
  }

  const address = await publicClient.readContract({
    address: context.factory,
    abi: donationForwarderFactoryAbi,
    functionName: 'forwarderAddress',
    args: [intent],
  })

  if (await isFactoryForwarder(context, address)) {
    return NextResponse.json({ address, txHash: null })
  }

  try {
    const txHash = await relayWrite(relayer, {
      address: context.factory,
      abi: donationForwarderFactoryAbi,
      functionName: 'deploy',
      args: [intent],
    })
    const receipt = await waitForReceipt(txHash)
    if (receipt.status !== 'success' || !(await isFactoryForwarder(context, address))) {
      return NextResponse.json(
        { error: 'deploy_failed', message: 'The deploy transaction did not create the address.', txHash },
        { status: 502 },
      )
    }
    return NextResponse.json({ address, txHash }, { status: 201 })
  } catch (error) {
    const reason = revertOf(error)
    return NextResponse.json(
      { error: 'deploy_failed', message: reason.message },
      { status: reason.name ? 400 : 502 },
    )
  }
}

export const POST = withChainErrors(handle)
