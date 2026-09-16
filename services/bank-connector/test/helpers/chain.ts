import {
  categoryHash,
  chainFor,
  type Deployment,
  easAbi,
  encodeSchemaData,
  getDeployment,
  needsRegistryAbi,
  regionCode,
} from '@poa/shared'
import {
  type Address,
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  type PublicClient,
  parseEventLogs,
  stringToHex,
  type TransactionReceipt,
  type WalletClient,
  zeroHash,
} from 'viem'
import { type HDAccount, mnemonicToAccount } from 'viem/accounts'
import { RPC_URL } from './env.js'

/**
 * Puts a brand new need into `Funding` so each run has a vault of its own; payment references are globally
 * unique on-chain, so a suite that reused one need would fail on its second run.
 */

/**
 * These suites run against the local anvil deployment, which pnpm deploy:local always seeds with anvil's
 * well-known mnemonic. A custom DEMO_MNEMONIC belongs to a public-testnet deployment and is deliberately
 * ignored here: deriving different role addresses would just produce `Unauthorized` against this chain.
 */
export const DEMO_MNEMONIC = 'test test test test test test test test test test test junk'

const ROLE_INDEX = { admin: 0, ngo: 1, fieldAgent: 3, verifier1: 4, bankPartner: 6, donor1: 7 } as const
export type RoleName = keyof typeof ROLE_INDEX

export const roleAccount = (role: RoleName): HDAccount =>
  mnemonicToAccount(DEMO_MNEMONIC, { addressIndex: ROLE_INDEX[role] })

export interface Harness {
  deployment: Deployment
  publicClient: PublicClient
  wallet(role: RoleName): WalletClient
}

export const createHarness = (): Harness => {
  const chain = chainFor('anvil')
  return {
    deployment: getDeployment('anvil'),
    publicClient: createPublicClient({ chain, transport: http(RPC_URL) }) as PublicClient,
    wallet: (role) => createWalletClient({ account: roleAccount(role), chain, transport: http(RPC_URL) }),
  }
}

const send = async (
  harness: Harness,
  role: RoleName,
  request: Parameters<WalletClient['writeContract']>[0],
): Promise<TransactionReceipt> => {
  const hash = await harness.wallet(role).writeContract(request)
  const receipt = await harness.publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`transaction reverted: ${hash}`)
  return receipt
}

export interface FundingNeed {
  needId: bigint
  vault: Address
}

/** Creates a need and has an independent verifier approve it, which deploys the vault and opens funding. */
export const createNeedInFunding = async (
  harness: Harness,
  targetAmount = 100_000_000n,
): Promise<FundingNeed> => {
  const { deployment } = harness
  const dossierHash = keccak256(stringToHex(`bank-dossier-${Date.now()}-${Math.random()}`))

  const receipt = await send(harness, 'ngo', {
    address: deployment.contracts.NeedsRegistry,
    abi: needsRegistryAbi,
    functionName: 'createNeed',
    args: [
      {
        programId: 1n,
        category: categoryHash('CASH'),
        targetAmount,
        regionCode: regionCode('ES-CM'),
        dossierHash,
        metadataURI: 'ipfs://bank-connector-test-need',
        verificationsRequired: 1,
        trancheBps: [5000, 5000],
      },
    ],
  } as never)

  // Read the id from our own receipt, never from needCount(): anything else using the same chain (the demo
  // runner, the indexer's fixtures, another suite) can create a need between the write and the read.
  const [created] = parseEventLogs({ abi: needsRegistryAbi, eventName: 'NeedCreated', logs: receipt.logs })
  const needId = created?.args.needId
  if (needId === undefined) throw new Error('NeedCreated event missing from the receipt')

  await send(harness, 'verifier1', {
    address: deployment.external.EAS,
    abi: easAbi,
    functionName: 'attest',
    args: [
      {
        schema: deployment.schemas.NeedVerified,
        data: {
          recipient: deployment.contracts.NeedsRegistry,
          expirationTime: 0n,
          revocable: true,
          refUID: zeroHash,
          data: encodeSchemaData('NeedVerified', [needId, dossierHash, true, zeroHash]),
          value: 0n,
        },
      },
    ],
  } as never)

  const vault = await harness.publicClient.readContract({
    address: deployment.contracts.NeedsRegistry,
    abi: needsRegistryAbi,
    functionName: 'vaultOf',
    args: [needId],
  })
  if (vault === '0x0000000000000000000000000000000000000000') throw new Error('vault was not created')
  return { needId, vault }
}
