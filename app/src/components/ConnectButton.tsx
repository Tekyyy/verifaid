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
        <button type="button" className="btn-secondary text-xs" onClick={() => disconnect()}>
          {t('disconnect')}
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {wallets.map(({ connector: option, passkey, icon }) => (
        <button
          key={option.uid}
          type="button"
          className={`${passkey ? 'btn-primary' : 'btn-secondary'} inline-flex items-center gap-1.5 text-xs`}
          disabled={isPending}
          onClick={() => connect({ connector: option })}
        >
          {icon ? <img src={icon} alt="" aria-hidden="true" className="h-4 w-4 rounded" /> : null}
          {isPending ? t('connecting') : `${t('connect')}: ${passkey ? t('passkeyWallet') : option.name}`}
        </button>
      ))}
      {noWallet ? <span className="text-xs text-slate-600">{t('noWalletHint')}</span> : null}
    </div>
  )
}
