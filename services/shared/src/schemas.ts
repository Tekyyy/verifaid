import {
  type AbiParameter,
  type Address,
  type Hex,
  decodeAbiParameters,
  encodeAbiParameters,
  encodePacked,
  keccak256,
} from 'viem'
import type { SchemaName } from './types.js'

export interface SchemaDefinition {
  name: SchemaName
  schema: string
  revocable: boolean
  /** Which contract must be the attestation recipient — never a person (spec §6). */
  recipient: 'NeedsRegistry' | 'DeliveryManager' | 'AidVault'
}

/** The five schemas of the system, exactly as registered by RegisterSchemas.s.sol. */
export const SCHEMAS: Record<SchemaName, SchemaDefinition> = {
  NeedVerified: {
    name: 'NeedVerified',
    schema: 'uint256 needId,bytes32 dossierHash,bool approved,bytes32 reportHash',
    revocable: true,
    recipient: 'NeedsRegistry',
  },
  DeliveryEvidence: {
    name: 'DeliveryEvidence',
    schema: 'uint256 deliveryId,bytes32 evidenceHash,string evidenceCID,uint32 itemsDelivered,bytes32 regionCode',
    revocable: false,
    recipient: 'DeliveryManager',
  },
  DeliveryVerified: {
    name: 'DeliveryVerified',
    schema: 'uint256 deliveryId,bool approved,bytes32 reportHash',
    revocable: false,
    recipient: 'DeliveryManager',
  },
  FiatDonation: {
    name: 'FiatDonation',
    schema: 'uint256 needId,uint256 amount,bytes32 paymentRefHash,bytes32 donorRefHash',
    revocable: false,
    recipient: 'AidVault',
  },
  ImpactReport: {
    name: 'ImpactReport',
    schema: 'uint256 needId,uint32 beneficiariesServed,bytes32 kpiHash,string reportCID',
    revocable: true,
    recipient: 'AidVault',
  },
}

/**
 * Turns an EAS schema string ("uint256 needId,bool approved") into ABI parameters.
 * EAS encodes attestation data as plain ABI encoding of these fields, so viem can encode and decode it
 * directly — no ethers-based SDK needed on either side.
 */
export const schemaToAbiParameters = (schema: string): AbiParameter[] =>
  schema
    .split(',')
    .map((field) => field.trim())
    .filter(Boolean)
    .map((field) => {
      const parts = field.split(/\s+/)
      const type = parts[0]
      const name = parts[1]
      if (!type || !name) throw new Error(`Malformed schema field: "${field}"`)
      return { type, name } as AbiParameter
    })

export const encodeSchemaData = (name: SchemaName, values: readonly unknown[]): Hex =>
  encodeAbiParameters(schemaToAbiParameters(SCHEMAS[name].schema), values as never)

export const decodeSchemaData = <T extends readonly unknown[]>(name: SchemaName, data: Hex): T =>
  decodeAbiParameters(schemaToAbiParameters(SCHEMAS[name].schema), data) as unknown as T

/**
 * The UID a schema gets in the EAS SchemaRegistry: keccak256(schema, resolver, revocable).
 * Each resolver derives the same value from its own address, which is why a schema squatted on one of our
 * resolvers can never drive core state.
 */
export const computeSchemaUid = (schema: string, resolver: Address, revocable: boolean): Hex =>
  keccak256(encodePacked(['string', 'address', 'bool'], [schema, resolver, revocable]))

/** Decoded attestation payloads, in the order the schema declares them. */
export type NeedVerifiedData = readonly [needId: bigint, dossierHash: Hex, approved: boolean, reportHash: Hex]
export type DeliveryEvidenceData = readonly [
  deliveryId: bigint,
  evidenceHash: Hex,
  evidenceCID: string,
  itemsDelivered: number,
  regionCode: Hex,
]
export type DeliveryVerifiedData = readonly [deliveryId: bigint, approved: boolean, reportHash: Hex]
export type FiatDonationData = readonly [needId: bigint, amount: bigint, paymentRefHash: Hex, donorRefHash: Hex]
export type ImpactReportData = readonly [
  needId: bigint,
  beneficiariesServed: number,
  kpiHash: Hex,
  reportCID: string,
]
