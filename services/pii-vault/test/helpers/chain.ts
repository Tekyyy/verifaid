import { chainFor, type Deployment, getDeployment, roleRegistryAbi } from '@poa/shared'
import { createPublicClient, createWalletClient, http, keccak256, type PublicClient, stringToHex } from 'viem'
import { type HDAccount, mnemonicToAccount } from 'viem/accounts'
import { RPC_URL } from './env.js'

/**
 * Demo role wallets. Anvil's default mnemonic is public by design and these keys exist only on a local chain.
 * Indices 0–12 are the seeded roles (10–12 the suppliers, see demo/src/config.ts); 13/14 are a second NGO used to
 * prove one NGO cannot read another's records. A supplier can never become an NGO, so they must not overlap.
 */
/**
 * These suites run against the local anvil deployment, which pnpm deploy:local always seeds with anvil's
 * well-known mnemonic. A custom DEMO_MNEMONIC belongs to a public-testnet deployment and is deliberately
 * ignored here: deriving different role addresses would just produce `Unauthorized` against this chain.
 */
export const DEMO_MNEMONIC = 'test test test test test test test test test test test junk'

export const ROLE_INDEX = {
  admin: 0,
  ngo: 1,
  ngoPayout: 2,
  // 3 was the field agent and 6 the bank partner, both retired; the indices stay reserved.
  verifier1: 4,
  verifier2: 5,
  donor1: 7,
  donor2: 8,
  ngoB: 13,
  ngoBPayout: 14,
} as const

export type RoleName = keyof typeof ROLE_INDEX

export const roleAccount = (role: RoleName): HDAccount =>
  mnemonicToAccount(DEMO_MNEMONIC, { addressIndex: ROLE_INDEX[role] })

export interface Harness {
  deployment: Deployment
  publicClient: PublicClient
}

export const createHarness = (): Harness => ({
  deployment: getDeployment('anvil'),
  publicClient: createPublicClient({ chain: chainFor('anvil'), transport: http(RPC_URL) }) as PublicClient,
})

/**
 * Registers a second NGO if the chain does not have one yet. Idempotent, because the suite runs repeatedly
 * against a long-lived local chain. `ngoB` never sends a transaction, so it needs no ETH.
 */
export const ensureSecondNgo = async (harness: Harness): Promise<HDAccount> => {
  const ngoB = roleAccount('ngoB')
  const active = await harness.publicClient.readContract({
    address: harness.deployment.contracts.RoleRegistry,
    abi: roleRegistryAbi,
    functionName: 'isActiveNgo',
    args: [ngoB.address],
  })
  if (active) return ngoB

  const admin = createWalletClient({
    account: roleAccount('admin'),
    chain: chainFor('anvil'),
    transport: http(RPC_URL),
  })
  const hash = await admin.writeContract({
    address: harness.deployment.contracts.RoleRegistry,
    abi: roleRegistryAbi,
    functionName: 'registerNgo',
    args: [
      ngoB.address,
      roleAccount('ngoBPayout').address,
      keccak256(stringToHex('ngo-b-credential')),
      'ipfs://ngo-b-profile',
    ],
  })
  const receipt = await harness.publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error('registerNgo reverted')
  return ngoB
}

export const programOwnedBy = async (harness: Harness, programId: bigint): Promise<string> =>
  harness.publicClient.readContract({
    address: harness.deployment.contracts.ProgramRegistry,
    abi: [
      {
        type: 'function',
        name: 'programNgo',
        stateMutability: 'view',
        inputs: [{ type: 'uint256' }],
        outputs: [{ type: 'address' }],
      },
    ] as const,
    functionName: 'programNgo',
    args: [programId],
  })
