import type { Address, Hex } from 'viem'

/** Networks this project is wired for. */
export type NetworkName = 'base-sepolia' | 'base' | 'anvil'

/** Shape of `deployments/<network>.json`, written by Deploy.s.sol and RegisterSchemas.s.sol. */
export interface Deployment {
  network: NetworkName
  /** Contract release; v2 introduced need terms, non-custodial ledgers and the single resolver. */
  version?: number
  chainId: number
  startBlock: number
  deployer: Address
  admin: Address
  contracts: {
    RoleRegistry: Address
    NeedsRegistry: Address
    AidVaultImplementation: Address
    NonCustodialLedgerImplementation: Address
    AidVaultFactory: Address
    DonationReceipt: Address
    BeneficiaryGroups: Address
    DeliveryManager: Address
    ProofOfAidResolver: Address
  }
  external: {
    EAS: Address
    SchemaRegistry: Address
    Semaphore: Address
    SemaphoreVerifier: Address
    Token: Address
  }
  params: {
    confirmationThresholdBps: number
    challengePeriodSeconds: number
    highValueThreshold: string | number
    minExpectedRecipients: number
    dashboardBaseURI: string
  }
  schemas: Record<SchemaName, Hex>
}

/** The six EAS schemas of the system, in the order a donor experiences them. */
export const SCHEMA_NAMES = [
  'NeedVerified',
  'FundingRecorded',
  'DeliveryEvidence',
  'DeliveryVerified',
  'Settlement',
  'ImpactReport',
] as const
export type SchemaName = (typeof SCHEMA_NAMES)[number]

/** Need lifecycle, mirroring INeedsRegistry.NeedStatus. */
export const NEED_STATUS = [
  'Pending',
  'Verified',
  'Funding',
  'Funded',
  'InDelivery',
  'Completed',
  'Cancelled',
  'Expired',
] as const
export type NeedStatus = (typeof NEED_STATUS)[number]

/**
 * Where a need's money lives, mirroring INeedsRegistry.CustodyMode.
 * `OnChain`: stablecoin escrow in an AidVault (the proposal's Model B).
 * `OffChain`: a payment provider holds the money and attests funding and payouts (Model A).
 */
export const CUSTODY_MODE = ['OnChain', 'OffChain'] as const
export type CustodyMode = (typeof CUSTODY_MODE)[number]

/** Delivery lifecycle, mirroring IDeliveryManager.DeliveryStatus. */
export const DELIVERY_STATUS = ['Open', 'Challengeable', 'Disputed', 'Finalized', 'Rejected'] as const
export type DeliveryStatus = (typeof DELIVERY_STATUS)[number]

/** Tranche lifecycle, mirroring ITrancheLedger.TrancheStatus. */
export const TRANCHE_STATUS = ['Locked', 'Releasable', 'Released'] as const
export type TrancheStatus = (typeof TRANCHE_STATUS)[number]

export const needStatusName = (value: number): NeedStatus => NEED_STATUS[value] ?? 'Pending'
export const custodyModeName = (value: number): CustodyMode => CUSTODY_MODE[value] ?? 'OnChain'
export const deliveryStatusName = (value: number): DeliveryStatus => DELIVERY_STATUS[value] ?? 'Open'
export const trancheStatusName = (value: number): TrancheStatus => TRANCHE_STATUS[value] ?? 'Locked'

/** On-chain numeric values, for the few places that compare raw contract reads. */
export const NEED_STATUS_VALUE = Object.fromEntries(NEED_STATUS.map((name, i) => [name, i])) as Record<
  NeedStatus,
  number
>
export const DELIVERY_STATUS_VALUE = Object.fromEntries(DELIVERY_STATUS.map((name, i) => [name, i])) as Record<
  DeliveryStatus,
  number
>
