import {
  chainFor,
  type Deployment,
  getDeployment,
  hasDeployment,
  type NetworkName,
  networkFor,
} from '@poa/shared'
import type { Chain } from 'viem'

/**
 * Single source of truth for "which chain is this build locked to". Everything else reads it from here so a
 * missing deployment degrades into a visible notice instead of a crash: `deployments/*.json` is gitignored,
 * so a fresh clone legitimately has no addresses for the configured network.
 */

const DEFAULT_CHAIN_ID = 84_532

export const chainId: number = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? DEFAULT_CHAIN_ID)

export const network: NetworkName = networkFor(chainId)

export const chain: Chain = chainFor(network)

export const deployment: Deployment | null = hasDeployment(network) ? getDeployment(network) : null

/** Throws only where an address is genuinely required; callers render `MissingDeployment` instead. */
export const requireDeployment = (): Deployment => {
  if (!deployment) {
    throw new Error(`No deployment bundled for network "${network}" (chain ${chainId}).`)
  }
  return deployment
}

export const rpcUrl: string =
  process.env.NEXT_PUBLIC_RPC_URL ?? chain.rpcUrls.default.http[0] ?? 'http://127.0.0.1:8545'

export const indexerUrl: string = (process.env.NEXT_PUBLIC_INDEXER_URL ?? 'http://localhost:42069').replace(
  /\/$/,
  '',
)

export const evidenceServiceUrl: string = (
  process.env.NEXT_PUBLIC_EVIDENCE_SERVICE_URL ?? 'http://localhost:4001'
).replace(/\/$/, '')

export const piiVaultUrl: string = (process.env.NEXT_PUBLIC_PII_VAULT_URL ?? 'http://localhost:4002').replace(
  /\/$/,
  '',
)

/**
 * Upstreams reached only through this app's route handlers (`/api/checkout`, `/api/alerts`), never from the
 * browser: the handlers validate input first, and neither service has to serve CORS headers.
 */
export const bankConnectorUrl: string = (
  process.env.BANK_CONNECTOR_URL ??
  process.env.NEXT_PUBLIC_BANK_CONNECTOR_URL ??
  'http://localhost:4003'
).replace(/\/$/, '')

export const notifierUrl: string = (
  process.env.NOTIFIER_URL ??
  process.env.NEXT_PUBLIC_NOTIFIER_URL ??
  'http://localhost:4004'
).replace(/\/$/, '')

/**
 * ERC-7677 paymaster (e.g. a Coinbase Developer Platform endpoint). When set and the connected wallet reports
 * the `paymasterService` capability, writes are sent as sponsored calls and the user pays no gas.
 */
export const paymasterUrl: string | null = process.env.NEXT_PUBLIC_PAYMASTER_URL || null

/** Serve the bundled fixtures instead of calling the indexer (useful while it is not running). */
export const useFixtures: boolean = process.env.NEXT_PUBLIC_USE_FIXTURES === '1'

/** Token decimals are fixed at 6 across the system (EURC/USDC base units). */
export const TOKEN_DECIMALS = 6

/** v3 conversions: the deployment has the forwarder factory and the router that quotes it. v2 builds hide them. */
export const conversionsEnabled: boolean = Boolean(
  deployment?.contracts.DonationForwarderFactory && deployment.contracts.ConversionRouter,
)

export const BASE_MAINNET_CHAIN_ID = 8453

/**
 * How "pay by card" gets USDC into the donor's own wallet. `coinbase`: the Coinbase Onramp, which only delivers on
 * mainnet networks. `mock`: a sandbox that mints test USDC through the relayer (Base Sepolia, anvil). Base mainnet is
 * always `coinbase` whatever the variable says, because minting there is impossible and must never be attempted.
 */
export type OnrampMode = 'coinbase' | 'mock'

export const onrampMode: OnrampMode =
  process.env.NEXT_PUBLIC_ONRAMP_MODE === 'coinbase' || chainId === BASE_MAINNET_CHAIN_ID
    ? 'coinbase'
    : 'mock'
