import { type HDAccount, mnemonicToAccount } from 'viem/accounts'

/**
 * The demo role wallets. Anvil's default mnemonic is public by design; these keys exist only on a local chain.
 * Index order matches `SeedDemo.s.sol`.
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
  fieldAgent: 3,
  verifier1: 4,
  verifier2: 5,
  bankPartner: 6,
  donor1: 7,
  donor2: 8,
} as const

export type RoleName = keyof typeof ROLE_INDEX

export const roleAccount = (role: RoleName): HDAccount =>
  mnemonicToAccount(DEMO_MNEMONIC, { addressIndex: ROLE_INDEX[role] })
