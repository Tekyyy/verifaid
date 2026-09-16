import {
  chainFor,
  type Deployment,
  deliveryManagerAbi,
  getDeployment,
  isActiveNgo,
  isFieldAgentOf,
  isIndependentVerifier,
  needsRegistryAbi,
  type RoleCheckContext,
} from '@poa/shared'
import { type Address, createPublicClient, type Hex, http, type PublicClient } from 'viem'
import type { EvidenceConfig } from './config.js'

/**
 * Read-only chain access. Roles are always resolved here and never taken from the request, so a caller cannot
 * claim to be a field agent: they can only prove which address they control (SIWE) and the chain decides the rest.
 */

export interface Chain {
  client: PublicClient
  deployment: Deployment
  roles: RoleCheckContext
}

export const createChain = (config: EvidenceConfig): Chain => {
  const deployment = getDeployment(config.network)
  const client = createPublicClient({
    chain: chainFor(config.network),
    transport: http(config.rpcUrl),
  }) as PublicClient
  return { client, deployment, roles: { client, roleRegistry: deployment.contracts.RoleRegistry } }
}

export interface DeliveryContext {
  deliveryId: bigint
  needId: bigint
  ngo: Address
  fieldAgent: Address
  /** 0 = Open, per IDeliveryManager.DeliveryStatus. */
  status: number
  regionCode: Hex
}

/** Resolves a delivery and the need it belongs to in two reads, so the caller sees one consistent picture. */
export const getDeliveryContext = async (
  chain: Chain,
  deliveryId: bigint,
): Promise<DeliveryContext | null> => {
  const delivery = await chain.client.readContract({
    address: chain.deployment.contracts.DeliveryManager,
    abi: deliveryManagerAbi,
    functionName: 'getDelivery',
    args: [deliveryId],
  })
  if (delivery.id === 0n) return null

  const need = await chain.client.readContract({
    address: chain.deployment.contracts.NeedsRegistry,
    abi: needsRegistryAbi,
    functionName: 'getNeed',
    args: [delivery.needId],
  })

  return {
    deliveryId: delivery.id,
    needId: delivery.needId,
    ngo: need.ngo,
    fieldAgent: delivery.fieldAgent,
    status: delivery.status,
    regionCode: need.regionCode,
  }
}

/** The NGO that owns a need, used to pick the key context an evidence bundle is sealed under. */
export const ngoOfNeed = async (chain: Chain, needId: bigint): Promise<Address> => {
  const need = await chain.client.readContract({
    address: chain.deployment.contracts.NeedsRegistry,
    abi: needsRegistryAbi,
    functionName: 'getNeed',
    args: [needId],
  })
  return need.ngo
}

export type EvidenceRole = 'ngo' | 'fieldAgent' | 'verifier'

/**
 * Who may read one evidence bundle (spec §9.1): the owning NGO, the field agent that uploaded it, or a verifier
 * the registry considers independent of that NGO. Checked against the chain on every request, so revoking a
 * field agent or deactivating an NGO takes effect immediately.
 */
export const resolveEvidenceRole = async (
  chain: Chain,
  caller: Address,
  ngo: Address,
  uploader: Address,
): Promise<EvidenceRole | null> => {
  const lower = caller.toLowerCase()
  if (lower === ngo.toLowerCase()) {
    return (await isActiveNgo(chain.roles, caller)) ? 'ngo' : null
  }
  if (lower === uploader.toLowerCase() && (await isFieldAgentOf(chain.roles, caller, ngo))) {
    return 'fieldAgent'
  }
  return (await isIndependentVerifier(chain.roles, caller, ngo)) ? 'verifier' : null
}

export { isFieldAgentOf }
