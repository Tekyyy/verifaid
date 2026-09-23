import type { ReleasePolicyKind, ReleasePolicyView } from '@poa/shared'
import type { Address } from 'viem'
import { deployment } from './config'

/**
 * The release rules a new need can choose. These are the three built-in policies the deployment approved, named by
 * who decides; their parameters come from the deployment file, which recorded what the deploy script configured.
 * A need page never reads this list: it shows the policy the need itself chose, from the indexer.
 */
export const builtInPolicies = (): ReleasePolicyView[] => {
  if (!deployment) return []
  const { contracts, params } = deployment
  const approve = params.donorApprovalBps ?? 3000
  const reject = params.donorRejectionBps ?? 5000
  const retries = params.rejectionRetries ?? 1
  const make = (
    address: Address | undefined,
    kind: ReleasePolicyKind,
    name: string,
  ): ReleasePolicyView | null =>
    address
      ? {
          address,
          kind,
          name,
          donorApprovalBps: kind === 'verifier' ? 0 : approve,
          donorRejectionBps: kind === 'verifier' ? 0 : reject,
          verifiers: kind !== 'donors',
          retries,
        }
      : null
  return [
    make(contracts.ReleasePolicyDonors, 'donors', 'Donors decide'),
    make(contracts.ReleasePolicyVerifier, 'verifier', 'A verifier checks'),
    make(contracts.ReleasePolicyDonorsAndVerifier, 'both', 'Donors and a verifier'),
  ].filter((policy): policy is ReleasePolicyView => policy !== null)
}

/** Basis points as a whole or one-decimal percentage, the way the rules are written to donors. */
export const bpsToPercent = (bps: number): string => {
  const percent = bps / 100
  return Number.isInteger(percent) ? String(percent) : percent.toFixed(1)
}
