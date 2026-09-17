'use client'

import { useMemo } from 'react'
import { type Connector, useAccount, useConnect, useSwitchChain } from 'wagmi'
import { chain } from './config'
import { useMounted } from './mounted'

/**
 * Which wallets this browser can actually offer.
 *
 * wagmi discovers installed wallets through EIP-6963, so MetaMask, Rabby, Brave and the rest arrive as their own
 * connectors with their real name and icon. The configured `injected` connector is the fallback for wallets that
 * do not announce themselves (and for anvil), so it is only offered when nothing was discovered — otherwise the
 * same extension would appear twice, once as "MetaMask" and once as "Injected".
 *
 * Coinbase Smart Wallet is kept first and marked `passkey`: it needs no extension, which is the only option a
 * donor without a wallet has, and the only one that can sponsor gas and bundle approve + donate into one signature.
 */

export interface WalletChoice {
  connector: Connector
  /** Created with a passkey in the browser: nothing to install. */
  passkey: boolean
  icon: string | undefined
}

const COINBASE_ID = 'coinbaseWalletSDK'

export const useWalletChoices = (): WalletChoice[] => {
  const { connectors } = useConnect()
  const mounted = useMounted()

  return useMemo(() => {
    if (!mounted) return []
    const discovered = connectors.filter(
      (connector) => connector.type === 'injected' && connector.id !== 'injected',
    )
    // The generic connector is only worth offering when something injected a provider without announcing itself.
    const legacyInjected = discovered.length === 0 && Boolean((window as { ethereum?: unknown }).ethereum)
    const choices = connectors.filter((connector) => {
      if (connector.id === 'injected') return legacyInjected
      return true
    })
    return choices
      .map((connector) => ({
        connector,
        passkey: connector.id === COINBASE_ID,
        icon: connector.icon,
      }))
      .sort((a, b) => Number(b.passkey) - Number(a.passkey))
  }, [connectors, mounted])
}

/** True when no browser wallet was found, so the passkey wallet is the only way to connect. */
export const useNoInstalledWallet = (): boolean => {
  const choices = useWalletChoices()
  const mounted = useMounted()
  return mounted && choices.every((choice) => choice.passkey)
}

/**
 * Moves the connected wallet to this deployment's chain. Wallets that do not know the chain yet are asked to add
 * it (wagmi sends `wallet_addEthereumChain` after a 4902), which is what MetaMask needs for Base Sepolia.
 */
export const useSwitchToAppChain = () => {
  const { switchChain, isPending } = useSwitchChain()
  const { isConnected } = useAccount()
  return {
    isPending,
    canSwitch: isConnected,
    switch: () => switchChain({ chainId: chain.id }),
  }
}
