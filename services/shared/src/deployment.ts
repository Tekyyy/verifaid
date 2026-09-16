import { deployments } from './generated/deployments.js'
import type { Deployment, NetworkName } from './types.js'

/**
 * Addresses and schema UIDs, bundled at build time from `deployments/<network>.json` so the browser bundle and
 * the Node services read exactly the same values.
 */
export const getDeployment = (network: NetworkName): Deployment => {
  const deployment = deployments[network]
  if (!deployment) {
    throw new Error(
      `No deployment for "${network}". Run \`pnpm deploy:local\` (anvil) or the Base Sepolia deploy scripts, ` +
        'then rebuild @poa/shared.',
    )
  }
  return deployment
}

export const hasDeployment = (network: NetworkName): boolean => Boolean(deployments[network])

export const listDeployments = (): NetworkName[] => Object.keys(deployments) as NetworkName[]

/** Resolves the network from an explicit value, then env, defaulting to Base Sepolia. */
export const resolveNetwork = (explicit?: string): NetworkName => {
  const value =
    explicit ??
    process.env.PONDER_NETWORK ??
    process.env.POA_NETWORK ??
    (process.env.CHAIN_ID === '31337' ? 'anvil' : undefined) ??
    'base-sepolia'
  if (value !== 'base-sepolia' && value !== 'base' && value !== 'anvil') {
    throw new Error(`Unsupported network "${value}"`)
  }
  return value
}
