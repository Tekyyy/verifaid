import { type Address, type Hex, keccak256, type PublicClient, toHex } from 'viem'
import { roleRegistryAbi } from './abis/index.js'

/** Role identifiers, matching src/libraries/Roles.sol. */
export const ROLES = {
  DEFAULT_ADMIN: `0x${'00'.repeat(32)}` as Hex,
  NGO: keccak256(toHex('NGO_ROLE')),
  VERIFIER: keccak256(toHex('VERIFIER_ROLE')),
  FIELD_AGENT: keccak256(toHex('FIELD_AGENT_ROLE')),
  BANK_PARTNER: keccak256(toHex('BANK_PARTNER_ROLE')),
} as const

export type RoleName = keyof typeof ROLES

/** The message every beneficiary signs in a receipt confirmation proof. */
export const AID_RECEIVED_MESSAGE = BigInt(keccak256(toHex('AID_RECEIVED')))

export interface RoleCheckContext {
  client: PublicClient
  roleRegistry: Address
}

export const hasRole = async (ctx: RoleCheckContext, role: Hex, account: Address): Promise<boolean> =>
  ctx.client.readContract({
    address: ctx.roleRegistry,
    abi: roleRegistryAbi,
    functionName: 'hasRole',
    args: [role, account],
  }) as Promise<boolean>

export const isActiveNgo = async (ctx: RoleCheckContext, account: Address): Promise<boolean> =>
  ctx.client.readContract({
    address: ctx.roleRegistry,
    abi: roleRegistryAbi,
    functionName: 'isActiveNgo',
    args: [account],
  }) as Promise<boolean>

export const isFieldAgentOf = async (ctx: RoleCheckContext, agent: Address, ngo: Address): Promise<boolean> =>
  ctx.client.readContract({
    address: ctx.roleRegistry,
    abi: roleRegistryAbi,
    functionName: 'isFieldAgentOf',
    args: [agent, ngo],
  }) as Promise<boolean>

export const isIndependentVerifier = async (
  ctx: RoleCheckContext,
  verifier: Address,
  ngo: Address,
): Promise<boolean> =>
  ctx.client.readContract({
    address: ctx.roleRegistry,
    abi: roleRegistryAbi,
    functionName: 'isIndependent',
    args: [verifier, ngo],
  }) as Promise<boolean>

export const ngoOfFieldAgent = async (ctx: RoleCheckContext, agent: Address): Promise<Address> =>
  ctx.client.readContract({
    address: ctx.roleRegistry,
    abi: roleRegistryAbi,
    functionName: 'fieldAgentNgo',
    args: [agent],
  }) as Promise<Address>
