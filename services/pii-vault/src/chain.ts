import {
  beneficiaryGroupsAbi,
  chainFor,
  type Deployment,
  getDeployment,
  hasRole,
  isActiveNgo,
  ROLES,
  type RoleCheckContext,
} from '@poa/shared'
import { type Address, createPublicClient, http, type PublicClient } from 'viem'
import type { VaultConfig } from './config.js'

/**
 * Every authorisation decision in this service is a chain read. An NGO owns a program because
 * `BeneficiaryGroups.programNgo` says so, and a verifier may read a dossier because the RoleRegistry says so —
 * nothing is inferred from a record's own columns, which a compromised row could otherwise forge.
 */

export interface Chain {
  client: PublicClient
  deployment: Deployment
  roles: RoleCheckContext
}

export const createChain = (config: VaultConfig): Chain => {
  const deployment = getDeployment(config.network)
  const client = createPublicClient({
    chain: chainFor(config.network),
    transport: http(config.rpcUrl),
  }) as PublicClient
  return { client, deployment, roles: { client, roleRegistry: deployment.contracts.RoleRegistry } }
}

export const requireActiveNgo = async (chain: Chain, account: Address): Promise<boolean> =>
  isActiveNgo(chain.roles, account)

export const isRegisteredVerifier = async (chain: Chain, account: Address): Promise<boolean> =>
  hasRole(chain.roles, ROLES.VERIFIER, account)

/** The NGO that created a program; zero address when the program does not exist. */
export const programOwner = async (chain: Chain, programId: bigint): Promise<Address> =>
  chain.client.readContract({
    address: chain.deployment.contracts.BeneficiaryGroups,
    abi: beneficiaryGroupsAbi,
    functionName: 'programNgo',
    args: [programId],
  })
