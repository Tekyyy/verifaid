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
 * Schemas with **no resolver**: anyone can attest them, and nothing on-chain reads them. They carry what the
 * system deliberately does not gate — an NGO publishing photos of the work it did, and a supplier asking to be
 * registered — so they add a public, attributable record without widening what can move money. The indexer is
 * what gives them meaning: it keeps a photo attestation only when the need's own NGO signed it.
 */
export const COMMUNITY_SCHEMAS = {
  WorkPhotos: {
    name: 'WorkPhotos' as const,
    schema: 'uint256 needId,string[] photos,string note',
    revocable: true,
  },
  NeedPresentation: {
    name: 'NeedPresentation' as const,
    schema: 'uint256 needId,string coverImage,string[] gallery,string summary,string[] tags',
    revocable: true,
  },
  OrgTaxStatus: {
    name: 'OrgTaxStatus' as const,
    schema: 'address org,string jurisdiction,string taxId,string legalName,string source',
    revocable: true,
  },
  DonationAcknowledged: {
    name: 'DonationAcknowledged' as const,
    schema: 'uint256 receiptId,uint256 needId,bytes32 documentHash,string statement',
    revocable: true,
  },
  SupplierApplication: {
    name: 'SupplierApplication' as const,
    schema: 'address supplier,string name,string services,string uri,bytes32 credentialHash',
    revocable: true,
  },
}

export type CommunitySchemaName = keyof typeof COMMUNITY_SCHEMAS

export const encodeCommunityData = (name: CommunitySchemaName, values: readonly unknown[]): Hex =>
  encodeAbiParameters(schemaToAbiParameters(COMMUNITY_SCHEMAS[name].schema), values as never)

export const decodeCommunityData = <T extends readonly unknown[]>(name: CommunitySchemaName, data: Hex): T =>
  decodeAbiParameters(schemaToAbiParameters(COMMUNITY_SCHEMAS[name].schema), data) as unknown as T

/** Photos of finished work, published by the NGO that ran the need. Never people: goods, sites, deliveries. */
export type WorkPhotosData = readonly [needId: bigint, photos: readonly string[], note: string]

/**
 * How an NGO presents a need to donors: a cover image, more images, a short summary and a few tags. Nothing
 * on-chain reads it, and the terms it sits next to — target, tranches, payment plan — cannot be dressed up by
 * it. Publishing again replaces it, so a presentation can be corrected without touching the need itself.
 */
export type NeedPresentationData = readonly [
  needId: bigint,
  coverImage: string,
  gallery: readonly string[],
  summary: string,
  tags: readonly string[],
]

/**
 * What an organisation says about its own tax standing — and, when the platform admin signs the same schema for
 * that organisation, that somebody checked it. The attester is what separates a claim from a verification, so
 * one schema carries both: `source` is the determination letter when the org signs it, and where and when it
 * was checked when the admin does.
 *
 * A tax id of a registered charity is public information (the IRS publishes EINs); a donor's is not, and never
 * appears anywhere in this system.
 */
export type OrgTaxStatusData = readonly [
  org: Address,
  jurisdiction: string,
  taxId: string,
  legalName: string,
  source: string,
]

/**
 * The donee acknowledging one donation, which is what a US donor needs to hold for a contribution of $250 or
 * more. `statement` is the acknowledgment text itself and `documentHash` is its keccak256, so a PDF a donor
 * downloads later can be checked against what the organisation actually signed. No donor name is committed:
 * the acknowledgment is about the donation, and the donor adds their own details to the document.
 */
export type DonationAcknowledgedData = readonly [
  receiptId: bigint,
  needId: bigint,
  documentHash: Hex,
  statement: string,
]

/** A supplier asking to be registered. An admin still has to grant the role; this is the public request. */
export type SupplierApplicationData = readonly [
  supplier: Address,
  name: string,
  services: string,
  uri: string,
  credentialHash: Hex,
]

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
