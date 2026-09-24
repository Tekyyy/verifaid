import { type NextRequest, NextResponse } from 'next/server'
import { getAddress, isAddress } from 'viem'
import { isLocale } from '@/i18n/routing'
import { conversionsEnabled, onrampMode } from '@/lib/config'
import {
  cdpCredentials,
  createSessionToken,
  newPartnerUserRef,
  OnrampApiError,
  onrampUrl,
} from '@/lib/server/coinbaseOnramp'
import { badRequest, isNeedId, readJson } from '@/lib/server/proxy'
import { clientIp, createRateLimiter } from '@/lib/server/rateLimit'

/**
 * Starts a Coinbase Onramp purchase of USDC on Base, delivered to the donor's own wallet (`coinbase` mode only).
 *
 * The browser never sees the CDP key: this handler signs the request, asks Coinbase for a single-use session token
 * bound to the donor's address and returns the hosted checkout URL, plus the partner reference the panel polls the
 * status route with. Nothing here moves money on its own; the donation is the donor's own transaction afterwards.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Decimal euros with at most two decimals. */
const AMOUNT = /^\d{1,5}(\.\d{1,2})?$/
const MIN_CENTS = 500
const MAX_CENTS = 500_000

const perIp = createRateLimiter({ name: 'onramp-session:perIp', windowMs: 10 * 60_000, max: 10 })
const perAddress = createRateLimiter({ name: 'onramp-session:perAddress', windowMs: 10 * 60_000, max: 5 })

export async function POST(request: NextRequest) {
  if (onrampMode !== 'coinbase') {
    return NextResponse.json(
      { error: 'forbidden', message: 'The Coinbase Onramp is not enabled.' },
      { status: 403 },
    )
  }
  if (!conversionsEnabled) {
    return NextResponse.json(
      { error: 'unavailable', message: 'This deployment cannot convert USDC donations.' },
      { status: 503 },
    )
  }
  const credentials = cdpCredentials()
  if (!credentials) {
    return NextResponse.json(
      { error: 'unavailable', message: 'Coinbase Onramp is not configured.' },
      { status: 503 },
    )
  }

  const body = await readJson(request)
  if (!body) return badRequest('Body must be a JSON object.')
  const { address, amountEur, needId, locale } = body
  if (typeof address !== 'string' || !isAddress(address, { strict: false })) {
    return badRequest('address must be a 0x-prefixed 20-byte address.')
  }
  if (typeof amountEur !== 'string' || !AMOUNT.test(amountEur)) {
    return badRequest('amountEur must be a decimal string with at most two decimals, e.g. "25.00".')
  }
  const cents = Math.round(Number(amountEur) * 100)
  if (cents < MIN_CENTS || cents > MAX_CENTS) return badRequest('amountEur must be between 5.00 and 5000.00.')
  if (!isNeedId(needId)) return badRequest('needId must be a positive integer string.')
  const lang = typeof locale === 'string' && isLocale(locale) ? locale : 'en'

  const ip = clientIp(request)
  if ((await perIp(ip)) || (await perAddress(address.toLowerCase()))) {
    return NextResponse.json(
      { error: 'rate_limited', message: 'Too many purchases started.' },
      { status: 429 },
    )
  }

  try {
    const recipient = getAddress(address)
    const sessionToken = await createSessionToken(credentials, {
      address: recipient,
      clientIp: ip === 'unknown' ? null : ip,
    })
    const partnerUserRef = newPartnerUserRef()
    const url = onrampUrl({
      sessionToken,
      amountEur: (cents / 100).toFixed(2),
      partnerUserRef,
      // Coinbase ignores it unless this origin is on the project's allowlist; the purchase completes either way.
      redirectUrl: `${request.nextUrl.origin}/${lang}/needs/${needId}`,
    })
    return NextResponse.json({ url, partnerUserRef }, { status: 201 })
  } catch (error) {
    const status = error instanceof OnrampApiError ? error.status : 502
    const message = error instanceof OnrampApiError ? error.message : 'Coinbase Onramp request failed'
    return NextResponse.json({ error: 'onramp_error', message }, { status })
  }
}
