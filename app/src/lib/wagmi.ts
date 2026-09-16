import { createConfig, http } from 'wagmi'
import { coinbaseWallet, injected } from 'wagmi/connectors'
import { chain, rpcUrl } from './config'

/**
 * Wallet setup for the whole dashboard. Coinbase Smart Wallet (passkeys) is the default connector so a donor
 * or beneficiary can act without installing anything; an injected wallet is the fallback for role accounts
 * that already exist (NGO, verifier, field agent) and for anvil.
 *
 * OnchainKit is deliberately not used — it requires React 19, which Next 14 cannot run (docs/DECISIONS.md §2).
 */
export const wagmiConfig = createConfig({
  // A single chain: every write in this app targets the deployment the build is configured for.
  chains: [chain],
  connectors: [
    coinbaseWallet({ appName: 'Proof of Aid', preference: 'smartWalletOnly' }),
    injected({ shimDisconnect: true }),
  ],
  transports: { [chain.id]: http(rpcUrl) },
  ssr: true,
})

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig
  }
}
