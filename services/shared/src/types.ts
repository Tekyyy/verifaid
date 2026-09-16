import type { Address, Hex } from 'viem'

/** Networks this project is wired for. */
export type NetworkName = 'base-sepolia' | 'base' | 'anvil'

/** Shape of `deployments/<network>.json`, written by Deploy.s.sol and RegisterSchemas.s.sol. */
export interface Deployment {
  network: NetworkName
  chainId: number
  startBlock: number
  deployer: Address
  admin: Address
  contracts: {
    RoleRegistry: Address
    NeedsRegistry: Address
    AidVaultImplementation: Address
    AidVaultFactory: Address
    DonationReceipt: Address
    BeneficiaryGroups: Address
    DeliveryManager: Address
    NeedVerifiedResolver: Address
    DeliveryEvidenceResolver: Address
    DeliveryVerifiedResolver: Address
    FiatDonationResolver: Address
    ImpactReportResolver: Address
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

/** The five EAS schemas of the system. */
export type SchemaName =
  | 'NeedVerified'
  | 'DeliveryEvidence'
  | 'DeliveryVerified'
  | 'FiatDonation'
  | 'ImpactReport'

/** Need lifecycle, mirroring INeedsRegistry.NeedStatus. */
export const NEED_STATUS = [
  'Pending',
  'Verified',
  'Funding',
  'Funded',
  'InDelivery',
  'Completed',
  'Cancelled',
] as const
export type NeedStatus = (typeof NEED_STATUS)[number]

/** Delivery lifecycle, mirroring IDeliveryManager.DeliveryStatus. */
export const DELIVERY_STATUS = ['Open', 'Challengeable', 'Disputed', 'Finalized', 'Rejected'] as const
export type DeliveryStatus = (typeof DELIVERY_STATUS)[number]

/** Tranche lifecycle, mirroring IAidVault.TrancheStatus. */
export const TRANCHE_STATUS = ['Locked', 'Releasable', 'Released'] as const
export type TrancheStatus = (typeof TRANCHE_STATUS)[number]

export const needStatusName = (value: number): NeedStatus => NEED_STATUS[value] ?? 'Pending'
export const deliveryStatusName = (value: number): DeliveryStatus => DELIVERY_STATUS[value] ?? 'Open'
export const trancheStatusName = (value: number): TrancheStatus => TRANCHE_STATUS[value] ?? 'Locked'
