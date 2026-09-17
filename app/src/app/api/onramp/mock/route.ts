import { mockEURCAbi } from '@poa/shared'
import { type NextRequest, NextResponse } from 'next/server'
import { type Address, getAddress, isAddress, parseAbi } from 'viem'
import { BASE_MAINNET_CHAIN_ID, chainId, conversionsEnabled, deployment, onrampMode } from '@/lib/config'
import { publicClient } from '@/lib/server/chain'
import { badRequest, readJson } from '@/lib/server/proxy'
import { clientIp, createRateLimiter } from '@/lib/server/rateLimit'
import { getRelayer, relayWrite, revertOf } from '@/lib/server/relayer'

/**
 * Sandbox stand-in for a card on-ramp, for test networks where Coinbase Onramp cannot deliver. It prices the euro
 * amount with the deployment's EUR/USD feed, keeps a mock 1.5% card fee and mints the rest as MockUSDC to the
 * donor's own wallet, exactly where a real on-ramp would deliver. The donor then donates it like any USDC.
 *
 * Refused on Base mainnet, outside `mock` mode, and for any token whose name does not mark it as a test token.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const AMOUNT = /^\d{1,4}(\.\d{1,2})?$/
const MIN_CENTS = 100
const MAX_CENTS = 500_000
const CARD_FEE_BPS = 150n
/** Used when the feed is missing or unreadable: 1 EUR = 1.08 USD. */
const FALLBACK_RATE = { answer: 108_000_000n, decimals: 8 }

const perAddress = createRateLimiter({ windowMs: 10 * 60_000, max: 3 })
const perIp = createRateLimiter({ windowMs: 10 * 60_000, max: 10 })

const aggregatorAbi = parseAbi([
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
])

const eurUsdRate = async (
  feed: Address | undefined,
): Promise<{ answer: bigint; decimals: number; source: 'chainlink' | 'fallback' }> => {
  if (!feed) return { ...FALLBACK_RATE, source: 'fallback' }
  try {
    const [decimals, [, answer]] = await Promise.all([
      publicClient.readContract({ address: feed, abi: aggregatorAbi, functionName: 'decimals' }),
      publicClient.readContract({ address: feed, abi: aggregatorAbi, functionName: 'latestRoundData' }),
    ])
    return answer > 0n ? { answer, decimals, source: 'chainlink' } : { ...FALLBACK_RATE, source: 'fallback' }
  } catch {
    return { ...FALLBACK_RATE, source: 'fallback' }
  }
}

let mockTokenChecked: Address | null = null

export async function POST(request: NextRequest) {
  if (chainId === BASE_MAINNET_CHAIN_ID || onrampMode !== 'mock') {
    return NextResponse.json(
      { error: 'forbidden', message: 'The sandbox on-ramp only runs on test networks.' },
      { status: 403 },
    )
  }
  const usdc = deployment?.external.USDC
  if (!deployment || !conversionsEnabled || !usdc) {
    return NextResponse.json(
      { error: 'unavailable', message: 'This deployment has no USDC conversion path.' },
      { status: 503 },
    )
  }
  const relayer = getRelayer()
  if (!relayer) {
    return NextResponse.json({ error: 'unavailable', message: 'relayer not configured' }, { status: 503 })
  }

  const body = await readJson(request)
  if (!body) return badRequest('Body must be a JSON object.')
  const { address, amountEur } = body
  if (typeof address !== 'string' || !isAddress(address, { strict: false })) {
    return badRequest('address must be a 0x-prefixed 20-byte address.')
  }
  if (typeof amountEur !== 'string' || !AMOUNT.test(amountEur)) {
    return badRequest('amountEur must be a decimal string with at most two decimals, e.g. "25.00".')
  }
  const cents = Math.round(Number(amountEur) * 100)
  if (cents < MIN_CENTS || cents > MAX_CENTS) return badRequest('amountEur must be between 1.00 and 5000.00.')

  if (perAddress(address.toLowerCase()) || perIp(clientIp(request))) {
    return NextResponse.json(
      { error: 'rate_limited', message: 'Too many sandbox purchases; try again in a few minutes.' },
      { status: 429 },
    )
  }

  // Defense in depth: a misconfigured deployment must never make the relayer try to mint a real token.
  if (mockTokenChecked !== usdc) {
    const name = await publicClient
      .readContract({ address: usdc, abi: mockEURCAbi, functionName: 'name' })
      .catch(() => null)
    if (name === null) {
      return NextResponse.json(
        { error: 'chain_unavailable', message: 'Could not read the USDC token.' },
        { status: 502 },
      )
    }
    if (!name.includes('TEST ONLY')) {
      return NextResponse.json(
        { error: 'forbidden', message: 'The configured USDC is not a test token.' },
        { status: 403 },
      )
    }
    mockTokenChecked = usdc
  }

  const rate = await eurUsdRate(deployment.external.EurUsdFeed)
  const eurUnits = BigInt(cents) * 10_000n
  const grossUsdc = (eurUnits * rate.answer) / 10n ** BigInt(rate.decimals)
  const feeUsdc = (grossUsdc * CARD_FEE_BPS) / 10_000n
  const netUsdc = grossUsdc - feeUsdc

  try {
    const txHash = await relayWrite(relayer, {
      address: usdc,
      abi: mockEURCAbi,
      functionName: 'mint',
      args: [getAddress(address), netUsdc],
    })
    return NextResponse.json(
      {
        txHash,
        amountEur: (cents / 100).toFixed(2),
        eurUsd: (Number(rate.answer) / 10 ** rate.decimals).toFixed(4),
        rateSource: rate.source,
        feeBps: Number(CARD_FEE_BPS),
        grossUsdc: grossUsdc.toString(),
        feeUsdc: feeUsdc.toString(),
        usdc: netUsdc.toString(),
      },
      { status: 201 },
    )
  } catch (error) {
    return NextResponse.json({ error: 'mint_failed', message: revertOf(error).message }, { status: 502 })
  }
}
