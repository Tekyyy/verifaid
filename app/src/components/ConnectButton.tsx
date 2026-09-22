'use client'

import { useTranslations } from 'next-intl'
import { useAccount, useConnect, useDisconnect } from 'wagmi'
import { chain } from '@/lib/config'
import { shorten } from '@/lib/format'
import { useMounted, useWrongChain } from '@/lib/hooks'
import { useNoInstalledWallet, useSwitchToAppChain, useWalletChoices } from '@/lib/wallets'

export function ConnectButton() {
  const t = useTranslations('common')
  const tErrors = useTranslations('errors')
  const mounted = useMounted()
  const { address, isConnected, connector } = useAccount()
  const { connect, isPending } = useConnect()
  const { disconnect } = useDisconnect()
  const network = useSwitchToAppChain()
  const wrongChain = useWrongChain()
  const wallets = useWalletChoices()
  const noWallet = useNoInstalledWallet()

  if (!mounted) {
    return (
      <span className="text-sm text-slate-500" aria-hidden="true">
        {t('loading')}
      </span>
    )
  }

  if (isConnected && address) {
    return (
      <div className="flex items-center gap-2">
        {wrongChain ? (
          <button
            type="button"
            className="btn-danger text-xs"
            disabled={network.isPending}
            onClick={network.switch}
          >
            {network.isPending ? t('connecting') : tErrors('switchNetwork', { chain: chain.name })}
          </button>
        ) : null}
        <span className="font-mono text-xs text-slate-700" title={`${connector?.name ?? ''} ${address}`}>
          {shorten(address, 6, 4)}
        </span>
        <button
          type="button"
          className="btn-secondary text-sm min-h-0 py-1.5 text-slate-500 border-0 shadow-sm"
          onClick={() => disconnect()}
        >
          {t('disconnect')}
        </button>
      </div>
    )
  }

  // Some browsers show the same wallet multiple times: we display each name only once.
  const seen = new Set<string>()
  const uniqueWallets = wallets.filter(({ connector }) => {
    if (seen.has(connector.name)) return false
    seen.add(connector.name)
    return true
  })

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {uniqueWallets.map(({ connector: option, passkey, icon }) => (
        <button
          key={option.uid}
          type="button"
          className="btn-secondary inline-flex min-h-0 items-center gap-1.5 py-1.5 text-xs border-0 shadow-sm"
          disabled={isPending}
          onClick={() => connect({ connector: option })}
        >
          {/* biome-ignore lint/performance/noImgElement: 16px icon, data URI EIP-6963 */}
          {icon ? <img src={icon} alt="" aria-hidden="true" className="h-4 w-4 rounded" /> : null}
          {isPending ? t('connecting') : `${t('connect')}: ${passkey ? t('passkeyWallet') : option.name}`}
        </button>
      ))}
      {noWallet ? <span className="text-xs text-slate-600">{t('noWalletHint')}</span> : null}
    </div>
  )
}
