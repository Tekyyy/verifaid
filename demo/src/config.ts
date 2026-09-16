import { resolve } from 'node:path'
import { chainFor, type Deployment, getDeployment, type NetworkName } from '@poa/shared'
import { config as loadEnv } from 'dotenv'
import {
  type Account,
  type Chain,
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts'

loadEnv({ path: resolve(process.cwd(), '../.env'), quiet: true })
loadEnv({ quiet: true })

/** anvil's well-known development mnemonic; also the default for the demo role wallets. */
const DEFAULT_MNEMONIC = 'test test test test test test test test test test test junk'

/** Which mnemonic index plays which part. Keep in sync with SeedDemo.s.sol. */
export const ROLE_INDEX = {
  admin: 0,
  ngo: 1,
  ngoPayout: 2,
  fieldAgent: 3,
  verifier1: 4,
  verifier2: 5,
  bankPartner: 6,
  donor1: 7,
  donor2: 8,
  relayer: 9,
} as const

export type RoleName = keyof typeof ROLE_INDEX

export interface DemoContext {
  network: NetworkName
  chain: Chain
  rpcUrl: string
  deployment: Deployment
  publicClient: PublicClient
  accounts: Record<RoleName, Account>
  wallets: Record<RoleName, WalletClient>
  /** Where the dashboard is served, for the links printed at the end. */
  dashboardUrl: string
  indexerUrl: string
  evidenceServiceUrl: string | null
  identitySeed: string
  isLocal: boolean
  /** Dossier hash per need created in this run; the verifier has to attest the exact same value. */
  dossierHashByNeed: Map<bigint, `0x${string}`>
}

const parseNetwork = (value: string | undefined): NetworkName => {
  const network = value ?? (process.env.CHAIN_ID === '31337' ? 'anvil' : 'base-sepolia')
  if (network !== 'anvil' && network !== 'base-sepolia' && network !== 'base') {
    throw new Error(`Unsupported network "${network}"`)
  }
  return network
}

export const createContext = (networkArg?: string): DemoContext => {
  const network = parseNetwork(networkArg ?? process.env.DEMO_NETWORK)
  const deployment = getDeployment(network)
  const chain = chainFor(network)
  const isLocal = network === 'anvil'
  const rpcUrl =
    (isLocal ? process.env.ANVIL_RPC_URL : process.env.BASE_SEPOLIA_RPC_URL) ??
    chain.rpcUrls.default.http[0] ??
    'http://127.0.0.1:8545'

  // Locally the seed always uses anvil's public wallets (deploy-local forces it), even when .env carries the
  // mnemonic and deployer key of a public testnet deployment.
  const mnemonic = (!isLocal && process.env.DEMO_MNEMONIC?.trim()) || DEFAULT_MNEMONIC
  const accounts = {} as Record<RoleName, Account>
  for (const [role, index] of Object.entries(ROLE_INDEX) as [RoleName, number][]) {
    accounts[role] = mnemonicToAccount(mnemonic, { addressIndex: index })
  }
  // On a public testnet the deployer key funds and administers everything, so prefer it when present.
  if (!isLocal && process.env.DEPLOYER_PRIVATE_KEY) {
    accounts.admin = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`)
  }

  const transport = http(rpcUrl)
  const publicClient = createPublicClient({ chain, transport }) as PublicClient
  const wallets = {} as Record<RoleName, WalletClient>
  for (const [role, account] of Object.entries(accounts) as [RoleName, Account][]) {
    wallets[role] = createWalletClient({ account, chain, transport })
  }

  return {
    network,
    chain,
    rpcUrl,
    deployment,
    publicClient,
    accounts,
    wallets,
    dashboardUrl: (process.env.DEMO_DASHBOARD_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
    indexerUrl: (process.env.NEXT_PUBLIC_INDEXER_URL ?? 'http://localhost:42069').replace(/\/$/, ''),
    evidenceServiceUrl: process.env.EVIDENCE_SERVICE_URL?.replace(/\/$/, '') ?? null,
    identitySeed: process.env.DEMO_IDENTITY_SEED ?? 'proof-of-aid-demo',
    isLocal,
    dossierHashByNeed: new Map(),
  }
}
