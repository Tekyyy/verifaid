import { NextResponse } from 'next/server'
import {
  BASE_CHAIN_ID,
  MORPHO_VAULTS_QUERY,
  type MorphoVaultsResponse,
  normalizeMorphoVaults,
  type YieldVenueOption,
} from '@/lib/campaigns'

/**
 * Morpho's listed USDC vaults on Base, for the NGO dashboard. Always Base mainnet, whatever network this app runs
 * on: that is where the vaults and their liquidity are, and a test network has nothing comparable to show.
 *
 * Read-only market data. It decides nothing — the vault a need lends to is the one approved on chain.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MORPHO_API = 'https://api.morpho.org/graphql'
const TTL_MS = 10 * 60_000
const TIMEOUT_MS = 8_000

interface Snapshot {
  vaults: YieldVenueOption[]
  fetchedAt: number
}

// One snapshot per server instance: rates move over hours, and every NGO page load should not hit Morpho.
let cached: Snapshot | null = null

const fetchVaults = async (): Promise<Snapshot> => {
  const response = await fetch(MORPHO_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      query: MORPHO_VAULTS_QUERY,
      variables: { chainId: BASE_CHAIN_ID },
    }),
    cache: 'no-store',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`Morpho API answered ${response.status}`)
  const json = (await response.json()) as MorphoVaultsResponse & { errors?: { message: string }[] }
  if (json.errors?.length) throw new Error(json.errors[0]?.message ?? 'Morpho API error')
  return { vaults: normalizeMorphoVaults(json), fetchedAt: Date.now() }
}

export async function GET() {
  if (!cached || Date.now() - cached.fetchedAt > TTL_MS) {
    try {
      cached = await fetchVaults()
    } catch (error) {
      // A stale list beats none; say how old it is and let the page decide.
      if (!cached) {
        const message = error instanceof Error ? error.message : String(error)
        return NextResponse.json({ error: 'unavailable', message }, { status: 502 })
      }
    }
  }
  return NextResponse.json(
    { chainId: BASE_CHAIN_ID, source: 'morpho', ...cached },
    { headers: { 'cache-control': 'public, max-age=60, s-maxage=600' } },
  )
}
