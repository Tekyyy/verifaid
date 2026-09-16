import {
  type AbiParameter,
  type Address,
  decodeAbiParameters,
  encodeAbiParameters,
  encodePacked,
  type Hex,
  keccak256,
} from 'viem'
import type { SchemaName } from './types.js'

export interface SchemaDefinition {
  name: SchemaName
  schema: string
  revocable: boolean
  /**
   * Which contract must be the attestation recipient — never a person (spec §6). `Ledger` is the need's
   * AidVault (on-chain custody) or NonCustodialLedger (off-chain custody): whatever `vaultOf(needId)` returns.
   */
  recipient: 'NeedsRegistry' | 'DeliveryManager' | 'Ledger'
}

/**
 * The six schemas of the system, exactly as registered by RegisterSchemas.s.sol against the single
 * ProofOfAidResolver. Amounts are in the need's stablecoin base units; `currency` is what a donor paid in.
 */
export const SCHEMAS: Record<SchemaName, SchemaDefinition> = {
  NeedVerified: {
    name: 'NeedVerified',
    schema: 'uint256 needId,bytes32 dossierHash,bool approved,bytes32 reportHash',
    revocable: true,
    recipient: 'NeedsRegistry',
  },
  FundingRecorded: {
    name: 'FundingRecorded',
    schema:
      'uint256 needId,uint256 gross,uint256 fee,uint256 net,bytes32 currency,bytes32 paymentRefHash,bytes32 donorRefHash',
    revocable: false,
    recipient: 'Ledger',
  },
  DeliveryEvidence: {
    name: 'DeliveryEvidence',
    schema:
      'uint256 deliveryId,bytes32 evidenceHash,string evidenceCID,uint32 itemsDelivered,bytes32 regionCode',
    revocable: false,
    recipient: 'DeliveryManager',
  },
  DeliveryVerified: {
    name: 'DeliveryVerified',
    schema: 'uint256 deliveryId,bool approved,bytes32 reportHash',
    revocable: false,
    recipient: 'DeliveryManager',
  },
  Settlement: {
    name: 'Settlement',
    schema:
      'uint256 needId,uint256 trancheIndex,uint256 gross,uint256 fee,uint256 net,bytes32 supplierRefHash,bytes32 fxRef',
    revocable: false,
    recipient: 'Ledger',
  },
  ImpactReport: {
    name: 'ImpactReport',
    schema: 'uint256 needId,uint32 beneficiariesServed,bytes32 kpiHash,string reportCID',
    revocable: true,
    recipient: 'Ledger',
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
 * The resolver derives the same values from its own address, which is why a schema squatted on our resolver can
 * never drive core state.
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
export type FundingRecordedData = readonly [
  needId: bigint,
  gross: bigint,
  fee: bigint,
  net: bigint,
  currency: Hex,
  paymentRefHash: Hex,
  donorRefHash: Hex,
]
export type SettlementData = readonly [
  needId: bigint,
  trancheIndex: bigint,
  gross: bigint,
  fee: bigint,
  net: bigint,
  supplierRefHash: Hex,
  fxRef: Hex,
]
export type ImpactReportData = readonly [
  needId: bigint,
  beneficiariesServed: number,
  kpiHash: Hex,
  reportCID: string,
]
