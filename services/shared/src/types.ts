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
    AidVaultFactory: Address
    DonationReceipt: Address
    /** v9: the NGOs' programmes (Semaphore groups until v8). */
    ProgramRegistry: Address
    DeliveryManager: Address
    /** v9: the built-in release policies a need chooses from when it is created. */
    ReleasePolicyDonors: Address
    ReleasePolicyVerifier: Address
    ReleasePolicyDonorsAndVerifier: Address
    ProofOfAidResolver: Address
    /** v3: oracle-bounded swaps into the vault token. */
    ConversionRouter?: Address
    DonationForwarderImplementation?: Address
    /** v3: wallet donations in other tokens, and deposit addresses. */
    DonationForwarderFactory?: Address
  }
  external: {
    EAS: Address
    SchemaRegistry: Address
    /** The currency the vaults hold, and the unit of every published figure: this chain's USDC or EURC. */
    Token: Address
    /** v3 conversion path; on local chains these are mocks. */
    SwapRouter?: Address
    WETH?: Address
    /** The chain's dollar and euro stablecoins; one of them is `Token`, the other converts into it. */
    USDC?: Address
    EURC?: Address
    EurUsdFeed?: Address
    UsdcUsdFeed?: Address
    EthUsdFeed?: Address
    SequencerUptimeFeed?: Address
    /** ERC-4626 vault where a need may let idle escrow wait; absent or zero when the platform approves none. */
    YieldVenue?: Address
  }
  params: {
    /** Share of the raised amount whose donors must approve a delivery to unlock the next tranche. */
    donorApprovalBps: number
    /** v9: share of the raised amount whose donors must reject a delivery to send the NGO back. */
    donorRejectionBps: number
    /** v9: fresh starts an NGO gets on rejected or contested evidence before a rejection cancels the need. */
    rejectionRetries: number
    highValueThreshold: string | number
    /** v8: the k-anonymity floor an impact report's "people served" must reach. */
    minBeneficiariesServed: number
    dashboardBaseURI: string
    /** v3: the oracle bound of the stablecoin route into the vault currency, in basis points. */
    maxSlippageBps?: number
    /** v3: the oracle bound of the ETH route (two hops through volatile pools), in basis points. */
    ethMaxSlippageBps?: number
    /** v3: Uniswap v3 fee tier of the stablecoin → vault currency pool (100 = 0.01%, 500 = 0.05%). */
    usdcPoolFee?: number
    /** v3: true when the swap router is a mock that fills at oracle prices (local chains). */
    mockSwapRouter?: boolean
    /** v3: true when an ETH → vault token route is configured (it needs WETH liquidity on the chain). */
    ethDonations?: boolean
  }
  /** v9: who holds the admin role once Handover.s.sol has run. Zero addresses until then. */
  governance?: {
    /** The multisig that proposes every admin action. */
    Safe: Address
    /** The TimelockController that is the admin: proposals wait `delay` seconds before anyone may execute them. */
    Timelock: Address
    /** May pause the system at once, and nothing else. */
    Guardian: Address
    threshold: number
    delay: number
  }
  schemas: Record<SchemaName, Hex>
  /** Resolver-less schemas: work photos and supplier applications. Absent on deployments that predate them. */
  communitySchemas?: Partial<
    Record<
      'WorkPhotos' | 'SupplierApplication' | 'NeedPresentation' | 'OrgTaxStatus' | 'DonationAcknowledged',
      Hex
    >
  >
}

/** The three EAS schemas of the system, in the order a donor experiences them. Deliveries need none since v8:
 *  the NGO files its evidence with DeliveryManager and donors approve it there. */
export const SCHEMA_NAMES = ['NeedVerified', 'Settlement', 'ImpactReport'] as const
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

/** Delivery lifecycle, mirroring IDeliveryManager.DeliveryStatus: under review, approved (its tranche became
 *  releasable), replaced by newer evidence before it was decided, or voted down. */
export const DELIVERY_STATUS = ['Open', 'Approved', 'Superseded', 'Rejected'] as const
export type DeliveryStatus = (typeof DELIVERY_STATUS)[number]

/** In which capacity someone votes on evidence, mirroring IReleasePolicy.Voice. */
export const VOICES = ['None', 'Donor', 'Verifier'] as const
export type Voice = (typeof VOICES)[number]
export const voiceName = (value: number): Voice => VOICES[value] ?? 'None'

/** Tranche lifecycle, mirroring ITrancheLedger.TrancheStatus. */
export const TRANCHE_STATUS = ['Locked', 'Releasable', 'Released'] as const
export type TrancheStatus = (typeof TRANCHE_STATUS)[number]

export const needStatusName = (value: number): NeedStatus => NEED_STATUS[value] ?? 'Pending'
export const deliveryStatusName = (value: number): DeliveryStatus => DELIVERY_STATUS[value] ?? 'Open'
export const trancheStatusName = (value: number): TrancheStatus => TRANCHE_STATUS[value] ?? 'Locked'

/** On-chain numeric values, for the few places that compare raw contract reads. */
export const NEED_STATUS_VALUE = Object.fromEntries(NEED_STATUS.map((name, i) => [name, i])) as Record<
  NeedStatus,
  number
>
export const DELIVERY_STATUS_VALUE = Object.fromEntries(
  DELIVERY_STATUS.map((name, i) => [name, i]),
) as Record<DeliveryStatus, number>
