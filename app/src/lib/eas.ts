import { encodeSchemaData, SCHEMAS, type SchemaName } from '@poa/shared'
import type { Address, Hex } from 'viem'
import { requireDeployment } from './config'

export const ZERO_UID = `0x${'00'.repeat(64 / 2)}` as Hex

export interface AttestationInput {
  name: SchemaName
  /** Always a contract (spec §6): the registry, the DeliveryManager or the need's vault — never a person. */
  recipient: Address
  /** `DeliveryVerified.refUID` must be the delivery's evidence UID; `ImpactReport.refUID` the last one. */
  refUID?: Hex | null
  values: readonly unknown[]
}

/** Builds the single argument `EAS.attest` takes, with the schema UID from the bundled deployment. */
export const attestationRequest = ({ name, recipient, refUID, values }: AttestationInput) => ({
  schema: requireDeployment().schemas[name],
  data: {
    recipient,
    expirationTime: 0n,
    revocable: SCHEMAS[name].revocable,
    refUID: refUID && refUID !== ZERO_UID ? refUID : ZERO_UID,
    data: encodeSchemaData(name, values),
    value: 0n,
  },
})
