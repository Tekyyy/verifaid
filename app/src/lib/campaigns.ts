import type { NeedStatus, NeedSummary, TrancheView } from '@poa/shared'

/**
 * The NGO's view of its own campaigns, and of where a long campaign's escrow could wait.
 *
 * Nothing here moves money. The vault a need lends to is the one the platform admin approved on chain
 * (`NeedsRegistry.yieldVenue`), never one picked from this list; the list is what the platform could approve,
 * with the numbers an NGO needs to judge whether opting in is worth it.
 */

/** Needs that still have work ahead of them: raising, or delivering what was raised. */
export const CURRENT_STATUSES: readonly NeedStatus[] = [
  'Pending',
  'Verified',
  'Funding',
  'Funded',
  'InDelivery',
]

/** Statuses before funding closes: the plan is still the target, and tranche 0 has not been paid yet. */
const BEFORE_CLOSE: readonly NeedStatus[] = ['Pending', 'Verified', 'Funding']

/**
 * A campaign is long when at least three months separate funding closing (or now, if that has passed) from the
 * delivery deadline. Shorter than that, a few weeks of interest does not pay for the attention it takes.
 */
export const LONG_CAMPAIGN_DAYS = 90

const DAY = 86_400
const YEAR = 365 * DAY
const BPS = 10_000n

export const isCurrent = (need: Pick<NeedSummary, 'status'>): boolean =>
  CURRENT_STATUSES.includes(need.status)

export const isBeforeClose = (need: Pick<NeedSummary, 'status'>): boolean =>
  BEFORE_CLOSE.includes(need.status)

/** Seconds between funding closing (or now, if it already has) and the delivery deadline; 0 when open-ended. */
export const waitingWindow = (
  need: Pick<NeedSummary, 'fundingDeadline' | 'executionDeadline'>,
  now: number,
): number => {
  if (!need.executionDeadline) return 0
  const from = Math.max(now, need.fundingDeadline ?? now)
  return Math.max(0, need.executionDeadline - from)
}

export const isLongCampaign = (
  need: Pick<NeedSummary, 'status' | 'fundingDeadline' | 'executionDeadline'>,
  now: number,
): boolean => isCurrent(need) && waitingWindow(need, now) >= LONG_CAMPAIGN_DAYS * DAY

/** Whether the need can lend at all: it opted in, it still can (Pending), or it cannot any more. */
export type OptInState = 'optedIn' | 'canOptIn' | 'notOptedIn'

export const optInState = (need: Pick<NeedSummary, 'idleCapital' | 'status'>): OptInState =>
  need.idleCapital !== null ? 'optedIn' : need.status === 'Pending' ? 'canOptIn' : 'notOptedIn'

export interface WaitingCapital {
  /** Base units that could sit in the venue at once, at most. */
  amount: bigint
  /** How long it could wait, in seconds. */
  seconds: number
  /** What the amount was worked out from: the target (still raising) or what was actually raised. */
  basis: 'target' | 'raised'
}

/**
 * The most this need could lend, mirroring `AidVault._deployable`: never money a payee can already claim, and
 * never more than the approved cap of the whole pot. Before funding closes the plan is the target, and tranche 0
 * is left out because it pre-finances the work the moment funding closes.
 */
export const waitingCapital = (
  need: Pick<
    NeedSummary,
    | 'status'
    | 'targetAmount'
    | 'totalDonated'
    | 'totalReleased'
    | 'totalRefunded'
    | 'fundingDeadline'
    | 'executionDeadline'
  >,
  tranches: readonly Pick<TrancheView, 'index' | 'bps' | 'status'>[],
  capBps: number,
  now: number,
): WaitingCapital => {
  const before = isBeforeClose(need)
  const seconds = waitingWindow(need, now)
  const pot = before
    ? BigInt(need.targetAmount)
    : BigInt(need.totalDonated) - BigInt(need.totalReleased) - BigInt(need.totalRefunded)
  const lockedBps = tranches
    .filter((tranche) => tranche.status === 'Locked' && !(before && tranche.index === 0))
    .reduce((sum, tranche) => sum + BigInt(tranche.bps), 0n)
  // Tranche shares are of what was raised; after close, the pot already excludes what went out.
  const raised = before ? pot : BigInt(need.totalDonated)
  const locked = (raised * lockedBps) / BPS
  const lockedNow = locked < pot ? locked : pot
  const ceiling = (pot * BigInt(Math.max(0, Math.min(capBps, 10_000)))) / BPS
  const amount = lockedNow < ceiling ? lockedNow : ceiling
  return { amount: amount > 0n ? amount : 0n, seconds, basis: before ? 'target' : 'raised' }
}

/**
 * An upper bound: the whole waiting amount earning the given net rate until the delivery deadline. In practice
 * tranches leave as deliveries are verified, so the real figure is lower. Simple interest; base units out.
 */
export const earningsUpTo = (waiting: Pick<WaitingCapital, 'amount' | 'seconds'>, netApy: number): bigint => {
  if (!Number.isFinite(netApy) || netApy <= 0 || waiting.amount <= 0n || waiting.seconds <= 0) return 0n
  // Rate in parts per billion keeps the arithmetic in bigint without losing a meaningful digit.
  const ratePpb = BigInt(Math.round(netApy * 1e9))
  return (waiting.amount * ratePpb * BigInt(waiting.seconds)) / (1_000_000_000n * BigInt(YEAR))
}

export const monthsOf = (seconds: number): number => Math.floor(seconds / (30 * DAY))

// ─── Morpho vaults ────────────────────────────────────────────────────────────

/** Base mainnet's native USDC. Vaults are matched on this address, never on a symbol anyone can reuse. */
export const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
export const BASE_CHAIN_ID = 8453

/** Below this a vault is too small for escrow that has to come back on the day a tranche is due. */
export const MIN_TVL_USD = 1_000_000
export const MAX_VENUES = 10

export interface YieldVenueOption {
  address: `0x${string}`
  name: string
  /** Morpho's MetaMorpho vaults (v1) or Vaults V2; both are ERC-4626, which is all the AidVault needs. */
  version: 'v1' | 'v2'
  curator: string | null
  /** After the vault's own fees, as a fraction: 0.0443 is 4.43% a year. */
  netApy: number
  tvlUsd: number
  /** What could be withdrawn from it right now. */
  liquidityUsd: number
  url: string
}

interface MorphoWarning {
  type: string
  level: string
}

interface MorphoV1 {
  address: string
  name: string
  listed: boolean
  state: {
    netApy: number | null
    totalAssetsUsd: number | null
    curators: { name: string }[] | null
  } | null
  liquidity: { usd: number | null } | null
  warnings: MorphoWarning[] | null
}

interface MorphoV2 {
  address: string
  name: string
  listed: boolean
  netApy: number | null
  totalAssetsUsd: number | null
  liquidityUsd: number | null
  curators: { items: { name: string }[] | null } | null
  warnings: MorphoWarning[] | null
}

export interface MorphoVaultsResponse {
  data?: {
    vaults?: { items?: MorphoV1[] | null } | null
    vaultV2s?: { items?: MorphoV2[] | null } | null
  } | null
}

/**
 * The query `normalizeMorphoVaults` expects the answer to. The asset is written in rather than passed as a variable:
 * the two vault versions type that filter differently (`Address` and `String`), and it is a constant anyway.
 */
export const MORPHO_VAULTS_QUERY = `query AidVenues($chainId: Int!) {
  vaults(first: 25, orderBy: TotalAssetsUsd, orderDirection: Desc,
         where: { chainId_in: [$chainId], assetAddress_in: ["${BASE_USDC}"], listed: true }) {
    items {
      address name listed
      state { netApy totalAssetsUsd curators { name } }
      liquidity { usd }
      warnings { type level }
    }
  }
  vaultV2s(first: 25, orderBy: TotalAssetsUsd, orderDirection: Desc,
           where: { chainId_in: [$chainId], assetAddress_in: ["${BASE_USDC}"], listed: true }) {
    items {
      address name listed netApy totalAssetsUsd liquidityUsd
      curators { items { name } }
      warnings { type level }
    }
  }
}`

const isAddress = (value: string): value is `0x${string}` => /^0x[0-9a-fA-F]{40}$/.test(value)

export const morphoVaultUrl = (address: string): string => `https://app.morpho.org/base/vault/${address}`

/**
 * Listed, warning-free vaults holding Base USDC and large enough to matter, the most withdrawable first: escrow has
 * to come back the day a tranche is due, so what can leave a vault right now matters more than its size. Anything
 * malformed is dropped rather than shown with a made-up number.
 */
export const normalizeMorphoVaults = (response: MorphoVaultsResponse): YieldVenueOption[] => {
  const v1 = (response.data?.vaults?.items ?? []).map((vault): YieldVenueOption | null =>
    vault.listed && !vault.warnings?.length && vault.state
      ? {
          address: vault.address as `0x${string}`,
          name: vault.name,
          version: 'v1',
          curator: vault.state.curators?.map((curator) => curator.name).join(', ') || null,
          netApy: vault.state.netApy ?? Number.NaN,
          tvlUsd: vault.state.totalAssetsUsd ?? 0,
          liquidityUsd: vault.liquidity?.usd ?? 0,
          url: morphoVaultUrl(vault.address),
        }
      : null,
  )
  const v2 = (response.data?.vaultV2s?.items ?? []).map((vault): YieldVenueOption | null =>
    vault.listed && !vault.warnings?.length
      ? {
          address: vault.address as `0x${string}`,
          name: vault.name,
          version: 'v2',
          curator: vault.curators?.items?.map((curator) => curator.name).join(', ') || null,
          netApy: vault.netApy ?? Number.NaN,
          tvlUsd: vault.totalAssetsUsd ?? 0,
          liquidityUsd: vault.liquidityUsd ?? 0,
          url: morphoVaultUrl(vault.address),
        }
      : null,
  )
  return [...v1, ...v2]
    .filter((vault): vault is YieldVenueOption => vault !== null)
    .filter(
      (vault) =>
        isAddress(vault.address) &&
        Number.isFinite(vault.netApy) &&
        vault.netApy >= 0 &&
        vault.tvlUsd >= MIN_TVL_USD,
    )
    .sort((a, b) => b.liquidityUsd - a.liquidityUsd)
    .slice(0, MAX_VENUES)
}
