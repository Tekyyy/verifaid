import {
  CUSTODY_MODE,
  type CustodyMode,
  categoryHash,
  chainFor,
  type Deployment,
  easAbi,
  encodeSchemaData,
  getDeployment,
  mockEURCAbi,
  needsRegistryAbi,
  nonCustodialLedgerAbi,
  proofOfAidResolverAbi,
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
  zeroAddress,
  zeroHash,
} from 'viem'
import { type HDAccount, mnemonicToAccount } from 'viem/accounts'
import { RPC_URL } from './env.js'

/**
 * These suites run against the local anvil deployment, which pnpm deploy:local always seeds with anvil's
 * well-known mnemonic. A custom DEMO_MNEMONIC belongs to a public-testnet deployment and is deliberately
 * ignored here: deriving different role addresses would just produce `Unauthorized` against this chain.
 */
export const DEMO_MNEMONIC = 'test test test test test test test test test test test junk'

const ROLE_INDEX = {
  admin: 0,
  ngo: 1,
  fieldAgent: 3,
  verifier1: 4,
  bankPartner: 6,
  donor1: 7,
  relayer: 9,
  foodSupplier: 10,
} as const
export type RoleName = keyof typeof ROLE_INDEX

export const roleAccount = (role: RoleName): HDAccount =>
  mnemonicToAccount(DEMO_MNEMONIC, { addressIndex: ROLE_INDEX[role] })

/** Private key of a role wallet, for building a second service instance that signs as someone else. */
export const rolePrivateKey = (role: RoleName): `0x${string}` => {
  const key = roleAccount(role).getHdKey().privateKey
  if (!key) throw new Error(`no private key for ${role}`)
  return `0x${Buffer.from(key).toString('hex')}`
}

export interface Harness {
  deployment: Deployment
  publicClient: PublicClient
  wallet(role: RoleName): WalletClient
}

export const createHarness = (): Harness => {
  const chain = chainFor('anvil')
  return {
    deployment: getDeployment('anvil'),
    publicClient: createPublicClient({
      chain,
      transport: http(RPC_URL),
      pollingInterval: 250,
    }) as PublicClient,
    wallet: (role) =>
      createWalletClient({
        account: roleAccount(role),
        chain,
        transport: http(RPC_URL),
        pollingInterval: 250,
      }),
  }
}

export const send = async (
  harness: Harness,
  role: RoleName,
  request: Parameters<WalletClient['writeContract']>[0],
): Promise<TransactionReceipt> => {
  const hash = await harness.wallet(role).writeContract(request)
  const receipt = await harness.publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`transaction reverted: ${hash}`)
  return receipt
}

export interface NeedOptions {
  /** Base units (6 decimals). Default 100 EUR. */
  targetAmount?: bigint
  custodyMode?: CustodyMode
  /** Disclosed intermediary cost cap; a non-zero value gets a cost disclosure hash, as the registry requires. */
  thirdPartyCostBps?: number
  trancheBps?: number[]
  /** Leave the need Pending (no NeedVerified attestation, so no ledger and no funding). */
  verify?: boolean
}

export interface FundingNeed {
  needId: bigint
  /** AidVault (OnChain) or NonCustodialLedger (OffChain); zero address when left unverified. */
  vault: Address
  custodyMode: CustodyMode
}

/**
 * Creates a brand new need with the full v2 terms and has an independent verifier approve it, which deploys its
 * ledger and opens funding. Each test gets a need of its own, because other suites share the chain.
 */
export const createNeedInFunding = async (
  harness: Harness,
  options: NeedOptions = {},
): Promise<FundingNeed> => {
  const { deployment } = harness
  const custodyMode = options.custodyMode ?? 'OnChain'
  const thirdPartyCostBps = options.thirdPartyCostBps ?? 0
  const dossierHash = keccak256(stringToHex(`bank-dossier-${Date.now()}-${Math.random()}`))
  const trancheBps = options.trancheBps ?? [5000, 5000]

  const receipt = await send(harness, 'ngo', {
    address: deployment.contracts.NeedsRegistry,
    abi: needsRegistryAbi,
    functionName: 'createNeed',
    args: [
      {
        programId: 1n,
        category: categoryHash('CASH'),
        targetAmount: options.targetAmount ?? 100_000_000n,
        regionCode: regionCode('ES-CM'),
        dossierHash,
        metadataURI: 'ipfs://bank-connector-test-need',
        verificationsRequired: 1,
        trancheBps,
        custodyMode: CUSTODY_MODE.indexOf(custodyMode),
        // An off-chain need names its custodian up front: the payment provider this service signs as.
        custodian: custodyMode === 'OffChain' ? roleAccount('bankPartner').address : zeroAddress,
        fundingDeadline: 0n,
        executionDeadline: 0n,
        minFundingBps: 1,
        thirdPartyCostBps,
        expectedOutcomeHash: keccak256(stringToHex('outcome')),
        costDisclosureHash: thirdPartyCostBps > 0 ? keccak256(stringToHex('cost-disclosure')) : zeroHash,
        // An on-chain vault pays a registered supplier directly; off-chain money is paid by its custodian.
        payees:
          custodyMode === 'OnChain'
            ? [
                {
                  account: roleAccount('foodSupplier').address,
                  shareBps: trancheBps.map(() => 10_000),
                  refHash: keccak256(stringToHex('supplier-quote')),
                  label: 'Test supplier',
                },
              ]
            : [],
      },
    ],
  } as never)

  // Read the id from our own receipt, never from needCount(): anything else using the same chain (the demo
  // runner, the indexer's fixtures, another suite) can create a need between the write and the read.
  const [created] = parseEventLogs({ abi: needsRegistryAbi, eventName: 'NeedCreated', logs: receipt.logs })
  const needId = created?.args.needId
  if (needId === undefined) throw new Error('NeedCreated event missing from the receipt')
  if (options.verify === false) return { needId, vault: zeroAddress, custodyMode }

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
  if (vault === zeroAddress) throw new Error('ledger was not created')
  return { needId, vault, custodyMode }
}

export const totalDonated = (harness: Harness, ledger: Address): Promise<bigint> =>
  harness.publicClient.readContract({
    address: ledger,
    abi: nonCustodialLedgerAbi,
    functionName: 'totalDonated',
  })

export const tokenBalanceOf = (harness: Harness, owner: Address): Promise<bigint> =>
  harness.publicClient.readContract({
    address: harness.deployment.external.Token,
    abi: mockEURCAbi,
    functionName: 'balanceOf',
    args: [owner],
  })

export const needStatus = (harness: Harness, needId: bigint): Promise<number> =>
  harness.publicClient.readContract({
    address: harness.deployment.contracts.NeedsRegistry,
    abi: needsRegistryAbi,
    functionName: 'statusOf',
    args: [needId],
  })

export const tranchesOf = (harness: Harness, ledger: Address) =>
  harness.publicClient.readContract({
    address: ledger,
    abi: nonCustodialLedgerAbi,
    functionName: 'getTranches',
  })

export const resolverFees = async (
  harness: Harness,
  needId: bigint,
): Promise<{ fundingFees: bigint; settlementFees: bigint }> => {
  const resolver = harness.deployment.contracts.ProofOfAidResolver
  const [fundingFees, settlementFees] = await Promise.all([
    harness.publicClient.readContract({
      address: resolver,
      abi: proofOfAidResolverAbi,
      functionName: 'fundingFeesOf',
      args: [needId],
    }),
    harness.publicClient.readContract({
      address: resolver,
      abi: proofOfAidResolverAbi,
      functionName: 'settlementFeesOf',
      args: [needId],
    }),
  ])
  return { fundingFees, settlementFees }
}

export const readAttestation = (harness: Harness, uid: `0x${string}`) =>
  harness.publicClient.readContract({
    address: harness.deployment.external.EAS,
    abi: easAbi,
    functionName: 'getAttestation',
    args: [uid],
  })
