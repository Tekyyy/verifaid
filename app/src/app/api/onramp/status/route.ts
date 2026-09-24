import { type NextRequest, NextResponse } from 'next/server'
import { onrampMode } from '@/lib/config'
import {
  buyTransactions,
  cdpCredentials,
  OnrampApiError,
  PARTNER_USER_REF,
  summarize,
} from '@/lib/server/coinbaseOnramp'
import { badRequest } from '@/lib/server/proxy'
import { createRateLimiter } from '@/lib/server/rateLimit'

/**
 * Status of a Coinbase Onramp purchase, looked up by the random partner reference the session route issued.
 * The panel polls it while it waits for the USDC; the wallet balance remains the signal that funds arrived.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const perRef = createRateLimiter({ name: 'onramp-status:perRef', windowMs: 60_000, max: 12 })

export async function GET(request: NextRequest) {
  if (onrampMode !== 'coinbase') {
    return NextResponse.json(
      { error: 'forbidden', message: 'The Coinbase Onramp is not enabled.' },
      { status: 403 },
    )
  }
  const credentials = cdpCredentials()
  if (!credentials) {
    return NextResponse.json(
      { error: 'unavailable', message: 'Coinbase Onramp is not configured.' },
      { status: 503 },
    )
  }

  const ref = request.nextUrl.searchParams.get('ref') ?? ''
  if (!PARTNER_USER_REF.test(ref)) return badRequest('ref must be a partner reference issued by this app.')
  if (await perRef(ref)) {
    return NextResponse.json({ error: 'rate_limited', message: 'Polling too fast.' }, { status: 429 })
  }

  try {
    const transactions = await buyTransactions(credentials, ref)
    return NextResponse.json({ status: summarize(transactions), transactions })
  } catch (error) {
    const status = error instanceof OnrampApiError ? error.status : 502
    const message = error instanceof OnrampApiError ? error.message : 'Coinbase Onramp request failed'
    return NextResponse.json({ error: 'onramp_error', message }, { status })
  }
}
