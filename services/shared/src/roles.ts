import { type Address, type Hex, keccak256, type PublicClient, toHex } from 'viem'
import { roleRegistryAbi } from './abis/index.js'

/** Role identifiers, matching src/libraries/Roles.sol. */
export const ROLES = {
  DEFAULT_ADMIN: `0x${'00'.repeat(32)}` as Hex,
  NGO: keccak256(toHex('NGO_ROLE')),
  VERIFIER: keccak256(toHex('VERIFIER_ROLE')),
} as const

export type RoleName = keyof typeof ROLES

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
