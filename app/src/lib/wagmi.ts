import { createConfig, http } from 'wagmi'
import { coinbaseWallet, injected } from 'wagmi/connectors'
import { chain, rpcUrl } from './config'

/**
 * Wallet setup for the whole dashboard.
 *
 * Installed wallets announce themselves through EIP-6963, so MetaMask, Rabby, Brave and the rest appear as their
 * own connectors, with their own name and icon, without this app naming any of them (and without pulling in a
 * wallet SDK per brand). Coinbase Smart Wallet is added explicitly because a passkey wallet cannot announce
 * itself: it is the one option for a donor or beneficiary with nothing installed, and the only one that can
 * sponsor gas and bundle approve + donate into a single signature. The generic `injected` connector stays as the
 * fallback for wallets that do not implement EIP-6963 and for anvil; `useWalletChoices` hides it when a wallet
 * was discovered, so the same extension is never offered twice.
 *
 * OnchainKit is deliberately not used — it requires React 19, which Next 14 cannot run (docs/DECISIONS.md §2).
 */
export const wagmiConfig = createConfig({
  // A single chain: every write in this app targets the deployment the build is configured for.
  chains: [chain],
  multiInjectedProviderDiscovery: true,
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
