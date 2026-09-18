import {
  aidVaultAbi,
  categoryHash,
  chainFor,
  type Deployment,
  deliveryManagerAbi,
  easAbi,
  encodeSchemaData,
  getDeployment,
  mockEURCAbi,
  needsRegistryAbi,
  regionCode,
} from '@poa/shared'
import {
  type Address,
  createPublicClient,
  createWalletClient,
  type Hex,
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
import { RPC_URL } from './env.js'
import { type RoleName, roleAccount } from './wallets.js'

/**
 * Drives the on-chain lifecycle a delivery depends on (spec §7, steps 3–7). Every run creates a *new* need, so
 * the suite is repeatable against a chain that already has state from previous runs or from the demo seed.
 */

export const REGION = 'ES-CM'

export interface Harness {
  deployment: Deployment
  publicClient: PublicClient
  wallet(role: RoleName): WalletClient
}

export const createHarness = (): Harness => {
  const deployment = getDeployment('anvil')
  const chain = chainFor('anvil')
  const publicClient = createPublicClient({ chain, transport: http(RPC_URL) }) as PublicClient
  return {
    deployment,
    publicClient,
    wallet: (role) => createWalletClient({ account: roleAccount(role), chain, transport: http(RPC_URL) }),
  }
}

/** Sends a transaction and waits for it, failing loudly rather than leaving the next step to guess. */
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

export interface FundedNeed {
  needId: bigint
  vault: Address
  dossierHash: Hex
}

/** Creates a need, has an independent verifier attest it, funds it and releases tranche 0 (→ `InDelivery`). */
export const createNeedInDelivery = async (
  harness: Harness,
  targetAmount = 1_000_000n,
): Promise<FundedNeed> => {
  const { deployment } = harness
  const dossierHash = keccak256(stringToHex(`dossier-${Date.now()}-${Math.random()}`))

  const createReceipt = await send(harness, 'ngo', {
    address: deployment.contracts.NeedsRegistry,
    abi: needsRegistryAbi,
    functionName: 'createNeed',
    args: [
      {
        programId: 1n,
        category: categoryHash('FOOD'),
        targetAmount,
        regionCode: regionCode(REGION),
        dossierHash,
        metadataURI: 'ipfs://test-need',
        verificationsRequired: 1,
        trancheBps: [3000, 7000],
        // v2 need terms: on-chain custody, open-ended, any amount raised may execute, no intermediary costs.
        custodyMode: 0,
        custodian: zeroAddress,
        fundingDeadline: 0n,
        executionDeadline: 0n,
        minFundingBps: 1,
        thirdPartyCostBps: 0,
        expectedOutcomeHash: keccak256(stringToHex('outcome')),
        costDisclosureHash: zeroHash,
        // The vault pays the registered supplier the local seed created, directly.
        payees: [
          {
            account: roleAccount('foodSupplier').address,
            shareBps: [10_000, 10_000],
            refHash: keccak256(stringToHex('supplier-quote')),
            label: 'Test supplier',
          },
        ],
      },
    ],
  } as never)

  // Read the id from our own receipt, never from needCount(): anything else using the same chain (the demo
  // runner, another suite) can create a need between the write and the read.
  const [created] = parseEventLogs({
    abi: needsRegistryAbi,
    eventName: 'NeedCreated',
    logs: createReceipt.logs,
  })
  const needId = created?.args.needId
  if (needId === undefined) throw new Error('NeedCreated event missing from the receipt')

  // NeedVerified → resolver → registry deploys the vault and opens funding.
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

  const need = await harness.publicClient.readContract({
    address: deployment.contracts.NeedsRegistry,
    abi: needsRegistryAbi,
    functionName: 'getNeed',
    args: [needId],
  })
  const vault = need.vault

  // Donating exactly the target closes funding automatically and makes tranche 0 releasable.
  await send(harness, 'donor1', {
    address: deployment.external.Token,
    abi: mockEURCAbi,
    functionName: 'mint',
    args: [roleAccount('donor1').address, targetAmount],
  } as never)
  await send(harness, 'donor1', {
    address: deployment.external.Token,
    abi: mockEURCAbi,
    functionName: 'approve',
    args: [vault, targetAmount],
  } as never)
  await send(harness, 'donor1', {
    address: vault,
    abi: aidVaultAbi,
    functionName: 'donate',
    args: [targetAmount],
  } as never)
  await send(harness, 'donor1', {
    address: vault,
    abi: aidVaultAbi,
    functionName: 'releaseTranche',
    args: [0n],
  } as never)

  return { needId, vault, dossierHash }
}

/** Opens a delivery for tranche 1 as the field agent and returns its id. */
export const openDelivery = async (
  harness: Harness,
  needId: bigint,
  expectedRecipients = 5,
): Promise<bigint> => {
  const receipt = await send(harness, 'fieldAgent', {
    address: harness.deployment.contracts.DeliveryManager,
    abi: deliveryManagerAbi,
    functionName: 'openDelivery',
    args: [needId, 1n, expectedRecipients],
  } as never)

  const [opened] = parseEventLogs({
    abi: deliveryManagerAbi,
    eventName: 'DeliveryOpened',
    logs: receipt.logs,
  })
  const deliveryId = opened?.args.deliveryId
  if (deliveryId === undefined) throw new Error('DeliveryOpened event missing from the receipt')
  return deliveryId
}

/** Files the `DeliveryEvidence` attestation the evidence service's hash is meant for. */
export const attestDeliveryEvidence = async (
  harness: Harness,
  input: { deliveryId: bigint; evidenceHash: Hex; cid: string; itemsDelivered: number },
): Promise<Hex> => {
  await send(harness, 'fieldAgent', {
    address: harness.deployment.external.EAS,
    abi: easAbi,
    functionName: 'attest',
    args: [
      {
        schema: harness.deployment.schemas.DeliveryEvidence,
        data: {
          recipient: harness.deployment.contracts.DeliveryManager,
          expirationTime: 0n,
          revocable: false,
          refUID: zeroHash,
          data: encodeSchemaData('DeliveryEvidence', [
            input.deliveryId,
            input.evidenceHash,
            input.cid,
            input.itemsDelivered,
            regionCode(REGION),
          ]),
          value: 0n,
        },
      },
    ],
  } as never)

  // The DeliveryManager records the UID the resolver linked, which is the authoritative reference.
  const delivery = await harness.publicClient.readContract({
    address: harness.deployment.contracts.DeliveryManager,
    abi: deliveryManagerAbi,
    functionName: 'getDelivery',
    args: [input.deliveryId],
  })
  return delivery.evidenceAttestationUID
}

export const readAttestation = async (harness: Harness, uid: Hex) =>
  harness.publicClient.readContract({
    address: harness.deployment.external.EAS,
    abi: easAbi,
    functionName: 'getAttestation',
    args: [uid],
  })
