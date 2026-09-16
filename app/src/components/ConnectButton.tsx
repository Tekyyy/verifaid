'use client'

import { useTranslations } from 'next-intl'
import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi'
import { chain } from '@/lib/config'
import { shorten } from '@/lib/format'
import { useMounted, useWrongChain } from '@/lib/hooks'

export function ConnectButton() {
  const t = useTranslations('common')
  const tErrors = useTranslations('errors')
  const mounted = useMounted()
  const { address, isConnected } = useAccount()
  const { connectors, connect, isPending } = useConnect()
  const { disconnect } = useDisconnect()
  const { switchChain } = useSwitchChain()
  const wrongChain = useWrongChain()

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
            onClick={() => switchChain({ chainId: chain.id })}
          >
            {tErrors('wrongNetwork', { chain: chain.name })}
          </button>
        ) : null}
        <span className="font-mono text-xs text-slate-700" title={address}>
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
      {connectors.map((connector) => (
        <button
          key={connector.uid}
          type="button"
          className={connector.id === 'coinbaseWalletSDK' ? 'btn-primary text-xs' : 'btn-secondary text-xs'}
          disabled={isPending}
          onClick={() => connect({ connector })}
        >
          {isPending ? t('connecting') : `${t('connect')}: ${connector.name}`}
        </button>
      ))}
    </div>
  )
}
