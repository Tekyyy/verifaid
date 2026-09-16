import {
  aidVaultAbi,
  aidVaultFactoryAbi,
  CUSTODY_MODE,
  type CustodyMode,
  chainFor,
  type Deployment,
  decodeSchemaData,
  easAbi,
  encodeSchemaData,
  type FundingRecordedData,
  getDeployment,
  hasRole,
  mockEURCAbi,
  needsRegistryAbi,
  nonCustodialLedgerAbi,
  proofOfAidResolverAbi,
  ROLES,
  type SchemaName,
  type SettlementData,
  TRANCHE_STATUS,
  type TrancheStatus,
} from '@poa/shared'
import {
  type Account,
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  type Hex,
  http,
  type PublicClient,
  type WalletClient,
  zeroAddress,
  zeroHash,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { BankConfig } from './config.js'
import { conflict, forbidden, HttpError, unavailable } from './errors.js'
import type { FeeState } from './fees.js'

/**
 * On-chain half of the connector. The provider's hot wallet deposits converted fiat into custodial vaults, and
 * attests `FundingRecorded` and `Settlement` for both custody modes. Chain state — not the database — decides what
 * still has to be done, so a run interrupted between two steps resumes without double-spending.
 */

export interface Chain {
  client: PublicClient
  wallet: WalletClient
  account: Account
  deployment: Deployment
  /** Tail of the write queue: every pipeline that sends transactions runs behind the previous one. */
  queue: { tail: Promise<unknown> }
}

export const createChain = (config: BankConfig): Chain => {
  const deployment = getDeployment(config.network)
  const chain = chainFor(config.network)
  const account = privateKeyToAccount(config.partnerPrivateKey)
  // Anvil has no declared block time, so viem would poll receipts every 4 s; a local chain mines in about 1 s.
  const pollingInterval = config.network === 'anvil' ? 250 : undefined
  return {
    client: createPublicClient({ chain, transport: http(config.rpcUrl), pollingInterval }) as PublicClient,
    wallet: createWalletClient({ account, chain, transport: http(config.rpcUrl), pollingInterval }),
    account,
    deployment,
    queue: { tail: Promise.resolve() },
  }
}

/**
 * Runs `task` after every task queued before it. One hot wallet sends every transaction, and two requests that
 * each fetch the pending nonce at the same moment would collide, so writes are strictly sequential per process.
 */
export const exclusive = <T>(chain: Chain, task: () => Promise<T>): Promise<T> => {
  const run = chain.queue.tail.then(task, task)
  chain.queue.tail = run.catch(() => undefined)
  return run
}

export const isBankPartner = async (chain: Chain, account: Address): Promise<boolean> =>
  hasRole(
    { client: chain.client, roleRegistry: chain.deployment.contracts.RoleRegistry },
    ROLES.BANK_PARTNER,
    account,
  )

export interface NeedTarget {
  needId: bigint
  ngo: Address
  /** AidVault (OnChain) or NonCustodialLedger (OffChain); the zero address until the need is verified. */
  vault: Address
  status: number
  custodyMode: CustodyMode
  custodian: Address
  targetAmount: bigint
  thirdPartyCostBps: number
  /** `fundingTermsOf(needId).open`: Funding and no deadline has passed. */
  open: boolean
}

/** Returns null for a need that does not exist, so an unknown id is a 404 rather than a reverted call. */
export const readNeed = async (chain: Chain, needId: bigint): Promise<NeedTarget | null> => {
  const registry = chain.deployment.contracts.NeedsRegistry
  const needCount = await chain.client.readContract({
    address: registry,
    abi: needsRegistryAbi,
    functionName: 'needCount',
  })
  if (needId === 0n || needId > needCount) return null

  const [need, terms] = await Promise.all([
    chain.client.readContract({
      address: registry,
      abi: needsRegistryAbi,
      functionName: 'getNeed',
      args: [needId],
    }),
    chain.client.readContract({
      address: registry,
      abi: needsRegistryAbi,
      functionName: 'fundingTermsOf',
      args: [needId],
    }),
  ])
  return {
    needId,
    ngo: need.ngo,
    vault: need.vault,
    status: need.status,
    custodyMode: CUSTODY_MODE[need.custodyMode] ?? 'OnChain',
    custodian: need.custodian,
    targetAmount: need.targetAmount,
    thirdPartyCostBps: need.thirdPartyCostBps,
    open: terms[3],
  }
}

export const hasLedger = (need: NeedTarget): boolean => need.vault !== zeroAddress

/** What the cumulative fee cap is computed from: the ledger's net total and both fee totals on the resolver. */
export const readFeeState = async (chain: Chain, need: NeedTarget): Promise<FeeState> => {
  const resolver = chain.deployment.contracts.ProofOfAidResolver
  const [totalDonated, fundingFees, settlementFees] = await Promise.all([
    chain.client.readContract({
      address: need.vault,
      abi: nonCustodialLedgerAbi,
      functionName: 'totalDonated',
    }),
    chain.client.readContract({
      address: resolver,
      abi: proofOfAidResolverAbi,
      functionName: 'fundingFeesOf',
      args: [need.needId],
    }),
    chain.client.readContract({
      address: resolver,
      abi: proofOfAidResolverAbi,
      functionName: 'settlementFeesOf',
      args: [need.needId],
    }),
  ])
  return { totalDonated, fundingFees, settlementFees }
}

/** True once this provider has used the payment reference in any ledger (deposit or off-chain funding record). */
export const paymentRefConsumed = async (chain: Chain, paymentRefHash: Hex): Promise<boolean> =>
  chain.client.readContract({
    address: chain.deployment.contracts.AidVaultFactory,
    abi: aidVaultFactoryAbi,
    functionName: 'isPaymentRefConsumed',
    args: [chain.account.address, paymentRefHash],
  })

/** True if this provider deposited exactly `amount` under the references in the custodial vault. */
export const depositMatches = async (
  chain: Chain,
  vault: Address,
  paymentRefHash: Hex,
  donorRefHash: Hex,
  amount: bigint,
): Promise<boolean> =>
  chain.client.readContract({
    address: vault,
    abi: aidVaultAbi,
    functionName: 'fiatDepositMatches',
    args: [paymentRefHash, chain.account.address, donorRefHash, amount],
  })

/** UID of this provider's `FundingRecorded` attestation for a payment reference, or null if not made yet. */
export const fundingAttestationFor = async (chain: Chain, paymentRefHash: Hex): Promise<Hex | null> => {
  const uid = await chain.client.readContract({
    address: chain.deployment.contracts.ProofOfAidResolver,
    abi: proofOfAidResolverAbi,
    functionName: 'fundingAttestationOf',
    args: [chain.account.address, paymentRefHash],
  })
  return uid === zeroHash ? null : uid
}

/** UID of the `Settlement` attestation for a tranche, or null if the payout has not been reported. */
export const settlementAttestationFor = async (
  chain: Chain,
  needId: bigint,
  trancheIndex: number,
): Promise<Hex | null> => {
  const uid = await chain.client.readContract({
    address: chain.deployment.contracts.ProofOfAidResolver,
    abi: proofOfAidResolverAbi,
    functionName: 'settlementOf',
    args: [needId, BigInt(trancheIndex)],
  })
  return uid === zeroHash ? null : uid
}

export interface TrancheState {
  index: number
  amount: bigint
  status: TrancheStatus
}

export const readTranches = async (chain: Chain, ledger: Address): Promise<TrancheState[]> => {
  const tranches = await chain.client.readContract({
    address: ledger,
    abi: nonCustodialLedgerAbi,
    functionName: 'getTranches',
  })
  return tranches.map((tranche, index) => ({
    index,
    amount: tranche.amount,
    status: TRANCHE_STATUS[tranche.status] ?? 'Locked',
  }))
}

const readAttestationData = async (chain: Chain, uid: Hex): Promise<Hex> => {
  const attestation = await chain.client.readContract({
    address: chain.deployment.external.EAS,
    abi: easAbi,
    functionName: 'getAttestation',
    args: [uid],
  })
  return attestation.data
}

export const readFundingAttestation = async (chain: Chain, uid: Hex): Promise<FundingRecordedData> =>
  decodeSchemaData<FundingRecordedData>('FundingRecorded', await readAttestationData(chain, uid))

export const readSettlementAttestation = async (chain: Chain, uid: Hex): Promise<SettlementData> =>
  decodeSchemaData<SettlementData>('Settlement', await readAttestationData(chain, uid))

export const tokenBalance = async (chain: Chain, owner: Address): Promise<bigint> =>
  chain.client.readContract({
    address: chain.deployment.external.Token,
    abi: mockEURCAbi,
    functionName: 'balanceOf',
    args: [owner],
  })

export const tokenAllowance = async (chain: Chain, owner: Address, spender: Address): Promise<bigint> =>
  chain.client.readContract({
    address: chain.deployment.external.Token,
    abi: mockEURCAbi,
    functionName: 'allowance',
    args: [owner, spender],
  })

/** Waits for a write to be mined, so each step of the pipeline is durable before the next one starts. */
export const confirm = async (chain: Chain, hash: Hex): Promise<Hex> => {
  const receipt = await chain.client.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`transaction reverted: ${hash}`)
  return hash
}

/**
 * Custom errors a write can surface. EAS bubbles up whatever the resolver (and the ledger behind it) reverted
 * with, so decoding needs their error definitions next to the function being called.
 */
const REVERT_ERRORS = [
  ...proofOfAidResolverAbi,
  ...nonCustodialLedgerAbi,
  ...aidVaultAbi,
  ...aidVaultFactoryAbi,
].filter((item) => item.type === 'error')

// The error entries only widen what viem can decode; the callable surface is still exactly EAS's / the vault's.
const EAS_WRITE_ABI = [...easAbi, ...REVERT_ERRORS] as unknown as typeof easAbi
export const VAULT_WRITE_ABI = [...aidVaultAbi, ...REVERT_ERRORS] as unknown as typeof aidVaultAbi

/** Sends a non-revocable, non-expiring attestation addressed to a need's ledger and waits for it to be mined. */
export const attestToLedger = async (
  chain: Chain,
  schema: Extract<SchemaName, 'FundingRecorded' | 'Settlement'>,
  ledger: Address,
  values: readonly unknown[],
): Promise<Hex> =>
  confirm(
    chain,
    await chain.wallet.writeContract({
      account: chain.account,
      chain: null,
      address: chain.deployment.external.EAS,
      abi: EAS_WRITE_ABI,
      functionName: 'attest',
      args: [
        {
          schema: chain.deployment.schemas[schema],
          data: {
            // Never a person: the attestation is addressed to the ledger that holds or mirrors the money (spec §6).
            recipient: ledger,
            expirationTime: 0n,
            revocable: false,
            refUID: zeroHash,
            data: encodeSchemaData(schema, values),
            value: 0n,
          },
        },
      ],
    }),
  )

/**
 * Contract reverts a caller can act on, as HTTP errors. Checks before each write catch these cases already; this
 * covers the race where the chain moved between the check and the transaction.
 */
const REVERT_HTTP_ERRORS: Record<string, () => HttpError> = {
  FundingNotOpen: () => conflict('The need is no longer open for funding', 'NEED_NOT_FUNDING'),
  ExceedsTarget: () => conflict('The amount exceeds what the need still has to raise', 'EXCEEDS_REMAINING'),
  FeeExceedsDisclosure: () =>
    conflict('The fee would exceed the need’s disclosed third-party cost cap', 'FEE_EXCEEDS_DISCLOSURE'),
  NgoInactive: () => conflict('The need’s NGO is suspended and cannot receive funds', 'NGO_INACTIVE'),
  FundingAlreadyAttested: () => conflict('This payment was already attested', 'PAYMENT_REF_CONSUMED'),
  PaymentRefAlreadyUsed: () => conflict('This payment reference was already used', 'PAYMENT_REF_CONSUMED'),
  SettlementAlreadyRecorded: () => conflict('This tranche payout was already reported', 'SETTLEMENT_EXISTS'),
  InvalidTrancheStatus: () => conflict('The tranche is not releasable', 'TRANCHE_NOT_RELEASABLE'),
  InvalidNeedStatus: () =>
    conflict('The need is not in a state that allows this operation', 'INVALID_NEED_STATUS'),
  AmountMismatch: () => conflict('The amounts do not match the on-chain record', 'AMOUNT_MISMATCH'),
  FundingMismatch: () => conflict('The attestation does not match the deposit', 'FUNDING_MISMATCH'),
  Unauthorized: () => forbidden('The provider is not authorised for this operation on-chain'),
  SystemPaused: () => unavailable('The system is paused', 'SYSTEM_PAUSED'),
}

export const httpErrorFromRevert = (error: unknown): unknown => {
  if (error instanceof HttpError) return error
  const name = revertName(error)
  const make = name ? REVERT_HTTP_ERRORS[name] : undefined
  return make ? make() : error
}

/** Name of the custom error a contract call reverted with, when viem could decode one. */
export const revertName = (error: unknown): string | null => {
  if (!(error instanceof BaseError)) return null
  const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError)
  if (!(reverted instanceof ContractFunctionRevertedError)) return null
  return reverted.data?.errorName ?? null
}

export { aidVaultAbi, easAbi, mockEURCAbi }
