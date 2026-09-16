import {
  aidVaultAbi,
  chainFor,
  type Deployment,
  easAbi,
  fiatDonationResolverAbi,
  getDeployment,
  hasRole,
  mockEURCAbi,
  needsRegistryAbi,
  ROLES,
} from '@poa/shared'
import {
  type Account,
  type Address,
  createPublicClient,
  createWalletClient,
  type Hex,
  http,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { BankConfig } from './config.js'

/**
 * On-chain half of the connector: the partner's hot wallet deposits converted fiat into a need's vault and then
 * attests the payment. Chain state — not the database — decides what still has to be done, so a run interrupted
 * between the deposit and the attestation resumes without double-spending.
 */

export interface Chain {
  client: PublicClient
  wallet: WalletClient
  account: Account
  deployment: Deployment
}

export const createChain = (config: BankConfig): Chain => {
  const deployment = getDeployment(config.network)
  const chain = chainFor(config.network)
  const account = privateKeyToAccount(config.partnerPrivateKey)
  return {
    client: createPublicClient({ chain, transport: http(config.rpcUrl) }) as PublicClient,
    wallet: createWalletClient({ account, chain, transport: http(config.rpcUrl) }),
    account,
    deployment,
  }
}

export const isBankPartner = async (chain: Chain, account: Address): Promise<boolean> =>
  hasRole(
    { client: chain.client, roleRegistry: chain.deployment.contracts.RoleRegistry },
    ROLES.BANK_PARTNER,
    account,
  )

export interface NeedTarget {
  vault: Address
  /** Mirrors INeedsRegistry.NeedStatus; 2 = Funding. */
  status: number
}

/** Returns null for a need that does not exist, so an unknown id is a 404 rather than a reverted call. */
export const readNeed = async (chain: Chain, needId: bigint): Promise<NeedTarget | null> => {
  const needCount = await chain.client.readContract({
    address: chain.deployment.contracts.NeedsRegistry,
    abi: needsRegistryAbi,
    functionName: 'needCount',
  })
  if (needId === 0n || needId > needCount) return null

  const [vault, status] = await Promise.all([
    chain.client.readContract({
      address: chain.deployment.contracts.NeedsRegistry,
      abi: needsRegistryAbi,
      functionName: 'vaultOf',
      args: [needId],
    }),
    chain.client.readContract({
      address: chain.deployment.contracts.NeedsRegistry,
      abi: needsRegistryAbi,
      functionName: 'statusOf',
      args: [needId],
    }),
  ])
  return { vault, status }
}

export const paymentRefUsed = async (chain: Chain, vault: Address, paymentRefHash: Hex): Promise<boolean> =>
  chain.client.readContract({
    address: vault,
    abi: aidVaultAbi,
    functionName: 'paymentRefUsed',
    args: [paymentRefHash],
  })

/** UID of the `FiatDonation` attestation for a payment reference, or the zero hash if it has not been made. */
export const attestationForPayment = async (chain: Chain, paymentRefHash: Hex): Promise<Hex> =>
  chain.client.readContract({
    address: chain.deployment.contracts.FiatDonationResolver,
    abi: fiatDonationResolverAbi,
    functionName: 'attestationOf',
    args: [paymentRefHash],
  })

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

export { aidVaultAbi, easAbi, mockEURCAbi }
