import type { Context } from 'ponder:registry'
import schema from 'ponder:schema'
import { type ReleasePolicyKind, releasePolicyAbi } from '@poa/shared'
import type { Address } from 'viem'

/** The shape of a policy, from its parameters: who has a say decides what it is called on the page. */
export const policyKind = (donorApprovalBps: number, verifiers: boolean): ReleasePolicyKind => {
  if (donorApprovalBps > 0 && verifiers) return 'both'
  if (donorApprovalBps > 0) return 'donors'
  return verifiers ? 'verifier' : 'custom'
}

/**
 * Makes sure the policy has a row, reading its parameters from the contract the first time it is seen. A policy
 * that is not a ReleasePolicy (one the platform approves later, with its own rules) is recorded as `custom`.
 */
export const ensurePolicy = async (context: Context, address: Address, timestamp: number): Promise<void> => {
  const existing = await context.db.find(schema.releasePolicy, { address })
  if (existing) return

  const read = <T>(
    functionName: 'name' | 'donorApprovalBps' | 'donorRejectionBps' | 'verifiers' | 'retries',
  ) => context.client.readContract({ address, abi: releasePolicyAbi, functionName }) as Promise<T>

  let row = {
    name: 'Custom policy',
    kind: 'custom' as ReleasePolicyKind,
    donorApprovalBps: 0,
    donorRejectionBps: 0,
    verifiers: false,
    retries: 0,
  }
  try {
    const [name, donorApprovalBps, donorRejectionBps, verifiers, retries] = await Promise.all([
      read<string>('name'),
      read<number>('donorApprovalBps'),
      read<number>('donorRejectionBps'),
      read<boolean>('verifiers'),
      read<number>('retries'),
    ])
    row = {
      name,
      kind: policyKind(Number(donorApprovalBps), verifiers),
      donorApprovalBps: Number(donorApprovalBps),
      donorRejectionBps: Number(donorRejectionBps),
      verifiers,
      retries: Number(retries),
    }
  } catch {
    // Not one of ours: its rules are its own business, and the page says so rather than guessing.
  }

  await context.db
    .insert(schema.releasePolicy)
    .values({ address, ...row, allowed: false, isDefault: false, updatedAt: timestamp })
    .onConflictDoNothing()
}
