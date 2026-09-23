import {
  COMMUNITY_SCHEMAS,
  type CommunitySchemaName,
  encodeCommunityData,
  encodeSchemaData,
  SCHEMAS,
  type SchemaName,
} from '@poa/shared'
import type { Address, Hex } from 'viem'
import { requireDeployment } from './config'

export const ZERO_UID = `0x${'00'.repeat(64 / 2)}` as Hex

export interface AttestationInput {
  name: SchemaName
  /**
   * Always a contract (spec §6): the registry, the DeliveryManager or the need's ledger (its AidVault or
   * NonCustodialLedger) — never a person. `schemaRecipient` resolves it from the schema definition.
   */
  recipient: Address
  /** Only for schemas that chain to another attestation. None of the three core schemas does today. */
  refUID?: Hex | null
  values: readonly unknown[]
}

/** True when the bundled deployment registered `name` (a v1 deployment has no `Settlement` schema, say). */
export const hasSchema = (name: SchemaName): boolean => {
  try {
    return Boolean(requireDeployment().schemas[name])
  } catch {
    return false
  }
}

/**
 * The recipient the single ProofOfAidResolver requires for a schema. `ledger` is the need's `vaultOf(needId)`
 * and is only needed for the ledger-bound schemas (Settlement, ImpactReport).
 */
export const schemaRecipient = (name: SchemaName, ledger?: Address | null): Address | null => {
  const contracts = requireDeployment().contracts
  switch (SCHEMAS[name].recipient) {
    case 'NeedsRegistry':
      return contracts.NeedsRegistry
    default:
      return ledger ?? null
  }
}

/** Builds the single argument `EAS.attest` takes, with the schema UID from the bundled deployment. */
export const attestationRequest = ({ name, recipient, refUID, values }: AttestationInput) => {
  const schema = requireDeployment().schemas[name]
  if (!schema) throw new Error(`The bundled deployment has no "${name}" schema.`)
  return {
    schema,
    data: {
      recipient,
      expirationTime: 0n,
      revocable: SCHEMAS[name].revocable,
      refUID: refUID && refUID !== ZERO_UID ? refUID : ZERO_UID,
      data: encodeSchemaData(name, values),
      value: 0n,
    },
  }
}

/**
 * The resolver-less schemas (work photos, supplier applications). Nothing on-chain reads them, so they take no
 * recipient and no resolver: the attestation is the record, and the indexer decides what counts (a photo only
 * when the need's own NGO signed it, an application only for the address signing it).
 */
export const communityAttestationRequest = (name: CommunitySchemaName, values: readonly unknown[]) => {
  const schema = requireDeployment().communitySchemas?.[name]
  if (!schema) throw new Error(`The bundled deployment has no "${name}" schema.`)
  return {
    schema,
    data: {
      recipient: '0x0000000000000000000000000000000000000000' as Address,
      expirationTime: 0n,
      revocable: COMMUNITY_SCHEMAS[name].revocable,
      refUID: ZERO_UID,
      data: encodeCommunityData(name, values),
      value: 0n,
    },
  }
}

/** True when the bundled deployment registered the resolver-less schemas (older ones did not). */
export const hasCommunitySchema = (name: CommunitySchemaName): boolean => {
  try {
    return Boolean(requireDeployment().communitySchemas?.[name])
  } catch {
    return false
  }
}
