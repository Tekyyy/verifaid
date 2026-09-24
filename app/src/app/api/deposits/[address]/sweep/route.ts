import { donationForwarderAbi, mockEURCAbi, NATIVE_TOKEN } from '@poa/shared'
import { type NextRequest, NextResponse } from 'next/server'
import { type Address, type Hex, parseEventLogs } from 'viem'
import { forwarderCallAbi } from '@/lib/abiErrors'
import { publicClient } from '@/lib/server/chain'
import {
  depositTokens,
  forwarderContext,
  isFactoryForwarder,
  isKeeper,
  parseDepositAddress,
} from '@/lib/server/deposits'
import { badRequest } from '@/lib/server/proxy'
import { clientIp, createRateLimiter } from '@/lib/server/rateLimit'
import { getRelayer, relayWrite, revertOf, waitForReceipt, withChainErrors } from '@/lib/server/relayer'

/**
 * "Sweep now": converts and donates whatever a deposit address holds, one `sweep(token)` per non-zero balance.
 *
 * `sweep` can only execute the intent the address committed to, so the relayer triggering it gains nothing. Only the
 * intent's own addresses and keepers registered on the factory may call it, so the relayer must be a keeper; when it
 * is not, this route says so (503) and a donor whose wallet is the receipt or refund address can sweep themselves.
 * An address with nothing to sweep, whose need stopped accepting or whose conversion would break the need's cost
 * cap is a normal answer, reported per token, not an error.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const perAddress = createRateLimiter({ name: 'deposit-sweep:perAddress', windowMs: 60_000, max: 4 })
const perIp = createRateLimiter({ name: 'deposit-sweep:perIp', windowMs: 60_000, max: 12 })

type Outcome = 'swept' | 'nothingToSweep' | 'notAccepting' | 'overCostCap' | 'notKeeper' | 'failed'

interface SweepResult {
  symbol: string
  token: Address
  balance: string
  outcome: Outcome
  txHash: Hex | null
  /** Vault token deposited into the need, when swept. */
  deposited: string | null
  error: string | null
}

/** Expected states of an address, not faults. `overCostCap`: the conversion would cost more than the need discloses. */
const OUTCOME_OF: Record<string, Outcome> = {
  NothingToSweep: 'nothingToSweep',
  NotAccepting: 'notAccepting',
  FeeExceedsDisclosure: 'overCostCap',
  Unauthorized: 'notKeeper',
}

async function handle(request: NextRequest, { params }: { params: { address: string } }) {
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
  if ((await perAddress(address.toLowerCase())) || (await perIp(clientIp(request)))) {
    return NextResponse.json({ error: 'rate_limited', message: 'Sweeping too often.' }, { status: 429 })
  }
  const [forwarder, keeper] = await Promise.all([
    isFactoryForwarder(context, address),
    isKeeper(context, relayer.account.address),
  ])
  if (!forwarder) {
    return NextResponse.json(
      { error: 'not_found', message: 'Not a deposit address of this deployment (or not deployed yet).' },
      { status: 404 },
    )
  }
  if (!keeper) {
    return NextResponse.json(
      {
        error: 'not_keeper',
        message: 'This site’s relayer is not registered as a keeper, so it cannot sweep deposit addresses.',
      },
      { status: 503 },
    )
  }

  const tokens = depositTokens(context)
  const balances = await Promise.all(
    tokens.map((token) =>
      token.address === NATIVE_TOKEN
        ? publicClient.getBalance({ address })
        : publicClient.readContract({
            address: token.address,
            abi: mockEURCAbi,
            functionName: 'balanceOf',
            args: [address],
          }),
    ),
  )

  const results: SweepResult[] = []
  // One at a time: each sweep changes what the need can still take, so the next one must simulate against it.
  for (const [index, token] of tokens.entries()) {
    const balance = balances[index] ?? 0n
    if (balance === 0n) continue
    const base = { symbol: token.symbol, token: token.address, balance: balance.toString() }
    try {
      const txHash = await relayWrite(relayer, {
        address,
        abi: forwarderCallAbi,
        functionName: 'sweep',
        args: [token.address],
      })
      const receipt = await waitForReceipt(txHash)
      if (receipt.status !== 'success') {
        results.push({ ...base, outcome: 'failed', txHash, deposited: null, error: 'reverted' })
        continue
      }
      const [swept] = parseEventLogs({ abi: donationForwarderAbi, eventName: 'Swept', logs: receipt.logs })
      results.push({
        ...base,
        outcome: 'swept',
        txHash,
        deposited: swept?.args.deposited.toString() ?? null,
        error: null,
      })
    } catch (error) {
      const reason = revertOf(error)
      const outcome = (reason.name && OUTCOME_OF[reason.name]) || 'failed'
      results.push({
        ...base,
        outcome,
        txHash: null,
        deposited: null,
        error: outcome === 'failed' ? reason.message : null,
      })
    }
  }

  return NextResponse.json({ address, results })
}

export const POST = withChainErrors(handle)
